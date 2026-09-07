// Composition root for the Arena connector: one process, one open Borg, one
// poll loop.
//
// Why the composition lives in src/ and not in scripts/: tsconfig.json excludes
// "scripts" and sets rootDir to "./src", so nothing under scripts/ is covered by
// `npm run typecheck` and nothing in src/ may import it. The same reasoning is
// already written down in src/akuki/tenant.ts:3-6. scripts/akuki-arena.ts is
// therefore a launcher that only wires signals to `stop()`.
//
// SINGLE WRITER. This process holds the tenant directory open for its whole life.
// Nothing else may write it -- in particular not the generic memory sidecar, which
// `npm start` launches and which defaults to a different embedding model and
// dimension (scripts/memory-sidecar-main.ts:53-54, qwen3-embedding-8b/4096) than
// Akuki's frozen bge-m3/1024. Two writers on one tenant split the memory.
//
// SCHEDULERS ARE STARTED HERE, and that is the entire reason this process is
// long-lived. Borg.open builds the maintenance and autonomy schedulers but never
// starts them; a runtime has to (src/config/index.ts:684, 717-720). Without this
// the dream cycle never runs and Akuki's memory only ever accumulates.
//
// THE POLL LOOP NEVER OVERLAPS ITSELF: the next poll is scheduled after the
// previous one settles, not on a fixed interval. A turn can take longer than the
// poll interval, and two concurrent polls would both see the same unclaimed
// message.

import { Borg } from "../../index.js";
import { applyAkukiPredictionEnv } from "../prediction-config.js";
import { applyAkukiSeed } from "../seed/apply.js";
import { buildAkukiClients } from "../tenant.js";
import { BotArenaAdapter, type ArenaLog } from "./adapter.js";
import { BotArenaClient, type FetchImpl } from "./botarena-client.js";
import { loadArenaConfig, type ArenaConfig } from "./config.js";
import type { AkukiRunner } from "./contract.js";
import { PrincipalDirectory } from "./directory.js";
import { ArenaAkukiRunner } from "./runner.js";
import { ArenaStateStore } from "./state.js";

export type ArenaServiceOptions = {
  env?: NodeJS.ProcessEnv;
  /** Pre-loaded configuration; loaded from the environment when absent. */
  config?: ArenaConfig;
  /** Tenant directory. Falls back to AKUKI_DATA_DIR, which must be set explicitly. */
  dataDir?: string;
  /**
   * Poll and report, but run no turn and post nothing. Borg is not even opened,
   * so a dry run cannot touch the tenant or spend a token -- which is what makes
   * it a safe first contact with the real Arena.
   */
  dryRun?: boolean;
  log?: ArenaLog;
  /** Test seam: supply an already-open Borg instead of opening one. */
  openBorg?: () => Promise<Borg>;
  /** Test seam: replace the HTTP implementation so no test touches the network. */
  fetchImpl?: FetchImpl;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type ArenaService = {
  /** Resolves once the loop is idle, the schedulers are stopped and everything is closed. */
  stop(): Promise<void>;
  /** Exposed for tests and for the dry-run command; the loop calls it on a timer. */
  pollOnce(): Promise<void>;
};

const consoleLog: ArenaLog = (level, message) => {
  process.stderr.write(`[akuki-arena] ${level} ${message}\n`);
};

/** A runner that must never be reached. Used in dry-run, where no turn may happen. */
const refusingRunner: AkukiRunner = {
  handleMessage: () => {
    throw new Error("dry run must not reach the runner");
  },
};

export async function startArenaService(
  options: ArenaServiceOptions = {},
): Promise<ArenaService> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadArenaConfig(env);
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? consoleLog;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const state = new ArenaStateStore(config.stateDbPath);
  const client = new BotArenaClient({
    apiBase: config.apiBase,
    botToken: config.botToken,
    sessionCookie: config.sessionCookie,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const directory = new PrincipalDirectory(client);

  const borg = dryRun ? null : await openAkukiBorg(options, env);
  if (borg !== null) {
    // Re-applied at startup rather than per turn: temperament.yaml and
    // scaffolding.md are the source of truth in git, so the database should follow
    // them. Editing either therefore needs a restart of this service.
    applyAkukiSeed(borg);
  }

  const runner: AkukiRunner =
    borg === null ? refusingRunner : new ArenaAkukiRunner({ borg, state, log });

  const adapter = new BotArenaAdapter({
    transport: client,
    runner,
    state,
    directory,
    botId: config.botId,
    threadAllowlist: config.threadAllowlist,
    catchUpBacklog: config.catchUpBacklog,
    dryRun,
    log,
  });

  if (borg !== null) {
    startSchedulers(borg, log);
    // Before the first poll, never inside the loop -- see recoverAfterRestart.
    await adapter.recoverAfterRestart();
  }

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const scheduleNext = (): void => {
    if (stopping) {
      return;
    }
    timer = setTimeoutFn(() => {
      timer = null;
      inFlight = adapter
        .pollOnce()
        .catch((error) => {
          // A poll that throws past the adapter's own per-thread guard is still not
          // a reason to end the process: the next poll retries from durable state.
          log("error", `poll failed: ${describe(error)}`);
        })
        .finally(scheduleNext);
    }, config.pollIntervalMs);
  };

  log(
    "info",
    `started: dryRun=${dryRun} pollIntervalMs=${config.pollIntervalMs} ` +
      `allowlist=${config.threadAllowlist.size === 0 ? "<all seated threads>" : [...config.threadAllowlist].join(",")} ` +
      `catchUpBacklog=${config.catchUpBacklog} state=${config.stateDbPath}`,
  );
  scheduleNext();

  return {
    pollOnce: () => adapter.pollOnce(),
    stop: async () => {
      stopping = true;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      // Let a poll in progress finish: killing it mid-turn is exactly the crash
      // that produces an abandoned message.
      await inFlight;
      if (borg !== null) {
        await stopSchedulers(borg, log);
        await borg.close();
      }
      state.close();
      log("info", "stopped");
    },
  };
}

async function openAkukiBorg(
  options: ArenaServiceOptions,
  env: NodeJS.ProcessEnv,
): Promise<Borg> {
  if (options.openBorg !== undefined) {
    return options.openBorg();
  }
  const dataDir = options.dataDir ?? env.AKUKI_DATA_DIR?.trim();
  if (dataDir === undefined || dataDir === "") {
    throw new Error("AKUKI_DATA_DIR must be set explicitly before starting the Arena connector");
  }
  const clients = buildAkukiClients({ env });
  // Temperament-driven M2 prediction parameters have to be in the env before
  // Borg.open reads the config.
  applyAkukiPredictionEnv(env);
  return Borg.open({
    dataDir,
    env,
    llmClient: clients.llmClient,
    ...(clients.embeddingClient ? { embeddingClient: clients.embeddingClient } : {}),
  });
}

function startSchedulers(borg: Borg, log: ArenaLog): void {
  if (borg.maintenance.scheduler.isEnabled()) {
    borg.maintenance.scheduler.start();
    log("info", "maintenance scheduler started");
  } else {
    log("info", "maintenance scheduler disabled by configuration");
  }
  if (borg.autonomy.scheduler.isEnabled()) {
    borg.autonomy.scheduler.start();
    log("info", "autonomy scheduler started");
  } else {
    log("info", "autonomy scheduler disabled by configuration");
  }
  // borg.inbox.catchUp is deliberately NOT started: it drains messages queued via
  // enqueueMessage, and this connector runs turns directly. Starting it would give
  // the tenant a second path to a turn with nothing feeding it.
}

async function stopSchedulers(borg: Borg, log: ArenaLog): Promise<void> {
  const results = await Promise.allSettled([
    borg.maintenance.scheduler.stop({ graceful: true }),
    borg.autonomy.scheduler.stop({ graceful: true }),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      log("error", `scheduler stop failed: ${describe(result.reason)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// Adapter configuration, read from the environment.
//
// Every name carries the AKUKI_ARENA_ prefix so transport settings can never be
// confused with borg's own BORG_* configuration or with the AKUKI_* model and
// tenant variables. Mixing those up is how a deployment ends up pointing the
// wrong process at the wrong data directory.
//
// This file validates SHAPE only -- present, non-empty, positive -- and throws on
// a missing required value rather than defaulting. A silent default here would
// mean a connector that starts, looks healthy, and talks to nothing.

/** Deliberately not exported as a borg ConfigError: the transport owns its own failures. */
export class ArenaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaConfigError";
  }
}

export type ArenaConfig = {
  apiBase: string;
  botToken: string;
  sessionCookie: string;
  botId: string;
  stateDbPath: string;
  pollIntervalMs: number;
  threadAllowlist: ReadonlySet<string>;
  catchUpBacklog: boolean;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ArenaConfigError(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function optionalPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ArenaConfigError(`Env var ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function optionalBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function loadArenaConfig(env: NodeJS.ProcessEnv = process.env): ArenaConfig {
  const allowlist = optional(env, "AKUKI_ARENA_THREAD_ALLOWLIST", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  return {
    apiBase: required(env, "AKUKI_ARENA_API_BASE"),
    botToken: required(env, "AKUKI_ARENA_BOT_TOKEN"),
    sessionCookie: required(env, "AKUKI_ARENA_SESSION_COOKIE"),
    botId: required(env, "AKUKI_ARENA_BOT_ID"),
    // Never inside the tenant directory: that directory has exactly one writer,
    // borg, and dropping a second database in it invites confusion during a
    // migration or a backup.
    stateDbPath: optional(env, "AKUKI_ARENA_STATE_DB", "./.akuki-arena/state.db"),
    pollIntervalMs: optionalPositiveInt(env, "AKUKI_ARENA_POLL_INTERVAL_MS", 4_000),
    threadAllowlist: new Set(allowlist),
    // Defaults to false: on a first connection, replaying the thread's history
    // would have Akuki answer conversations that happened before he existed.
    catchUpBacklog: optionalBool(env, "AKUKI_ARENA_CATCH_UP_BACKLOG", false),
  };
}

import { pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import {
  Borg,
  DemoMessageConnector,
  loadConfig,
  type EmbeddingClient,
  type LLMClient,
  type MessageConnector,
} from "borg";

import {
  createDemoServerApp,
  DEMO_DEFAULT_AUDIENCE_LABEL,
  DEMO_DEFAULT_CREATOR_ENTITY_NAME,
  ensureDemoDefaultSession,
  runtimeConfigFromConfig,
  serializeStreamEntries,
  wireMaintenanceSchedulerLiveObserver,
} from "./app.js";
import { createLiveBridge } from "./live.js";
import { createResetBorgController, type BorgHandle } from "./reset.js";

// Generic hook: load an external connector plugin (e.g. a chat bridge living outside this
// repo) when EXTRA_CONNECTOR_MODULE is set. The plugin supplies outbound connectors to
// register at Borg.open and a start/stop lifecycle. The demo server stays agnostic to what
// the plugin does -- it never references any specific platform.
type ExternalConnectorPlugin = {
  outboundConnectors: MessageConnector[];
  /**
   * Called before loadConfig, so a plugin may put values in the environment that
   * the configuration then reads. Kept generic on purpose: the server does not know
   * or care which variables, only that a plugin may need to derive some from its own
   * source of truth rather than have them duplicated in a deployment's env file.
   */
  prepareEnv?(): void;
  /**
   * Model clients for Borg.open. A plugin whose entity must run on specific
   * providers supplies them here instead of the server hard-coding any; absent, the
   * server opens borg with its own defaults exactly as before.
   */
  llmClient?: LLMClient;
  embeddingClient?: EmbeddingClient;
  start(ctx: {
    getBorg: () => Borg;
    log?: (level: string, message: string) => void;
  }): Promise<void>;
  stop(): Promise<void>;
};

async function loadExternalConnectorPlugin(): Promise<ExternalConnectorPlugin | null> {
  const modulePath = process.env.EXTRA_CONNECTOR_MODULE;
  if (modulePath === undefined || modulePath.trim() === "") {
    return null;
  }
  const mod = (await import(pathToFileURL(modulePath).href)) as {
    createDemoPlugin?: () => ExternalConnectorPlugin;
  };
  if (typeof mod.createDemoPlugin !== "function") {
    throw new Error(`EXTRA_CONNECTOR_MODULE ${modulePath} does not export createDemoPlugin()`);
  }
  return mod.createDemoPlugin();
}

/**
 * Interface to accept connections on. @hono/node-server without a hostname accepts
 * on EVERY interface, which is fine on a laptop and is not fine on a host with a
 * public address: the only barrier left is whatever the cloud firewall happens to
 * allow, and this server exposes an entity's whole memory plus the ability to talk
 * to it. Set DEMO_HOST=127.0.0.1 and reach it through a tunnel or a private network.
 */
function readHost(): string | undefined {
  return readOptionalEnv("DEMO_HOST");
}

function readOptionalEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

function readPort(): number {
  const raw = process.env.PORT ?? "7740";
  const port = Number.parseInt(raw, 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }

  return port;
}

function readCorsOrigins(): string[] {
  const configured = process.env.DEMO_CORS_ORIGINS ?? process.env.DEMO_CORS_ORIGIN;

  if (configured === undefined || configured.trim().length === 0) {
    return ["http://localhost:5173"];
  }

  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

// Loaded before loadConfig, not after: prepareEnv exists so a plugin can set
// configuration-bearing environment variables, and loadConfig reads the environment
// once. Loading the plugin later would make that hook silently useless.
const connectorPlugin = await loadExternalConnectorPlugin();
connectorPlugin?.prepareEnv?.();

const configuredDataDir = process.env.BORG_DATA_DIR ?? ".borg-data/demo";
const demoConfig = loadConfig({ dataDir: configuredDataDir });
const dataDir = demoConfig.dataDir;
const demoCreatorEntityName = process.env.DEMO_CREATOR_ENTITY_NAME ?? undefined;
/**
 * Who the default session is with. Unset keeps the built-in demo fixture, which is a
 * person's name -- so a deployment that leaves it unset has its entity meeting, and
 * remembering, that fixture under a name nobody chose. Nothing in the UI names the
 * audience, so the only way to see the value is this line and the session row.
 */
const demoAudienceLabel = readOptionalEnv("DEMO_AUDIENCE_LABEL");
const port = readPort();
const live = createLiveBridge();

async function openDemoBorg(): Promise<Borg> {
  const borg = await Borg.open({
    config: demoConfig,
    tracer: live.tracer,
    onStreamAppend: live.onStreamAppend,
    outboundConnectors: [
      new DemoMessageConnector(),
      ...(connectorPlugin?.outboundConnectors ?? []),
    ],
    ...(connectorPlugin?.llmClient === undefined
      ? {}
      : { llmClient: connectorPlugin.llmClient }),
    ...(connectorPlugin?.embeddingClient === undefined
      ? {}
      : { embeddingClient: connectorPlugin.embeddingClient }),
  });
  ensureDemoDefaultSession(borg, { demoCreatorEntityName, demoAudienceLabel });
  return borg;
}

const borgHandle: BorgHandle = {
  current: await openDemoBorg(),
};
live.setStreamEntrySerializer((entries) => serializeStreamEntries(borgHandle.current, entries));
borgHandle.current.inbox.catchUp.start();
// Run as a full autonomous runtime: the scheduler fires self-initiated wakes on its triggers
// (expiring commitments, dormant open questions, due goals, executive focus). Without this
// call borg never self-initiates. Proactive outbound during those wakes is separately gated.
borgHandle.current.autonomy.scheduler.start();
wireMaintenanceSchedulerLiveObserver(borgHandle.current, live);
borgHandle.current.maintenance.scheduler.start();

if (connectorPlugin) {
  try {
    await connectorPlugin.start({
      getBorg: () => borgHandle.current,
      log: (level, message) => console.log(`[connector] ${level}: ${message}`),
    });
  } catch (error) {
    console.error("external connector plugin start failed; shutting down borg", error);
    await connectorPlugin.stop().catch(() => undefined);
    await borgHandle.current.close().catch(() => undefined);
    throw error;
  }
}

const resetBorg = createResetBorgController({ dataDir, live, borgHandle, openBorg: openDemoBorg });

const { app, injectWebSocket } = createDemoServerApp({
  borgHandle,
  live,
  corsOrigins: readCorsOrigins(),
  resetBorg,
  demoCreatorEntityName,
  demoAudienceLabel,
  runtimeConfig: runtimeConfigFromConfig(demoConfig),
});
const host = readHost();
const server = serve({
  fetch: app.fetch,
  port,
  // Omitted when unset, so the previous every-interface behaviour is unchanged for
  // anyone who does not ask for a different one.
  ...(host === undefined ? {} : { hostname: host }),
});

injectWebSocket(server);

console.log(
  `Borg demo server listening on http://${host ?? "localhost"}:${port}` +
    (host === undefined ? " (every interface)" : ""),
);
console.log(
  `default session audience: ${demoAudienceLabel ?? `${DEMO_DEFAULT_AUDIENCE_LABEL} (built-in default)`}; ` +
    `creator: ${demoCreatorEntityName ?? `${DEMO_DEFAULT_CREATOR_ENTITY_NAME} (built-in default)`}`,
);

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  live.broadcaster.closeAll();
  const serverWithConnectionCloser = server as typeof server & {
    closeAllConnections?: () => void;
  };
  await new Promise<void>((resolve) => {
    const forceCloseTimer = setTimeout(() => {
      serverWithConnectionCloser.closeAllConnections?.();
      resolve();
    }, 5_000);

    server.close(() => {
      clearTimeout(forceCloseTimer);
      resolve();
    });
  });
  if (connectorPlugin) {
    await connectorPlugin.stop().catch((error: unknown) => {
      console.error("external connector plugin stop failed", error);
    });
  }
  if (borgHandle.state !== "dead" && borgHandle.state !== "closing") {
    await borgHandle.current.autonomy.scheduler.stop().catch(() => undefined);
    await borgHandle.current.maintenance.scheduler.stop().catch(() => undefined);
    await borgHandle.current.close();
  }
};

function exitAfterShutdown(signal: NodeJS.Signals): void {
  void shutdown(signal)
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("Borg demo server shutdown failed", error);
      process.exit(1);
    });
}

process.once("SIGINT", (signal) => {
  exitAfterShutdown(signal);
});
process.once("SIGTERM", (signal) => {
  exitAfterShutdown(signal);
});

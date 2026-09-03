// Akuki: run one turn against the akuki tenant, reporting identity_events movement.
//
// M0 asks for "a turn passes and identity_events grows". Counting the changelog
// either side of the turn is the cheapest honest way to show that -- it reads the
// record borg already keeps rather than trusting the reply text.

import { Borg } from "../index.js";
import { parseSessionId } from "../util/ids.js";
import { applyAkukiSeed } from "./seed/apply.js";
import { applyAkukiPredictionEnv } from "./prediction-config.js";
import { buildAkukiClients, type AkukiEmbeddingMode } from "./tenant.js";
import { createAkukiTokenUsageCollector, type AkukiTokenUsageReport } from "./token-usage.js";

export type RunAkukiTurnOptions = {
  dataDir: string;
  message: string;
  sessionId: string;
  audience?: string;
  embeddings?: AkukiEmbeddingMode;
  env?: NodeJS.ProcessEnv;
};

export type RunAkukiTurnResult = {
  emitted: boolean;
  response: string;
  emissionKind: string;
  identityEventsBefore: number;
  identityEventsAfter: number;
  plumbingOnly: boolean;
  tokenUsage: AkukiTokenUsageReport;
};

// listEvents has no time range and defaults to limit 50
// (src/memory/identity/repository.ts:148), so ask for a lot and count what comes back.
const EVENT_SCAN_LIMIT = 5_000;

export async function runAkukiTurn(options: RunAkukiTurnOptions): Promise<RunAkukiTurnResult> {
  const env = options.env ?? process.env;
  const usage = createAkukiTokenUsageCollector();
  const clients = buildAkukiClients({
    env,
    embeddings: options.embeddings,
    usageSink: usage.usageSink,
  });

  // Push temperament-driven M2 prediction params into the env Borg.open resolves.
  applyAkukiPredictionEnv(env);

  const borg = await Borg.open({
    dataDir: options.dataDir,
    env,
    llmClient: clients.llmClient,
    // Only set when the fake path is in use; otherwise config.json decides.
    ...(clients.embeddingClient ? { embeddingClient: clients.embeddingClient } : {}),
  });

  try {
    // The seed is re-applied every turn on purpose: scaffolding.md and
    // temperament.yaml are the source of truth in git, so the database should
    // follow them rather than drift from them. applyAkukiSeed compares before
    // writing, so an unchanged seed costs two file reads and touches nothing --
    // no updated_at churn, no identity events that mean nothing.
    //
    // NOT wired into BorgPool's initializeBeing: that hook runs for EVERY tenant
    // the sidecar opens, including Sol's. Calling this there unguarded would write
    // Akuki's persona into another being's database. If it ever goes there, it
    // must be gated on tenantId === "akuki".
    applyAkukiSeed(borg);

    const before = borg.identity.listEvents({ limit: EVENT_SCAN_LIMIT }).length;

    const result = await borg.turn({
      userMessage: options.message,
      sessionId: parseSessionId(options.sessionId),
      audience: options.audience,
    });

    const after = borg.identity.listEvents({ limit: EVENT_SCAN_LIMIT }).length;

    return {
      emitted: result.emitted,
      response: result.response,
      emissionKind: result.emission.kind,
      identityEventsBefore: before,
      identityEventsAfter: after,
      plumbingOnly: clients.plumbingOnly,
      tokenUsage: usage.report(),
    };
  } finally {
    await borg.close();
  }
}

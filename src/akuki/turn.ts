// Akuki: run one turn against the akuki tenant, reporting identity_events movement.
//
// M0 asks for "a turn passes and identity_events grows". Counting the changelog
// either side of the turn is the cheapest honest way to show that -- it reads the
// record borg already keeps rather than trusting the reply text.

import { Borg } from "../index.js";
import { parseSessionId } from "../util/ids.js";
import { buildAkukiClients, type AkukiEmbeddingMode } from "./tenant.js";

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
};

// listEvents has no time range and defaults to limit 50
// (src/memory/identity/repository.ts:148), so ask for a lot and count what comes back.
const EVENT_SCAN_LIMIT = 5_000;

export async function runAkukiTurn(options: RunAkukiTurnOptions): Promise<RunAkukiTurnResult> {
  const env = options.env ?? process.env;
  const clients = buildAkukiClients({ env, embeddings: options.embeddings });

  const borg = await Borg.open({
    dataDir: options.dataDir,
    env,
    llmClient: clients.llmClient,
    // Only set when the fake path is in use; otherwise config.json decides.
    ...(clients.embeddingClient ? { embeddingClient: clients.embeddingClient } : {}),
  });

  try {
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
    };
  } finally {
    await borg.close();
  }
}

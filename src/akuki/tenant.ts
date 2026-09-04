// Akuki: client wiring for the `akuki` tenant.
//
// Kept out of scripts/ on purpose: tsconfig.json includes only "src/**/*" and
// explicitly excludes "scripts", and no other tsconfig project picks up a new
// top-level directory -- so anything written outside src/ would never be
// typechecked by `npm run typecheck`.

import {
  FakeEmbeddingClient,
  type EmbeddingClient,
} from "../embeddings/index.js";
import type { LLMClient, TokenUsageSink } from "../llm/index.js";
import { AkukiLLMRouter } from "./llm-router.js";
import {
  isAkukiAnthropicOnly,
  validateAkukiAnthropicOnlyModels,
  validateAkukiSmokeEmbeddings,
} from "./smoke-config.js";

// There is deliberately no default endpoint model and no default base URL.
// Both used to point at Kratos; that route was abandoned on 2026-09-02 and Akuki
// runs on Anthropic models only. A default would silently aim the volume roles at
// an endpoint nobody chose, which is the worst kind of configuration bug: it looks
// configured. A non-Anthropic role now requires AKUKI_ENDPOINT_MODEL and
// AKUKI_LLM_BASE_URL to be set explicitly, and a missing one raises a ConfigError
// from OpenAICompatibleLLMClient at the first non-claude call rather than falling
// back anywhere.

// The volume roles. `cognition` is deliberately absent: it is Akuki's actual
// thinking and is set separately, so that pointing the cheap roles at an endpoint
// can never silently drag cognition along with them.
export const AKUKI_VOLUME_MODEL_SLOTS = [
  "BORG_MODEL_EXTRACTION",
  "BORG_MODEL_RECALL_EXPANSION",
  "BORG_MODEL_BACKGROUND",
  "BORG_MODEL_CREATOR_DIRECTIVE",
] as const;

export type AkukiEmbeddingMode = "endpoint" | "fake";

export type AkukiClientOptions = {
  env?: NodeJS.ProcessEnv;
  embeddings?: AkukiEmbeddingMode;
  // Every call reports the model the provider actually used, plus real cache
  // counters. A measurement must record what answered, not what was asked for:
  // an undated alias can start resolving to a different snapshot and silently
  // invalidate any comparison made across it.
  usageSink?: TokenUsageSink;
};

export type AkukiClients = {
  llmClient: LLMClient;
  // undefined => let Borg.open build it from the tenant's config.json via
  // createEmbeddingClient (src/borg/clients.ts), which ALREADY wraps it in
  // createCachingEmbeddingClient. Injecting our own here would duplicate the
  // embedding model/dims in code and let them silently drift from config.json.
  embeddingClient?: EmbeddingClient;
  // True when nothing here can produce a real measurement -- see the warning in
  // buildAkukiClients.
  plumbingOnly: boolean;
};

/**
 * Assign the model slots borg reads at Borg.open. Mirrors the memory sidecar
 * (scripts/memory-sidecar-main.ts), which does the same `??=` trick, but keeps
 * cognition separate.
 */
export function applyAkukiModelSlots(env: NodeJS.ProcessEnv, endpointModel: string): void {
  for (const slot of AKUKI_VOLUME_MODEL_SLOTS) {
    env[slot] ??= endpointModel;
  }
}

export function buildAkukiClients(options: AkukiClientOptions = {}): AkukiClients {
  const env = options.env ?? process.env;
  const mode: AkukiEmbeddingMode = options.embeddings ?? "endpoint";

  const anthropicOnly = isAkukiAnthropicOnly(env);

  const baseUrl = env.AKUKI_LLM_BASE_URL ?? "";
  const endpointApiKey = env.AKUKI_LLM_API_KEY ?? "";
  const anthropicApiKey = env.AKUKI_ANTHROPIC_API_KEY ?? "";

  // Only an explicitly set AKUKI_ENDPOINT_MODEL may populate the volume roles,
  // in every mode. Leaving them unset is what makes the Anthropic-only validation
  // below able to complain about a genuinely missing role.
  const endpointModel = env.AKUKI_ENDPOINT_MODEL?.trim();
  if (endpointModel) {
    applyAkukiModelSlots(env, endpointModel);
  }

  if (anthropicOnly) {
    validateAkukiAnthropicOnlyModels(env);
    validateAkukiSmokeEmbeddings(env, mode);
  }

  const llmClient = new AkukiLLMRouter({
    anthropicApiKey,
    anthropicEnv: env,
    openAiBaseUrl: baseUrl,
    // Left blank when unset so the router still constructs; the underlying client
    // raises a clear ConfigError only if a non-Anthropic model is actually called.
    openAiApiKey: endpointApiKey,
    requestTimeoutMs: Number(env.AKUKI_LLM_TIMEOUT_MS ?? 120_000),
    ...(options.usageSink === undefined ? {} : { usageSink: options.usageSink }),
  });

  if (mode === "fake") {
    // Deterministic hash-seeded vectors with NO semantic signal. Retrieval,
    // consolidation similarity and anything keyed on embedding distance become
    // meaningless -- fine for proving the pipeline is wired, never for a measurement.
    return {
      llmClient,
      embeddingClient: new FakeEmbeddingClient(32),
      plumbingOnly: true,
    };
  }

  return { llmClient, plumbingOnly: false };
}

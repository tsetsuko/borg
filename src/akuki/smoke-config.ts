import { isAnthropicModel } from "./llm-router.js";

export const AKUKI_MODEL_SLOTS = [
  "BORG_MODEL_COGNITION",
  "BORG_MODEL_EXTRACTION",
  "BORG_MODEL_RECALL_EXPANSION",
  "BORG_MODEL_BACKGROUND",
  "BORG_MODEL_CREATOR_DIRECTIVE",
] as const;

const REQUIRED_EMBEDDING_SETTINGS = [
  "BORG_EMBEDDING_BASE_URL",
  "BORG_EMBEDDING_MODEL",
  "BORG_EMBEDDING_DIMS",
] as const;

export function isAkukiAnthropicOnly(env: NodeJS.ProcessEnv): boolean {
  return env.AKUKI_ANTHROPIC_ONLY === "1";
}

export function requireAkukiDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = env.AKUKI_DATA_DIR?.trim();
  if (!dataDir) {
    throw new Error(
      "AKUKI_DATA_DIR must be set explicitly (for example /var/lib/akuki) before running an Akuki command",
    );
  }
  return dataDir;
}

export function validateAkukiAnthropicOnlyModels(env: NodeJS.ProcessEnv): void {
  if (env.ANTHROPIC_BASE_URL?.trim()) {
    throw new Error(
      "AKUKI_ANTHROPIC_ONLY=1 requires direct Anthropic access; unset ANTHROPIC_BASE_URL",
    );
  }

  const missing = AKUKI_MODEL_SLOTS.filter((slot) => !env[slot]?.trim());
  if (missing.length > 0) {
    throw new Error(`AKUKI_ANTHROPIC_ONLY=1 requires model roles: ${missing.join(", ")}`);
  }

  const nonAnthropic = AKUKI_MODEL_SLOTS.flatMap((slot) => {
    const model = env[slot]?.trim();
    return model !== undefined && !isAnthropicModel(model) ? [`${slot}=${model}`] : [];
  });
  if (nonAnthropic.length > 0) {
    throw new Error(
      `AKUKI_ANTHROPIC_ONLY=1 rejects non-Anthropic model roles: ${nonAnthropic.join(", ")}`,
    );
  }
}

export function validateAkukiSmokeEmbeddings(
  env: NodeJS.ProcessEnv,
  embeddingMode: "endpoint" | "fake",
): void {
  if (embeddingMode === "fake") {
    throw new Error(
      "AKUKI_ANTHROPIC_ONLY=1 requires endpoint embeddings; fake embeddings are unsafe",
    );
  }

  const missing = REQUIRED_EMBEDDING_SETTINGS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`AKUKI_ANTHROPIC_ONLY=1 requires embedding settings: ${missing.join(", ")}`);
  }

  const dimensions = Number(env.BORG_EMBEDDING_DIMS);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("BORG_EMBEDDING_DIMS must be a positive integer in Anthropic-only mode");
  }
}

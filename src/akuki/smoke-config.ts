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

const FORBIDDEN_KRATOS_HOSTS = new Set([
  "inference.kratos.p4.int",
  "inference.kratos.omc.hdp.it.p4",
]);

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
  validateAkukiAnthropicAuth(env);

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

function validateAkukiAnthropicAuth(env: NodeJS.ProcessEnv): void {
  if (env.AKUKI_ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "AKUKI_ANTHROPIC_ONLY=1 does not accept AKUKI_ANTHROPIC_API_KEY; use ANTHROPIC_API_KEY in direct mode",
    );
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? "";
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() ?? "";
  const proxyEnabled = env.AKUKI_ANTHROPIC_PROXY === "1";

  if (!proxyEnabled) {
    if (baseUrl !== "") {
      throw new Error(
        "ANTHROPIC_BASE_URL requires explicit proxy approval: set AKUKI_ANTHROPIC_PROXY=1",
      );
    }
    if (apiKey === "") {
      throw new Error("Akuki Anthropic direct mode requires a non-empty ANTHROPIC_API_KEY");
    }
    return;
  }

  if (apiKey !== "") {
    throw new Error(
      "Akuki Anthropic proxy mode rejects ANTHROPIC_API_KEY; use ANTHROPIC_AUTH_TOKEN only",
    );
  }
  if (authToken === "") {
    throw new Error("Akuki Anthropic proxy mode requires a non-empty ANTHROPIC_AUTH_TOKEN");
  }
  if (baseUrl === "") {
    throw new Error("Akuki Anthropic proxy mode requires a non-empty ANTHROPIC_BASE_URL");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("ANTHROPIC_BASE_URL must be a valid absolute HTTP(S) URL");
  }

  if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.protocol !== "http:") {
    throw new Error("ANTHROPIC_BASE_URL must be a valid absolute HTTP(S) URL");
  }

  const hostname = parsedBaseUrl.hostname.toLowerCase().replace(/\.+$/u, "");
  if (FORBIDDEN_KRATOS_HOSTS.has(hostname)) {
    throw new Error(`ANTHROPIC_BASE_URL host ${hostname} is forbidden for the Akuki smoke test`);
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

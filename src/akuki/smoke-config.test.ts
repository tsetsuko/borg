import { describe, expect, it } from "vitest";
import {
  AKUKI_MODEL_SLOTS,
  requireAkukiDataDir,
  validateAkukiAnthropicOnlyModels,
  validateAkukiSmokeEmbeddings,
} from "./smoke-config.js";

function anthropicModels(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    AKUKI_MODEL_SLOTS.map((slot) => [slot, `claude-${slot.toLowerCase()}`]),
  );
}

describe("Akuki Anthropic-only configuration", () => {
  it("accepts all model roles when each is Anthropic", () => {
    expect(() => validateAkukiAnthropicOnlyModels(anthropicModels())).not.toThrow();
  });

  it("rejects a non-Anthropic model role", () => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        BORG_MODEL_BACKGROUND: "generative-apis/qwen",
      }),
    ).toThrow(/BORG_MODEL_BACKGROUND=generative-apis\/qwen/u);
  });

  it("rejects a custom Anthropic base URL so the smoke test is direct", () => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      }),
    ).toThrow(/unset ANTHROPIC_BASE_URL/u);
  });

  it("rejects a missing model role", () => {
    const env = anthropicModels();
    delete env.BORG_MODEL_COGNITION;

    expect(() => validateAkukiAnthropicOnlyModels(env)).toThrow(/BORG_MODEL_COGNITION/u);
  });

  it("requires an explicit data directory", () => {
    expect(() => requireAkukiDataDir({})).toThrow(/AKUKI_DATA_DIR/u);
    expect(requireAkukiDataDir({ AKUKI_DATA_DIR: " /var/lib/akuki " })).toBe("/var/lib/akuki");
  });

  it("requires explicit endpoint embedding settings", () => {
    expect(() => validateAkukiSmokeEmbeddings({}, "endpoint")).toThrow(
      /BORG_EMBEDDING_BASE_URL.*BORG_EMBEDDING_MODEL.*BORG_EMBEDDING_DIMS/u,
    );
  });

  it("rejects fake embeddings and invalid dimensions", () => {
    const env = {
      BORG_EMBEDDING_BASE_URL: "http://127.0.0.1:11434/v1",
      BORG_EMBEDDING_MODEL: "bge-m3",
      BORG_EMBEDDING_DIMS: "1024",
    };
    expect(() => validateAkukiSmokeEmbeddings(env, "fake")).toThrow(/fake embeddings/u);
    expect(() =>
      validateAkukiSmokeEmbeddings({ ...env, BORG_EMBEDDING_DIMS: "1024.5" }, "endpoint"),
    ).toThrow(/positive integer/u);
  });

  it("accepts explicit endpoint embedding settings", () => {
    expect(() =>
      validateAkukiSmokeEmbeddings(
        {
          BORG_EMBEDDING_BASE_URL: "http://127.0.0.1:11434/v1",
          BORG_EMBEDDING_MODEL: "bge-m3",
          BORG_EMBEDDING_DIMS: "1024",
        },
        "endpoint",
      ),
    ).not.toThrow();
  });
});

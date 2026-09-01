import { describe, expect, it } from "vitest";
import {
  AKUKI_MODEL_SLOTS,
  requireAkukiDataDir,
  validateAkukiAnthropicOnlyModels,
  validateAkukiSmokeEmbeddings,
} from "./smoke-config.js";

function anthropicModels(): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_API_KEY: "direct-secret",
    ...Object.fromEntries(AKUKI_MODEL_SLOTS.map((slot) => [slot, `claude-${slot.toLowerCase()}`])),
  };
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

  it("accepts explicit proxy auth", () => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: "proxy-secret",
        ANTHROPIC_BASE_URL: "https://proxy.example/v1",
        AKUKI_ANTHROPIC_PROXY: "1",
      }),
    ).not.toThrow();
  });

  it("requires explicit operational approval for a custom Anthropic base URL", () => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      }),
    ).toThrow(/AKUKI_ANTHROPIC_PROXY=1/u);
  });

  it("requires the credential for the selected auth mode", () => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_API_KEY: " ",
      }),
    ).toThrow(/non-empty ANTHROPIC_API_KEY/u);

    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_BASE_URL: "https://proxy.example",
        AKUKI_ANTHROPIC_PROXY: "1",
      }),
    ).toThrow(/non-empty ANTHROPIC_AUTH_TOKEN/u);

    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: "proxy-secret",
        AKUKI_ANTHROPIC_PROXY: "1",
      }),
    ).toThrow(/non-empty ANTHROPIC_BASE_URL/u);
  });

  it("rejects the legacy Akuki key override in Anthropic-only mode", () => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        AKUKI_ANTHROPIC_API_KEY: "legacy-secret",
      }),
    ).toThrow(/does not accept AKUKI_ANTHROPIC_API_KEY/u);
  });

  it("rejects an API key mixed into proxy mode without exposing the token", () => {
    const token = "must-not-appear-in-errors";
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_BASE_URL: "https://proxy.example",
        AKUKI_ANTHROPIC_PROXY: "1",
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(token),
      }),
    );
  });

  it.each(["proxy.example/v1", "/v1/messages", "ftp://proxy.example/v1"])(
    "rejects invalid proxy base URL %s",
    (baseUrl) => {
      expect(() =>
        validateAkukiAnthropicOnlyModels({
          ...anthropicModels(),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: "proxy-secret",
          ANTHROPIC_BASE_URL: baseUrl,
          AKUKI_ANTHROPIC_PROXY: "1",
        }),
      ).toThrow(/valid absolute HTTP\(S\) URL/u);
    },
  );

  it.each([
    "https://inference.kratos.p4.int/v1",
    "https://inference.kratos.omc.hdp.it.p4/v1",
    "https://INFERENCE.KRATOS.P4.INT./v1",
  ])("rejects known Kratos proxy host %s", (baseUrl) => {
    expect(() =>
      validateAkukiAnthropicOnlyModels({
        ...anthropicModels(),
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: "proxy-secret",
        ANTHROPIC_BASE_URL: baseUrl,
        AKUKI_ANTHROPIC_PROXY: "1",
      }),
    ).toThrow(/is forbidden/u);
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

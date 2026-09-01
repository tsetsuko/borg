import { describe, expect, it } from "vitest";
import { buildAkukiClients } from "./tenant.js";

const embeddingEnv = {
  BORG_EMBEDDING_BASE_URL: "http://127.0.0.1:11434/v1",
  BORG_EMBEDDING_MODEL: "bge-m3",
  BORG_EMBEDDING_DIMS: "1024",
};

describe("buildAkukiClients Anthropic-only ordering", () => {
  it("validates the effective volume slots populated by AKUKI_ENDPOINT_MODEL", () => {
    const env: NodeJS.ProcessEnv = {
      ...embeddingEnv,
      AKUKI_ANTHROPIC_ONLY: "1",
      AKUKI_ENDPOINT_MODEL: "claude-volume",
      BORG_MODEL_COGNITION: "claude-cognition",
    };

    expect(() => buildAkukiClients({ env })).not.toThrow();
    expect(env.BORG_MODEL_EXTRACTION).toBe("claude-volume");
    expect(env.BORG_MODEL_RECALL_EXPANSION).toBe("claude-volume");
    expect(env.BORG_MODEL_BACKGROUND).toBe("claude-volume");
    expect(env.BORG_MODEL_CREATOR_DIRECTIVE).toBe("claude-volume");
  });

  it("does not fill missing smoke roles from the Kratos default", () => {
    expect(() =>
      buildAkukiClients({
        env: {
          ...embeddingEnv,
          AKUKI_ANTHROPIC_ONLY: "1",
          BORG_MODEL_COGNITION: "claude-cognition",
        },
      }),
    ).toThrow(/BORG_MODEL_EXTRACTION/u);
  });
});

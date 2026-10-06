import { afterEach, describe, expect, it } from "vitest";

import {
  FakeLLMClient,
  ManualClock,
  createTestConfig,
  Borg,
  ScriptedEmbeddingClient,
  createEmitAnswerResponse,
  createEmptyReflectionResponse,
  join,
  mkdtempSync,
  rmSync,
  tmpdir,
} from "./test-helpers.js";

// A transport posts the reply from onReplyPersisted instead of waiting for the
// whole turn. These tests pin what that relies on: the callback carries the
// final reply text, and it fires before the post-reply work starts.

async function openBorg(tempDir: string, llmClient: FakeLLMClient) {
  return Borg.open({
    config: createTestConfig({
      dataDir: tempDir,
      perception: {
        llmEnabled: false,
      },
      embedding: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "test",
        model: "fake-embed",
        dims: 4,
      },
      anthropic: {
        auth: "api-key",
        apiKey: "test",
        models: {
          cognition: "sonnet",
          background: "haiku",
          extraction: "haiku",
        },
      },
    }),
    clock: new ManualClock(1_000),
    embeddingDimensions: 4,
    embeddingClient: new ScriptedEmbeddingClient(),
    llmClient,
    liveExtraction: false,
  });
}

describe("onReplyPersisted", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("hands out the final reply before reflection runs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "borg-"));
    tempDirs.push(tempDir);
    const llmClient = new FakeLLMClient({
      responses: [createEmitAnswerResponse("Try the rollback plan."), createEmptyReflectionResponse()],
    });
    const borg = await openBorg(tempDir, llmClient);
    const delivered: Array<{ text: string; llmCallsSoFar: number }> = [];

    try {
      const result = await borg.turn({
        userMessage: "Atlas deploy failed again.",
        onReplyPersisted: async (reply) => {
          delivered.push({ text: reply.text, llmCallsSoFar: llmClient.requests.length });
        },
      });

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).toBe(result.response);
      expect(result.response).toBe("Try the rollback plan.");
      // The post-reply work still made model calls, and made them after the hand-out.
      expect(delivered[0]?.llmCallsSoFar).toBeLessThan(llmClient.requests.length);
    } finally {
      await borg.close();
    }
  });

  it("does not fail the turn when the callback throws", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "borg-"));
    tempDirs.push(tempDir);
    const borg = await openBorg(
      tempDir,
      new FakeLLMClient({
        responses: [createEmitAnswerResponse("Noted."), createEmptyReflectionResponse()],
      }),
    );

    try {
      const result = await borg.turn({
        userMessage: "Quick check.",
        onReplyPersisted: async () => {
          throw new Error("transport down");
        },
      });

      expect(result.emitted).toBe(true);
      expect(result.response).toBe("Noted.");
    } finally {
      await borg.close();
    }
  });
});

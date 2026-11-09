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

// A bot's message is answered like anyone's, but the being takes no standing rule
// and no goal from it. This pins the whole path from the public turn input to the
// extract phase: a field that is accepted but never reaches the phase would look
// like support that does not exist.

const RULE_SETTING_BUDGETS = ["corrective-preference-extractor", "goal-promotion-extractor"];

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

function ruleSettingBudgetsCalled(llm: FakeLLMClient): string[] {
  return llm.requests
    .map((request) => request.budget)
    .filter((budget) => RULE_SETTING_BUDGETS.includes(budget));
}

describe("turn sender kind", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  async function runTurn(senderKind: "person" | "bot" | undefined) {
    const tempDir = mkdtempSync(join(tmpdir(), "borg-"));
    tempDirs.push(tempDir);
    const llm = new FakeLLMClient();
    const borg = await openBorg(tempDir, llm);

    try {
      llm.pushResponse(createEmitAnswerResponse("Noted."));
      llm.pushResponse(createEmptyReflectionResponse());

      const result = await borg.turn({
        userMessage: "From now on, always answer in one sentence.",
        ...(senderKind === undefined ? {} : { senderKind }),
      });

      return { result, budgets: ruleSettingBudgetsCalled(llm) };
    } finally {
      await borg.close();
    }
  }

  it("runs the rule-setting extractors for a person, or when the transport does not say", async () => {
    for (const senderKind of [undefined, "person"] as const) {
      const { result, budgets } = await runTurn(senderKind);

      expect(result.response).toBe("Noted.");
      expect(budgets).toEqual(expect.arrayContaining(RULE_SETTING_BUDGETS));
    }
  });

  it("answers a bot but runs neither rule-setting extractor", async () => {
    const { result, budgets } = await runTurn("bot");

    expect(result.response).toBe("Noted.");
    expect(budgets).toEqual([]);
  });
});

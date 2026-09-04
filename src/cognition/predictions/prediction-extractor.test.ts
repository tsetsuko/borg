import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LLMCompleteResult } from "../../llm/index.js";
import { FakeLLMClient } from "../../llm/test-support/fake-client.js";
import { predictionMemoryDisclosureLabel } from "../../memory/common/disclosure-serializers.js";
import { PredictionRepository, predictionMigrations } from "../../memory/predictions/index.js";
import { openDatabase } from "../../storage/sqlite/index.js";
import { ManualClock } from "../../util/clock.js";
import { createPredictionEventId, createSessionId } from "../../util/ids.js";
import { PredictionExtractor } from "./prediction-extractor.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function openRepository(): PredictionRepository {
  const tempDir = mkdtempSync(join(tmpdir(), "borg-pred-extractor-"));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, "predictions.db"), { migrations: predictionMigrations });
  return new PredictionRepository({ db, clock: new ManualClock(1_000) });
}

function toolResponse(input: unknown): LLMCompleteResult {
  return {
    text: "",
    input_tokens: 6,
    output_tokens: 3,
    stop_reason: "tool_use",
    tool_calls: [{ id: "toolu_pred", name: "EmitPredictionUpdate", input: input as object }],
  };
}

describe("PredictionExtractor", () => {
  it("reconciles a surfaced open expectation and records a new one", async () => {
    const repository = openRepository();
    const sessionId = createSessionId();
    const open = repository.recordExpectation({
      sessionId,
      turnId: "turn-1",
      content: "Tomek will return to the migration ordering.",
    });

    const llmClient = new FakeLLMClient({
      responses: [
        toolResponse({
          reconciliations: [
            {
              prediction_id: open.id,
              outcome: "He dropped it and moved on.",
              error_magnitude: 0.6,
            },
          ],
          new_expectations: [{ content: "Jacek will check the snapshot order next." }],
        }),
      ],
    });

    const extractor = new PredictionExtractor({
      llmClient,
      model: "test-model",
      predictionRepository: repository,
      turnId: "turn-2",
      sessionId,
    });

    const result = await extractor.extract({
      userMessage: "actually let's leave migrations, I'll look at snapshots",
      recentHistory: [],
      openExpectations: [
        {
          prediction_id: open.id,
          content: open.content,
          about: null,
          disclosureLabel: predictionMemoryDisclosureLabel(),
        },
      ],
      sessionId,
      turnId: "turn-2",
    });

    expect(result.reconciledPredictionIds).toEqual([open.id]);
    expect(result.createdExpectationIds).toHaveLength(1);

    // The reconciled expectation is closed; only the freshly recorded one stays open.
    const stillOpen = repository.listOpen({ limit: 10 });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.id).toBe(result.createdExpectationIds[0]);

    const reconciliations = repository.listReconciliationsSince({ sinceMs: 0, limit: 10 });
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]!.error_magnitude).toBe(0.6);
    expect(reconciliations[0]!.prediction_id).toBe(open.id);
  });

  it("labels every open expectation it shows the model as self-private", async () => {
    const repository = openRepository();
    const sessionId = createSessionId();
    const open = repository.recordExpectation({
      sessionId,
      turnId: "turn-1",
      content: "Jacek will ask about migrations next.",
      aboutEntityId: null,
    });

    const llmClient = new FakeLLMClient({
      responses: [toolResponse({ reconciliations: [], new_expectations: [] })],
    });

    const extractor = new PredictionExtractor({
      llmClient,
      model: "test-model",
      predictionRepository: repository,
      turnId: "turn-2",
      sessionId,
    });

    await extractor.extract({
      userMessage: "morning",
      recentHistory: [],
      openExpectations: [
        {
          prediction_id: open.id,
          content: open.content,
          about: null,
          disclosureLabel: predictionMemoryDisclosureLabel(),
        },
      ],
      sessionId,
      turnId: "turn-2",
    });

    const payload = JSON.parse(String(llmClient.requests[0]!.messages[0]!.content)) as {
      open_expectations: { content: string; disclosure: string; disclosure_label: unknown }[];
    };

    // The row reaches the model with its label attached, not stripped of it.
    expect(payload.open_expectations).toHaveLength(1);
    expect(payload.open_expectations[0]!.content).toBe(open.content);
    expect(payload.open_expectations[0]!.disclosure).toContain("self_private");
    expect(payload.open_expectations[0]!.disclosure_label).toMatchObject({
      disclosure_class: "self_private",
      origin_audience_entity_ids: [],
      private_to_entity_ids: [],
    });
  });

  it("drops a reconciliation for a prediction id that was not surfaced as open", async () => {
    const repository = openRepository();
    const sessionId = createSessionId();

    const llmClient = new FakeLLMClient({
      responses: [
        toolResponse({
          reconciliations: [
            {
              prediction_id: createPredictionEventId(),
              outcome: "hallucinated",
              error_magnitude: 0.9,
            },
          ],
          new_expectations: [],
        }),
      ],
    });

    const extractor = new PredictionExtractor({
      llmClient,
      model: "test-model",
      predictionRepository: repository,
      turnId: "turn-2",
      sessionId,
    });

    const result = await extractor.extract({
      userMessage: "hi",
      recentHistory: [],
      openExpectations: [],
      sessionId,
      turnId: "turn-2",
    });

    expect(result.reconciledPredictionIds).toEqual([]);
    expect(repository.listReconciliationsSince({ sinceMs: 0, limit: 10 })).toHaveLength(0);
  });

  it("no-ops without an llm client", async () => {
    const repository = openRepository();
    const extractor = new PredictionExtractor({ predictionRepository: repository });

    const result = await extractor.extract({
      userMessage: "hi",
      recentHistory: [],
      openExpectations: [],
      sessionId: createSessionId(),
      turnId: "turn-1",
    });

    expect(result.reconciledPredictionIds).toEqual([]);
    expect(result.createdExpectationIds).toEqual([]);
  });
});

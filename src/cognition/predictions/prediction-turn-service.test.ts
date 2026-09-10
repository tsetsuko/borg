import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LLMCompleteResult } from "../../llm/index.js";
import { FakeLLMClient } from "../../llm/test-support/fake-client.js";
import { PredictionRepository, predictionMigrations } from "../../memory/predictions/index.js";
import { openDatabase } from "../../storage/sqlite/index.js";
import { NOOP_TRACER } from "../../tracing/tracer.js";
import { ManualClock } from "../../util/clock.js";
import { createSessionId } from "../../util/ids.js";
import { PredictionTurnService } from "./prediction-turn-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function openRepository(clock: ManualClock): PredictionRepository {
  const tempDir = mkdtempSync(join(tmpdir(), "borg-pred-turn-service-"));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, "predictions.db"), { migrations: predictionMigrations });
  return new PredictionRepository({ db, clock });
}

function quietResponse(): LLMCompleteResult {
  return {
    text: "",
    input_tokens: 4,
    output_tokens: 2,
    stop_reason: "tool_use",
    tool_calls: [
      {
        id: "toolu_pred",
        name: "EmitPredictionUpdate",
        input: { reconciliations: [], new_expectations: [] },
      },
    ],
  };
}

function buildService(repository: PredictionRepository, clock: ManualClock): PredictionTurnService {
  return new PredictionTurnService({
    model: "test-model",
    predictionRepository: repository,
    episodicRepository: {
      findBySourceStreamIdsContaining: async () => [],
      updateSignificance: async () => null,
    },
    entityRepository: { findByName: () => null },
    params: {
      surpriseWeight: 1,
      curiosityGain: 1,
      targetErrorBand: [0.3, 0.7],
      attachmentMemoryWeight: 1,
      significanceStep: 0.05,
    },
    attachmentFigureName: null,
    clock,
    tracer: NOOP_TRACER,
  });
}

function openExpectationsFromRequest(llmClient: FakeLLMClient): {
  formed_turns_ago: number | null;
  formed_minutes_ago: number | null;
}[] {
  const payload = JSON.parse(String(llmClient.requests[0]!.messages[0]!.content)) as {
    open_expectations: { formed_turns_ago: number | null; formed_minutes_ago: number | null }[];
  };

  return payload.open_expectations;
}

describe("PredictionTurnService open-expectation age", () => {
  it("reports the age in turns and in minutes", async () => {
    const clock = new ManualClock(0);
    const repository = openRepository(clock);
    const sessionId = createSessionId();

    repository.recordExpectation({
      sessionId,
      turnId: "turn-4",
      content: "Sol will keep coaching rather than trading warnings.",
      formedTurnCounter: 4,
    });

    clock.advance(9 * 60_000);
    const llmClient = new FakeLLMClient({ responses: [quietResponse()] });

    await buildService(repository, clock).extractAndReconcile({
      llmClient,
      turnId: "turn-10",
      isUserTurn: true,
      userMessage: "dobranoc",
      recentHistory: [],
      sessionId,
      sourceStreamEntryIds: [],
      currentTurnCounter: 10,
    });

    expect(openExpectationsFromRequest(llmClient)[0]).toMatchObject({
      formed_turns_ago: 6,
      formed_minutes_ago: 9,
    });
  });

  it("leaves the turn distance unknown when either side has no ordinal", async () => {
    const clock = new ManualClock(0);
    const repository = openRepository(clock);
    const sessionId = createSessionId();

    // Written before the ordinal was recorded: minutes are still knowable, turns are not.
    repository.recordExpectation({
      sessionId,
      turnId: "turn-1",
      content: "Someone will answer.",
    });

    clock.advance(2 * 60_000);
    const llmClient = new FakeLLMClient({ responses: [quietResponse()] });

    await buildService(repository, clock).extractAndReconcile({
      llmClient,
      turnId: "turn-3",
      isUserTurn: true,
      userMessage: "hej",
      recentHistory: [],
      sessionId,
      sourceStreamEntryIds: [],
      currentTurnCounter: 3,
    });

    expect(openExpectationsFromRequest(llmClient)[0]).toMatchObject({
      formed_turns_ago: null,
      formed_minutes_ago: 2,
    });
  });
});

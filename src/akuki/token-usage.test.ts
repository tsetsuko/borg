import { describe, expect, it } from "vitest";
import type { TokenUsageEvent } from "../llm/index.js";
import { aggregateAkukiTokenUsage, createAkukiTokenUsageCollector } from "./token-usage.js";

function usage(overrides: Partial<TokenUsageEvent> = {}): TokenUsageEvent {
  return {
    budget: "test",
    model: "claude-one",
    input_tokens: 10,
    output_tokens: 4,
    ...overrides,
  };
}

describe("Akuki token usage", () => {
  it("aggregates multiple events for one model, including cache counters", () => {
    const report = aggregateAkukiTokenUsage([
      usage({ cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }),
      usage({ input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 11 }),
    ]);

    expect(report).toEqual({
      calls: 2,
      inputTokens: 30,
      outputTokens: 12,
      cacheReadInputTokens: 18,
      cacheCreationInputTokens: 3,
      byModel: [
        {
          model: "claude-one",
          calls: 2,
          inputTokens: 30,
          outputTokens: 12,
          cacheReadInputTokens: 18,
          cacheCreationInputTokens: 3,
        },
      ],
      byBudget: [
        {
          budget: "test",
          calls: 2,
          inputTokens: 30,
          outputTokens: 12,
          cacheReadInputTokens: 18,
          cacheCreationInputTokens: 3,
        },
      ],
    });
  });

  it("separates call sites that share one model", () => {
    // The question TASK-013 asks is which mechanism spends, not which model: the
    // reflector and a live turn can run on the same model and cost very differently.
    const report = aggregateAkukiTokenUsage([
      usage({ budget: "reflection", input_tokens: 100 }),
      usage({ budget: "offline-reflector", input_tokens: 900, cache_read_input_tokens: 50 }),
      usage({ budget: "reflection", input_tokens: 40 }),
    ]);

    expect(report.byModel).toHaveLength(1);
    expect(report.byBudget).toEqual([
      {
        budget: "offline-reflector",
        calls: 1,
        inputTokens: 900,
        outputTokens: 4,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 0,
      },
      {
        budget: "reflection",
        calls: 2,
        inputTokens: 140,
        outputTokens: 8,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    ]);
  });

  it("keeps different models separate while producing grand totals", () => {
    const report = aggregateAkukiTokenUsage([
      usage({ model: "claude-two", input_tokens: 6 }),
      usage({ model: "claude-one", output_tokens: 9 }),
    ]);

    expect(report.calls).toBe(2);
    expect(report.inputTokens).toBe(16);
    expect(report.outputTokens).toBe(13);
    expect(report.byModel.map(({ model }) => model)).toEqual(["claude-one", "claude-two"]);
  });

  it("collects sink events for a report", async () => {
    const collector = createAkukiTokenUsageCollector();
    await collector.usageSink(usage());
    await collector.usageSink(usage({ input_tokens: 2 }));

    expect(collector.report().calls).toBe(2);
    expect(collector.report().inputTokens).toBe(12);
  });
});

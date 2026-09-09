import type { TokenUsageEvent, TokenUsageSink } from "../llm/index.js";

export type AkukiTokenUsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type AkukiTokenUsageByModel = AkukiTokenUsageTotals & {
  model: string;
};

// The budget is borg's call-site label ("reflection", "offline-reflector",
// "prediction-extractor", ...). Totals per model answer "which model costs";
// totals per budget answer "which mechanism costs", which is the question
// TASK-013 actually asks -- one model serves many call sites.
export type AkukiTokenUsageByBudget = AkukiTokenUsageTotals & {
  budget: string;
};

export type AkukiTokenUsageReport = AkukiTokenUsageTotals & {
  byModel: readonly AkukiTokenUsageByModel[];
  byBudget: readonly AkukiTokenUsageByBudget[];
};

const EMPTY_TOTALS: AkukiTokenUsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

function addEvent(totals: AkukiTokenUsageTotals, event: TokenUsageEvent): void {
  totals.calls += 1;
  totals.inputTokens += event.input_tokens;
  totals.outputTokens += event.output_tokens;
  totals.cacheReadInputTokens += event.cache_read_input_tokens ?? 0;
  totals.cacheCreationInputTokens += event.cache_creation_input_tokens ?? 0;
}

export function aggregateAkukiTokenUsage(
  events: readonly TokenUsageEvent[],
): AkukiTokenUsageReport {
  const totals = { ...EMPTY_TOTALS };
  const byModel = new Map<string, AkukiTokenUsageByModel>();
  const byBudget = new Map<string, AkukiTokenUsageByBudget>();

  for (const event of events) {
    addEvent(totals, event);
    const modelTotals = byModel.get(event.model) ?? { model: event.model, ...EMPTY_TOTALS };
    addEvent(modelTotals, event);
    byModel.set(event.model, modelTotals);
    const budgetTotals = byBudget.get(event.budget) ?? { budget: event.budget, ...EMPTY_TOTALS };
    addEvent(budgetTotals, event);
    byBudget.set(event.budget, budgetTotals);
  }

  return {
    ...totals,
    byModel: [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model)),
    byBudget: [...byBudget.values()].sort((left, right) => left.budget.localeCompare(right.budget)),
  };
}

export function createAkukiTokenUsageCollector(): {
  usageSink: TokenUsageSink;
  report: () => AkukiTokenUsageReport;
} {
  const events: TokenUsageEvent[] = [];
  return {
    usageSink: (event) => {
      events.push(event);
    },
    report: () => aggregateAkukiTokenUsage(events),
  };
}

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

export type AkukiTokenUsageReport = AkukiTokenUsageTotals & {
  byModel: readonly AkukiTokenUsageByModel[];
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

  for (const event of events) {
    addEvent(totals, event);
    const modelTotals = byModel.get(event.model) ?? { model: event.model, ...EMPTY_TOTALS };
    addEvent(modelTotals, event);
    byModel.set(event.model, modelTotals);
  }

  return {
    ...totals,
    byModel: [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model)),
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

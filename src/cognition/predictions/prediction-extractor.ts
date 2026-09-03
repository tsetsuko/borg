import { z } from "zod";

import {
  callStructuredTool,
  isStructuredToolCallError,
  toToolInputSchema,
  type LLMClient,
  type LLMMessage,
  type LLMToolDefinition,
} from "../../llm/index.js";
import type { PredictionRepository } from "../../memory/predictions/index.js";
import {
  entityIdHelpers,
  predictionEventIdHelpers,
  type EntityId,
  type PredictionEventId,
  type SessionId,
  type StreamEntryId,
} from "../../util/ids.js";
import type { RecencyMessage } from "../recency/index.js";
import type { TurnTracer } from "../../tracing/tracer.js";
import { EXTRACTOR_MAX_TOKENS_DEFAULT } from "../prompts/constants.js";
import { PREDICTION_EXTRACTION_SYSTEM_PROMPT } from "../prompts/prediction-extraction.js";

const PREDICTION_TOOL_NAME = "EmitPredictionUpdate";

const reconciliationSchema = z
  .object({
    prediction_id: z.string().min(1),
    outcome: z.string().trim().min(1),
    error_magnitude: z.number().min(0).max(1),
    about_entity_id: z.string().min(1).nullable().optional(),
  })
  .strict();

const newExpectationSchema = z
  .object({
    content: z.string().trim().min(1),
    about: z.string().trim().min(1).nullable().optional(),
    about_entity_id: z.string().min(1).nullable().optional(),
  })
  .strict();

const predictionOutputSchema = z
  .object({
    reconciliations: z.array(reconciliationSchema).default([]),
    new_expectations: z.array(newExpectationSchema).default([]),
  })
  .strict();

const PREDICTION_TOOL = {
  name: PREDICTION_TOOL_NAME,
  description:
    "Record which open expectations this turn resolved (with your own surprise appraisal) and any new expectations you now hold.",
  inputSchema: toToolInputSchema(predictionOutputSchema),
} satisfies LLMToolDefinition;

export type PredictionExtractorDegradedReason =
  | "llm_unavailable"
  | "repository_unavailable"
  | "llm_failed"
  | "missing_tool_call"
  | "invalid_payload"
  | "repository_failed";

export type OpenExpectationForPrompt = {
  prediction_id: PredictionEventId;
  content: string;
  about: string | null;
};

export type PredictionExtractorOptions = {
  llmClient?: LLMClient;
  model?: string;
  predictionRepository?: PredictionRepository;
  tracer?: TurnTracer;
  turnId?: string;
  sessionId?: SessionId;
  onDegraded?: (reason: PredictionExtractorDegradedReason, error?: unknown) => Promise<void> | void;
};

export type ExtractPredictionsInput = {
  userMessage: string;
  recentHistory: readonly RecencyMessage[];
  openExpectations: readonly OpenExpectationForPrompt[];
  sessionId: SessionId;
  turnId: string;
  /** Stream entries of this turn, stored on new expectations for episode linkage. */
  sourceStreamEntryIds?: readonly StreamEntryId[];
};

export type PredictionExtractionResult = {
  reconciledPredictionIds: PredictionEventId[];
  createdExpectationIds: PredictionEventId[];
};

function asEntityId(value: string | null | undefined): EntityId | null {
  return value !== null && value !== undefined && entityIdHelpers.is(value) ? value : null;
}

function buildMessages(input: ExtractPredictionsInput): LLMMessage[] {
  return [
    {
      role: "user",
      content: JSON.stringify({
        current_message: input.userMessage,
        recent_history_context: input.recentHistory.slice(-8).map((message) => ({
          role: message.role,
          kind: message.kind ?? null,
          sender_entity_id: message.sender_entity_id,
          content: message.content,
        })),
        open_expectations: input.openExpectations.map((expectation) => ({
          prediction_id: expectation.prediction_id,
          content: expectation.content,
          about: expectation.about,
        })),
      }),
    },
  ];
}

const EMPTY_RESULT: PredictionExtractionResult = {
  reconciledPredictionIds: [],
  createdExpectationIds: [],
};

export class PredictionExtractor {
  constructor(private readonly options: PredictionExtractorOptions = {}) {}

  private async degraded(
    reason: PredictionExtractorDegradedReason,
    error?: unknown,
  ): Promise<PredictionExtractionResult> {
    try {
      await this.options.onDegraded?.(reason, error);
    } catch {
      // Best-effort degraded logging only.
    }

    return EMPTY_RESULT;
  }

  async extract(input: ExtractPredictionsInput): Promise<PredictionExtractionResult> {
    if (this.options.llmClient === undefined || this.options.model === undefined) {
      return this.degraded("llm_unavailable");
    }

    const repository = this.options.predictionRepository;

    if (repository === undefined) {
      return this.degraded("repository_unavailable");
    }

    const messages = buildMessages(input);
    const tools = [PREDICTION_TOOL];

    let parsed: z.infer<typeof predictionOutputSchema>;

    try {
      parsed = (
        await callStructuredTool({
          llmClient: this.options.llmClient,
          request: {
            model: this.options.model,
            system: PREDICTION_EXTRACTION_SYSTEM_PROMPT,
            messages,
            tools,
            tool_choice: { type: "tool", name: PREDICTION_TOOL_NAME },
            max_tokens: EXTRACTOR_MAX_TOKENS_DEFAULT,
            budget: "prediction-extractor",
          },
          toolName: PREDICTION_TOOL_NAME,
          parse: (value: unknown) => predictionOutputSchema.parse(value),
          trace: {
            tracer: this.options.tracer,
            turnId: this.options.turnId,
            sessionId: this.options.sessionId,
            label: "prediction_extractor",
            systemPrompt: PREDICTION_EXTRACTION_SYSTEM_PROMPT,
            messages,
            tools,
          },
        })
      ).parsed;
    } catch (error) {
      if (isStructuredToolCallError(error, "missing_tool_call")) {
        return this.degraded("missing_tool_call", error);
      }

      if (isStructuredToolCallError(error, "invalid_payload")) {
        return this.degraded("invalid_payload", error.cause ?? error);
      }

      return this.degraded(
        "llm_failed",
        isStructuredToolCallError(error, "llm_failed") ? (error.cause ?? error) : error,
      );
    }

    // Only expectations we actually surfaced can be reconciled: a prediction_id the
    // model returns that is not open right now is a hallucinated reference, dropped.
    const openIds = new Set<string>(input.openExpectations.map((e) => e.prediction_id));
    const reconciledPredictionIds: PredictionEventId[] = [];
    const createdExpectationIds: PredictionEventId[] = [];

    for (const reconciliation of parsed.reconciliations) {
      if (
        !predictionEventIdHelpers.is(reconciliation.prediction_id) ||
        !openIds.has(reconciliation.prediction_id)
      ) {
        continue;
      }

      try {
        const row = repository.reconcile({
          predictionId: reconciliation.prediction_id,
          sessionId: input.sessionId,
          turnId: input.turnId,
          content: reconciliation.outcome,
          errorMagnitude: reconciliation.error_magnitude,
          aboutEntityId: asEntityId(reconciliation.about_entity_id),
        });
        reconciledPredictionIds.push(row.prediction_id);
      } catch (error) {
        await this.degraded("repository_failed", error);
      }
    }

    for (const expectation of parsed.new_expectations) {
      try {
        const row = repository.recordExpectation({
          sessionId: input.sessionId,
          turnId: input.turnId,
          content: expectation.content,
          about: expectation.about ?? null,
          aboutEntityId: asEntityId(expectation.about_entity_id),
          sourceStreamIds: input.sourceStreamEntryIds ?? [],
        });
        createdExpectationIds.push(row.id);
      } catch (error) {
        await this.degraded("repository_failed", error);
      }
    }

    return { reconciledPredictionIds, createdExpectationIds };
  }
}

export { PREDICTION_TOOL_NAME };

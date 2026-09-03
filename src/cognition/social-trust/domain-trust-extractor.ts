import { z } from "zod";

import {
  callStructuredTool,
  isStructuredToolCallError,
  toToolInputSchema,
  type LLMClient,
  type LLMMessage,
  type LLMToolDefinition,
} from "../../llm/index.js";
import type { DomainTrustReading, SocialRepository } from "../../memory/social/index.js";
import type { EntityId, SessionId } from "../../util/ids.js";
import type { RecencyMessage } from "../recency/index.js";
import type { TurnTracer } from "../../tracing/tracer.js";
import { EXTRACTOR_MAX_TOKENS_DEFAULT } from "../prompts/constants.js";
import { DOMAIN_TRUST_EXTRACTION_SYSTEM_PROMPT } from "../prompts/domain-trust-extraction.js";

const DOMAIN_TRUST_TOOL_NAME = "EmitDomainTrustEvidence";

// How many already-known domains to surface, so the model reuses stable labels
// instead of inventing a near-duplicate for the same kind of thing.
const KNOWN_DOMAIN_SURFACE_CAP = 24;

const evidenceSchema = z
  .object({
    domain: z.string().trim().min(1),
    positive: z.boolean(),
  })
  .strict();

const domainTrustOutputSchema = z
  .object({
    evidence: z.array(evidenceSchema).default([]),
  })
  .strict();

const DOMAIN_TRUST_TOOL = {
  name: DOMAIN_TRUST_TOOL_NAME,
  description:
    "Record what this turn showed about whether this person can be relied on, and in which domains.",
  inputSchema: toToolInputSchema(domainTrustOutputSchema),
} satisfies LLMToolDefinition;

export type DomainTrustExtractorDegradedReason =
  | "llm_unavailable"
  | "repository_unavailable"
  | "llm_failed"
  | "missing_tool_call"
  | "invalid_payload"
  | "repository_failed";

export type DomainTrustExtractorOptions = {
  llmClient?: LLMClient;
  model?: string;
  socialRepository?: Pick<SocialRepository, "listDomainTrust" | "adjustDomainTrust">;
  tracer?: TurnTracer;
  turnId?: string;
  sessionId?: SessionId;
  onDegraded?: (reason: DomainTrustExtractorDegradedReason, error?: unknown) => Promise<void> | void;
};

export type ExtractDomainTrustInput = {
  userMessage: string;
  recentHistory: readonly RecencyMessage[];
  /** The person this turn's trust evidence is attributed to. */
  partnerEntityId: EntityId;
  partnerDisplayName: string | null;
};

export type DomainTrustExtractionResult = {
  readings: DomainTrustReading[];
};

const EMPTY_RESULT: DomainTrustExtractionResult = { readings: [] };

function buildMessages(
  input: ExtractDomainTrustInput,
  knownDomains: readonly DomainTrustReading[],
): LLMMessage[] {
  return [
    {
      role: "user",
      content: JSON.stringify({
        partner: {
          entity_id: input.partnerEntityId,
          display_name: input.partnerDisplayName,
        },
        current_message: input.userMessage,
        recent_history_context: input.recentHistory.slice(-8).map((message) => ({
          role: message.role,
          kind: message.kind ?? null,
          sender_entity_id: message.sender_entity_id,
          content: message.content,
        })),
        known_domains: knownDomains.slice(0, KNOWN_DOMAIN_SURFACE_CAP).map((reading) => ({
          domain: reading.domain,
          trust: reading.mean,
          confidence_interval_95: reading.ci95,
          observations: reading.observations,
        })),
      }),
    },
  ];
}

/**
 * Post-turn appraisal of a partner's responsiveness, written into the per-domain
 * Beta posteriors. Extract-only: it reads the turn and writes the trust ledger,
 * never the reply. The model chooses the domain labels and the sign of the
 * evidence; the harness only carries them to the store.
 */
export class DomainTrustExtractor {
  constructor(private readonly options: DomainTrustExtractorOptions = {}) {}

  private async degraded(
    reason: DomainTrustExtractorDegradedReason,
    error?: unknown,
  ): Promise<DomainTrustExtractionResult> {
    try {
      await this.options.onDegraded?.(reason, error);
    } catch {
      // Best-effort degraded logging only.
    }

    return EMPTY_RESULT;
  }

  async extract(input: ExtractDomainTrustInput): Promise<DomainTrustExtractionResult> {
    if (this.options.llmClient === undefined || this.options.model === undefined) {
      return this.degraded("llm_unavailable");
    }

    const repository = this.options.socialRepository;

    if (repository === undefined) {
      return this.degraded("repository_unavailable");
    }

    const messages = buildMessages(input, repository.listDomainTrust(input.partnerEntityId));
    const tools = [DOMAIN_TRUST_TOOL];

    let parsed: z.infer<typeof domainTrustOutputSchema>;

    try {
      parsed = (
        await callStructuredTool({
          llmClient: this.options.llmClient,
          request: {
            model: this.options.model,
            system: DOMAIN_TRUST_EXTRACTION_SYSTEM_PROMPT,
            messages,
            tools,
            tool_choice: { type: "tool", name: DOMAIN_TRUST_TOOL_NAME },
            max_tokens: EXTRACTOR_MAX_TOKENS_DEFAULT,
            budget: "domain-trust-extractor",
          },
          toolName: DOMAIN_TRUST_TOOL_NAME,
          parse: (value: unknown) => domainTrustOutputSchema.parse(value),
          trace: {
            tracer: this.options.tracer,
            turnId: this.options.turnId,
            sessionId: this.options.sessionId,
            label: "domain_trust_extractor",
            systemPrompt: DOMAIN_TRUST_EXTRACTION_SYSTEM_PROMPT,
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

    const readings: DomainTrustReading[] = [];

    for (const evidence of parsed.evidence) {
      try {
        readings.push(
          repository.adjustDomainTrust(input.partnerEntityId, evidence.domain, {
            positive: evidence.positive,
          }),
        );
      } catch (error) {
        await this.degraded("repository_failed", error);
      }
    }

    return { readings };
  }
}

export { DOMAIN_TRUST_TOOL_NAME };

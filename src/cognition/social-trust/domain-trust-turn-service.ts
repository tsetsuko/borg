import type { LLMClient } from "../../llm/index.js";
import type { SocialRepository } from "../../memory/social/index.js";
import type { EntityId, SessionId } from "../../util/ids.js";
import type { RecencyMessage } from "../recency/index.js";
import type { TurnTracer } from "../../tracing/tracer.js";
import {
  DomainTrustExtractor,
  type DomainTrustExtractionResult,
} from "./domain-trust-extractor.js";

export type DomainTrustTurnServiceOptions = {
  model: string;
  socialRepository: Pick<SocialRepository, "listDomainTrust" | "adjustDomainTrust">;
  entityRepository: { get(entityId: EntityId): { canonical_name: string } | null };
  tracer: TurnTracer;
};

export type ExtractDomainTrustTurnInput = {
  llmClient: LLMClient;
  turnId: string;
  isUserTurn: boolean;
  userMessage: string;
  recentHistory: readonly RecencyMessage[];
  sessionId: SessionId;
  /**
   * Who this turn's trust evidence is about: the resolved speaker when the turn
   * has one, otherwise the audience. Null when neither is known -- evidence with
   * no owner is dropped rather than attributed to a guess.
   */
  partnerEntityId: EntityId | null;
};

const EMPTY_RESULT: DomainTrustExtractionResult = { readings: [] };

/**
 * Per-turn producer for per-domain trust (M4): classifies whether the partner was
 * responsive in this turn and in which domain, and folds that into their Beta
 * posteriors. Responsiveness is the signal, not contact -- a turn happening at all
 * is not evidence.
 */
export class DomainTrustTurnService {
  constructor(private readonly options: DomainTrustTurnServiceOptions) {}

  async extract(input: ExtractDomainTrustTurnInput): Promise<DomainTrustExtractionResult> {
    if (!input.isUserTurn || input.partnerEntityId === null) {
      return EMPTY_RESULT;
    }

    const extractor = new DomainTrustExtractor({
      llmClient: input.llmClient,
      model: this.options.model,
      socialRepository: this.options.socialRepository,
      tracer: this.options.tracer,
      turnId: input.turnId,
      sessionId: input.sessionId,
    });

    return extractor.extract({
      userMessage: input.userMessage,
      recentHistory: input.recentHistory,
      partnerEntityId: input.partnerEntityId,
      partnerDisplayName:
        this.options.entityRepository.get(input.partnerEntityId)?.canonical_name ?? null,
    });
  }
}

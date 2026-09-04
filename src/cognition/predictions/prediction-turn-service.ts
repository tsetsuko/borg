import { predictionMemoryDisclosureLabel } from "../../memory/common/disclosure-serializers.js";
import type { EpisodicRepository } from "../../memory/episodic/index.js";
import type { LLMClient } from "../../llm/index.js";
import type { PredictionRepository } from "../../memory/predictions/index.js";
import type { Clock } from "../../util/clock.js";
import type { EntityId, SessionId, StreamEntryId } from "../../util/ids.js";
import type { RecencyMessage } from "../recency/index.js";
import type { TurnTracer } from "../../tracing/tracer.js";
import {
  PredictionExtractor,
  type PredictionExtractionResult,
} from "./prediction-extractor.js";
import {
  applySurpriseSignificance,
  type SurpriseSignificanceParams,
} from "./surprise-significance.js";

// How many open expectations to bring into the reflection. Recall is global to the
// being (listOpen applies no session/audience gate); this is a budget, not a filter.
const OPEN_EXPECTATION_SURFACE_CAP = 40;

export type PredictionTurnServiceOptions = {
  model: string;
  predictionRepository: PredictionRepository;
  episodicRepository: Pick<
    EpisodicRepository,
    "findBySourceStreamIdsContaining" | "updateSignificance"
  >;
  /** Resolves the attachment figure name to an entity id (structural, not by wording). */
  entityRepository: { findByName(name: string): EntityId | null };
  params: SurpriseSignificanceParams;
  /** Attachment figure name from temperament; null when unset. */
  attachmentFigureName: string | null;
  clock: Clock;
  tracer: TurnTracer;
};

export type ExtractPredictionsTurnInput = {
  llmClient: LLMClient;
  turnId: string;
  isUserTurn: boolean;
  userMessage: string;
  recentHistory: readonly RecencyMessage[];
  sessionId: SessionId;
  /** Stream entries of this turn; stored on new expectations for later episode linkage. */
  sourceStreamEntryIds: readonly StreamEntryId[];
};

const EMPTY_RESULT: PredictionExtractionResult = {
  reconciledPredictionIds: [],
  createdExpectationIds: [],
};

export class PredictionTurnService {
  constructor(private readonly options: PredictionTurnServiceOptions) {}

  async extractAndReconcile(
    input: ExtractPredictionsTurnInput,
  ): Promise<PredictionExtractionResult> {
    if (!input.isUserTurn) {
      return EMPTY_RESULT;
    }

    const openExpectations = this.options.predictionRepository
      .listOpen({ limit: OPEN_EXPECTATION_SURFACE_CAP })
      .map((expectation) => ({
        prediction_id: expectation.prediction_id,
        content: expectation.content,
        about: expectation.about,
        disclosureLabel: predictionMemoryDisclosureLabel(),
      }));

    const extractor = new PredictionExtractor({
      llmClient: input.llmClient,
      model: this.options.model,
      predictionRepository: this.options.predictionRepository,
      tracer: this.options.tracer,
      turnId: input.turnId,
      sessionId: input.sessionId,
    });

    const result = await extractor.extract({
      userMessage: input.userMessage,
      recentHistory: input.recentHistory,
      openExpectations,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceStreamEntryIds: input.sourceStreamEntryIds,
    });

    if (result.reconciledPredictionIds.length > 0) {
      const attachmentFigureEntityId =
        this.options.attachmentFigureName === null
          ? null
          : this.options.entityRepository.findByName(this.options.attachmentFigureName);

      await applySurpriseSignificance({
        reconciledPredictionIds: result.reconciledPredictionIds,
        predictionRepository: this.options.predictionRepository,
        episodicRepository: this.options.episodicRepository,
        params: this.options.params,
        attachmentFigureEntityId,
      });
    }

    return result;
  }
}

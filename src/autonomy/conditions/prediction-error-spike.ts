import type { PredictionRepository } from "../../memory/predictions/index.js";
import type { StreamWatermarkRepository } from "../../stream/index.js";
import { SystemClock, type Clock } from "../../util/clock.js";
import { DEFAULT_SESSION_ID, type SessionId } from "../../util/ids.js";
import type { AutonomyCondition, DueEvent } from "../types.js";

const CONDITION_NAME = "prediction_error_spike" as const;
const WATERMARK_PREFIX = "autonomy:prediction-error-spike";
const DEFAULT_SCAN_LIMIT = 20;

export type PredictionErrorSpikePayload = {
  prediction_id: string;
  error_magnitude: number;
  threshold: number;
  created_ts: number;
};

export type PredictionErrorSpikeConditionOptions = {
  predictionRepository: Pick<PredictionRepository, "listReconciliationsSince">;
  watermarkRepository: StreamWatermarkRepository;
  /** Reconciliations at or above this surprise wake the entity to ruminate. */
  threshold: number;
  scanLimit?: number;
  clock?: Clock;
  sessionId?: SessionId;
};

// A prediction the entity resolved with high surprise is worth thinking about on its
// own time. Recall is global, so the watermark is a single global cursor rather than
// a per-audience one; the DEFAULT_SESSION_ID keeps it out of any conversational lane.
export function createPredictionErrorSpikeCondition(
  options: PredictionErrorSpikeConditionOptions,
): AutonomyCondition<PredictionErrorSpikePayload> {
  const clock = options.clock ?? new SystemClock();
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const watermarkProcessName = `${WATERMARK_PREFIX}:${sessionId}`;

  return {
    name: CONDITION_NAME,
    type: "condition",
    sourceCategory: "contemplative",
    async scan() {
      const watermark = options.watermarkRepository.get(watermarkProcessName, sessionId);
      const sinceMs = watermark?.lastTs ?? 0;

      const reconciliations = options.predictionRepository.listReconciliationsSince({
        sinceMs,
        limit: scanLimit,
      });

      return reconciliations.flatMap((reconciliation) => {
        const error = reconciliation.error_magnitude;

        if (error === null || error < options.threshold) {
          return [];
        }

        return [
          {
            id: `${sessionId}:${reconciliation.id}`,
            sourceName: CONDITION_NAME,
            sourceType: "condition",
            watermarkProcessName,
            sortTs: reconciliation.created_ts,
            stateTs: reconciliation.created_ts,
            payload: {
              prediction_id: reconciliation.prediction_id,
              error_magnitude: error,
              threshold: options.threshold,
              created_ts: reconciliation.created_ts,
            },
          } satisfies DueEvent<PredictionErrorSpikePayload>,
        ];
      });
    },
    buildTurn(event) {
      return {
        audience: "self",
        stakes: "low",
        userMessage: "",
        autonomyTrigger: {
          source_name: event.sourceName,
          source_type: event.sourceType,
          event_id: event.id,
          sort_ts: event.sortTs,
          payload: event.payload,
        },
      };
    },
  };
}

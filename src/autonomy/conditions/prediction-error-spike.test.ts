import { describe, expect, it, vi } from "vitest";

import type { PredictionEvent } from "../../memory/predictions/index.js";
import type { StreamWatermark, StreamWatermarkRepository } from "../../stream/index.js";
import { createPredictionEventId, type SessionId } from "../../util/ids.js";
import { createPredictionErrorSpikeCondition } from "./prediction-error-spike.js";

function reconciliation(errorMagnitude: number, createdTs: number): PredictionEvent {
  return {
    id: createPredictionEventId(),
    prediction_id: createPredictionEventId(),
    kind: "reconciliation",
    error_magnitude: errorMagnitude,
    created_ts: createdTs,
  } as PredictionEvent;
}

function fakeWatermark(watermark: StreamWatermark | null) {
  return {
    get: vi.fn((_processName: string, _sessionId: SessionId) => watermark),
  } as unknown as StreamWatermarkRepository;
}

describe("createPredictionErrorSpikeCondition", () => {
  it("emits a due event only for reconciliations at or above the threshold", async () => {
    const rows = [reconciliation(0.7, 1_000), reconciliation(0.3, 1_100)];
    const predictionRepository = { listReconciliationsSince: vi.fn(() => rows) };

    const condition = createPredictionErrorSpikeCondition({
      predictionRepository,
      watermarkRepository: fakeWatermark(null),
      threshold: 0.6,
    });

    const events = await condition.scan();

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.error_magnitude).toBe(0.7);
    expect(events[0]!.sourceName).toBe("prediction_error_spike");
    expect(events[0]!.watermarkProcessName).toContain("autonomy:prediction-error-spike");
  });

  it("scans only reconciliations after the watermark timestamp", async () => {
    const predictionRepository = { listReconciliationsSince: vi.fn(() => []) };
    const watermark = { lastTs: 5_000 } as StreamWatermark;

    const condition = createPredictionErrorSpikeCondition({
      predictionRepository,
      watermarkRepository: fakeWatermark(watermark),
      threshold: 0.6,
    });

    await condition.scan();

    expect(predictionRepository.listReconciliationsSince).toHaveBeenCalledWith(
      expect.objectContaining({ sinceMs: 5_000 }),
    );
  });

  it("builds a self-directed rumination turn", () => {
    const condition = createPredictionErrorSpikeCondition({
      predictionRepository: { listReconciliationsSince: vi.fn(() => []) },
      watermarkRepository: fakeWatermark(null),
      threshold: 0.6,
    });

    const turn = condition.buildTurn({
      id: "e1",
      sourceName: "prediction_error_spike",
      sourceType: "condition",
      watermarkProcessName: "autonomy:prediction-error-spike:default",
      sortTs: 1,
      stateTs: 1,
      payload: { prediction_id: "p1", error_magnitude: 0.8, threshold: 0.6, created_ts: 1 },
    });

    expect(turn.audience).toBe("self");
    expect(turn.stakes).toBe("low");
    expect(turn.autonomyTrigger?.source_name).toBe("prediction_error_spike");
  });
});

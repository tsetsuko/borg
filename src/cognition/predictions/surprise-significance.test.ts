import { describe, expect, it, vi } from "vitest";

import type { Episode } from "../../memory/episodic/index.js";
import type { PredictionEvent } from "../../memory/predictions/index.js";
import {
  createEntityId,
  createEpisodeId,
  createPredictionEventId,
  createStreamEntryId,
  type EntityId,
  type PredictionEventId,
} from "../../util/ids.js";
import {
  applySurpriseSignificance,
  type SurpriseSignificanceParams,
} from "./surprise-significance.js";

const PARAMS: SurpriseSignificanceParams = {
  surpriseWeight: 2,
  curiosityGain: 0.7,
  targetErrorBand: [0.25, 0.6],
  attachmentMemoryWeight: 1.5,
  significanceStep: 0.1,
};

function buildDeps(input: {
  errorMagnitude: number;
  significance: number;
  aboutEntityId?: EntityId | null;
}) {
  const predictionId = createPredictionEventId();
  const streamId = createStreamEntryId();
  const episode = { id: createEpisodeId(), significance: input.significance } as Episode;

  const reconciliation = {
    error_magnitude: input.errorMagnitude,
    about_entity_id: input.aboutEntityId ?? null,
  } as PredictionEvent;
  const expectation = { source_stream_ids: [streamId] } as PredictionEvent;

  const updateSignificance = vi.fn(async (_id, significance: number) => ({
    ...episode,
    significance,
  }));

  const predictionRepository = {
    getReconciliation: (_id: PredictionEventId) => reconciliation,
    getExpectation: (_id: PredictionEventId) => expectation,
  };
  const episodicRepository = {
    findBySourceStreamIdsContaining: async () => episode,
    updateSignificance,
  };

  return { predictionId, episode, updateSignificance, predictionRepository, episodicRepository };
}

describe("applySurpriseSignificance", () => {
  it("boosts significance for in-band surprise", async () => {
    const deps = buildDeps({ errorMagnitude: 0.5, significance: 0.2 });

    const result = await applySurpriseSignificance({
      reconciledPredictionIds: [deps.predictionId],
      predictionRepository: deps.predictionRepository,
      episodicRepository: deps.episodicRepository,
      params: PARAMS,
      attachmentFigureEntityId: null,
    });

    // delta = 0.1 * 2 * 0.7 * 0.5 = 0.07
    expect(deps.updateSignificance).toHaveBeenCalledTimes(1);
    expect(deps.updateSignificance.mock.calls[0]![1]).toBeCloseTo(0.27, 5);
    expect(result.boostedEpisodeIds).toEqual([deps.episode.id]);
  });

  it("leaves significance untouched for surprise outside the ZPD band", async () => {
    const deps = buildDeps({ errorMagnitude: 0.9, significance: 0.2 });

    const result = await applySurpriseSignificance({
      reconciledPredictionIds: [deps.predictionId],
      predictionRepository: deps.predictionRepository,
      episodicRepository: deps.episodicRepository,
      params: PARAMS,
      attachmentFigureEntityId: null,
    });

    expect(deps.updateSignificance).not.toHaveBeenCalled();
    expect(result.boostedEpisodeIds).toEqual([]);
  });

  it("scales the boost by attachment memory weight when about the attachment figure", async () => {
    const figure = createEntityId();
    const deps = buildDeps({ errorMagnitude: 0.5, significance: 0.2, aboutEntityId: figure });

    await applySurpriseSignificance({
      reconciledPredictionIds: [deps.predictionId],
      predictionRepository: deps.predictionRepository,
      episodicRepository: deps.episodicRepository,
      params: PARAMS,
      attachmentFigureEntityId: figure,
    });

    // delta = 0.1 * 2 * 0.7 * 0.5 * 1.5 = 0.105
    expect(deps.updateSignificance.mock.calls[0]![1]).toBeCloseTo(0.305, 5);
  });
});

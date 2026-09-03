import type { EpisodicRepository } from "../../memory/episodic/index.js";
import type { PredictionRepository } from "../../memory/predictions/index.js";
import type { EntityId, EpisodeId, PredictionEventId } from "../../util/ids.js";

// The parameters below come from Akuki's temperament.yaml (surprise_weight,
// curiosity.gain, curiosity.target_error_band, attachment.memory_weight), threaded
// through config. The harness only does bounded arithmetic with them; the surprise
// value itself (error_magnitude) is the model's own appraisal.
export type SurpriseSignificanceParams = {
  surpriseWeight: number;
  curiosityGain: number;
  /** Zone of proximal development: only surprise INSIDE this band is "interesting". */
  targetErrorBand: readonly [number, number];
  attachmentMemoryWeight: number;
  /** Base increment; keeps a single in-band surprise a bounded significance nudge. */
  significanceStep: number;
};

export type ApplySurpriseSignificanceInput = {
  reconciledPredictionIds: readonly PredictionEventId[];
  predictionRepository: Pick<PredictionRepository, "getExpectation" | "getReconciliation">;
  episodicRepository: Pick<
    EpisodicRepository,
    "findBySourceStreamIdsContaining" | "updateSignificance"
  >;
  params: SurpriseSignificanceParams;
  /** Resolved attachment figure, or null when it names no known entity yet. */
  attachmentFigureEntityId: EntityId | null;
};

export type SurpriseSignificanceResult = {
  boostedEpisodeIds: EpisodeId[];
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * On reconciliation, raise the significance of the episode(s) the surprising
 * prediction grew from. Surprise in the ZPD band matters most; extreme or
 * negligible surprise is left alone. Nothing here judges or rewrites output --
 * it only reweights memory the model has already appraised.
 */
export async function applySurpriseSignificance(
  input: ApplySurpriseSignificanceInput,
): Promise<SurpriseSignificanceResult> {
  const [low, high] = input.params.targetErrorBand;
  const boostedEpisodeIds: EpisodeId[] = [];

  for (const predictionId of input.reconciledPredictionIds) {
    const reconciliation = input.predictionRepository.getReconciliation(predictionId);
    const error = reconciliation?.error_magnitude ?? null;

    if (reconciliation === null || error === null || error < low || error > high) {
      continue;
    }

    const expectation = input.predictionRepository.getExpectation(predictionId);

    if (expectation === null || expectation.source_stream_ids.length === 0) {
      continue;
    }

    const aboutFigure =
      input.attachmentFigureEntityId !== null &&
      reconciliation.about_entity_id === input.attachmentFigureEntityId;
    const attachmentFactor = aboutFigure ? input.params.attachmentMemoryWeight : 1;
    const delta =
      input.params.significanceStep *
      input.params.surpriseWeight *
      input.params.curiosityGain *
      error *
      attachmentFactor;

    if (delta <= 0) {
      continue;
    }

    const seen = new Set<EpisodeId>();

    for (const streamId of expectation.source_stream_ids) {
      const episode = await input.episodicRepository.findBySourceStreamIdsContaining([streamId]);

      if (episode === null || seen.has(episode.id)) {
        continue;
      }

      seen.add(episode.id);
      const nextSignificance = clamp01(episode.significance + delta);

      if (nextSignificance !== episode.significance) {
        await input.episodicRepository.updateSignificance(episode.id, nextSignificance);
        boostedEpisodeIds.push(episode.id);
      }
    }
  }

  return { boostedEpisodeIds };
}

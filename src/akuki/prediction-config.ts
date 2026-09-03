// Akuki: bridge temperament.yaml into Borg's core prediction (M2) and inhibition
// (M3) config.
//
// The M2/M3 mechanisms live in core Borg and read plain numbers from
// config.prediction / config.inhibition. Their VALUES are Akuki's temperament. This
// is where those temperament keys earn their reader: curiosity.gain,
// curiosity.target_error_band, memory.surprise_weight, attachment.memory_weight
// (M2) and inhibition.base_threshold, inhibition.uncertainty_weight (M3) are read
// here and pushed into the env Borg.open resolves, so the orphan guard
// (temperament.test.ts) sees a live consumer for each.

import { loadTemperament, type Temperament } from "./seed/temperament.js";

/**
 * Populate BORG_PREDICTION_* from temperament, unless already set. Uses `??=` so an
 * explicit environment override (tests, ops) still wins over the seed default.
 */
export function applyAkukiPredictionEnv(
  env: NodeJS.ProcessEnv,
  temperament: Temperament = loadTemperament(),
): void {
  env.BORG_PREDICTION_SURPRISE_WEIGHT ??= String(temperament.memory.surprise_weight);
  env.BORG_PREDICTION_CURIOSITY_GAIN ??= String(temperament.curiosity.gain);
  env.BORG_PREDICTION_TARGET_ERROR_BAND_LOW ??= String(temperament.curiosity.target_error_band[0]);
  env.BORG_PREDICTION_TARGET_ERROR_BAND_HIGH ??= String(temperament.curiosity.target_error_band[1]);
  env.BORG_PREDICTION_ATTACHMENT_MEMORY_WEIGHT ??= String(temperament.attachment.memory_weight);
  env.BORG_PREDICTION_ATTACHMENT_FIGURE_NAME ??= temperament.attachment.figure;
  env.BORG_INHIBITION_BASE_THRESHOLD ??= String(temperament.inhibition.base_threshold);
  env.BORG_INHIBITION_UNCERTAINTY_WEIGHT ??= String(temperament.inhibition.uncertainty_weight);
}

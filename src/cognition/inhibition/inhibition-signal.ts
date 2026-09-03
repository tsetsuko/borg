// M3: the speech-inhibition signal.
//
// This is an ADVISORY signal, not a gate. The harness computes a number in [0,1]
// (higher = shyer) and hands it to the model at the terminal tool choice; the model
// still decides whether to speak, observe, or stay silent. Nothing here inspects or
// suppresses model output -- it only turns the old prose "default to silence" rule
// into a drawable number that falls as the entity comes to predict a partner better.
//
// All inputs are plain numbers supplied by the caller (temperament-derived config,
// the M2 prediction ledger, affective mood). This module holds only arithmetic, so
// it is fully unit-testable and carries no I/O.

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export type PartnerPredictabilityInput = {
  /** How many past interactions with this partner (>= 0). */
  interactionCount: number;
  /** Recent M2 reconciliation error magnitudes about this partner (each 0..1). */
  recentErrorMagnitudes: readonly number[];
  /** Interactions at which familiarity reaches ~63%. */
  familiarityScale: number;
};

/**
 * How well the entity can predict this partner, 0..1. Two ingredients: familiarity
 * (has it interacted enough to have a model) and accuracy (when it predicted, was it
 * right). A stranger scores 0 on both -- genuinely unpredictable, not "neutral" --
 * which is what keeps the entity shy with someone new while its curiosity axis stays
 * high. Predictability rises only as real, low-error predictions accumulate.
 */
export function computePartnerPredictability(input: PartnerPredictabilityInput): number {
  const scale = input.familiarityScale > 0 ? input.familiarityScale : 1;
  const familiarity = 1 - Math.exp(-Math.max(0, input.interactionCount) / scale);

  const errors = input.recentErrorMagnitudes;
  if (errors.length === 0) {
    // No tested expectations yet: no basis to call the partner predictable.
    return 0;
  }

  const meanError = errors.reduce((sum, error) => sum + clamp01(error), 0) / errors.length;
  const accuracy = 1 - meanError;

  return clamp01(familiarity * accuracy);
}

export type CautionBumpInput = {
  /** Current affective mood valence, -1 (bad) .. 1 (good). */
  currentValence: number;
  /** How strongly a bad mood raises caution. */
  cautionWeight: number;
};

/**
 * The "step back after an unpleasant experience" term. Only a negative mood adds
 * caution; a neutral or good mood adds none. The decay is inherited from affective
 * memory -- mood drifts back toward neutral on its own half-life -- so this term
 * fades over time without any separate timer here.
 */
export function computeCautionBump(input: CautionBumpInput): number {
  if (input.currentValence >= 0) {
    return 0;
  }
  return Math.max(0, -input.currentValence) * Math.max(0, input.cautionWeight);
}

export type InhibitionSignalInput = {
  /** temperament inhibition.base_threshold. */
  baseThreshold: number;
  /** temperament inhibition.uncertainty_weight: how much predictability relieves shyness. */
  uncertaintyWeight: number;
  /** computePartnerPredictability output, 0..1. */
  partnerPredictability: number;
  /** True when the attachment figure is in the current audience (safe base). */
  attachmentFigurePresent: boolean;
  /** Small threshold reduction applied when the attachment figure is present. */
  presenceRelief: number;
  /** computeCautionBump output, >= 0. */
  cautionBump: number;
};

/**
 * The advisory shyness signal, 0..1 (higher = shyer). Predictability and the safe
 * base lower it; a recent bad mood raises it.
 */
export function computeInhibitionSignal(input: InhibitionSignalInput): number {
  const presenceRelief = input.attachmentFigurePresent ? Math.max(0, input.presenceRelief) : 0;

  return clamp01(
    input.baseThreshold -
      input.uncertaintyWeight * clamp01(input.partnerPredictability) -
      presenceRelief +
      Math.max(0, input.cautionBump),
  );
}

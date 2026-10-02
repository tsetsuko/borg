import type { PredictionRepository } from "../../memory/predictions/index.js";
import type { SocialRepository } from "../../memory/social/index.js";
import type { EntityId } from "../../util/ids.js";
import {
  computeCautionBump,
  computeInhibitionSignal,
  computePartnerPredictability,
} from "./inhibition-signal.js";

export type SpeechInhibitionParams = {
  baseThreshold: number;
  uncertaintyWeight: number;
  presenceRelief: number;
  cautionWeight: number;
  familiarityScale: number;
  recentErrorWindow: number;
};

export type BuildSpeechInhibitionSectionInput = {
  params: SpeechInhibitionParams;
  /**
   * The people this turn is with: the speaker alone when one is known, otherwise
   * every person present. Empty means nobody is known, which reads as a stranger.
   */
  partnerEntityIds: readonly EntityId[];
  /** Entities present this turn, for detecting the attachment figure in a group. */
  participantEntityIds?: readonly EntityId[];
  /** Resolved attachment figure entity id, or null when it names no known entity. */
  attachmentFigureEntityId: EntityId | null;
  /** Current affective mood valence, -1..1. */
  currentValence: number;
  predictionRepository: Pick<PredictionRepository, "listReconciliationsForEntity">;
  socialRepository: Pick<SocialRepository, "getProfile">;
};

function inhibitionBand(value: number): string {
  if (value >= 0.7) {
    return "high";
  }
  if (value >= 0.4) {
    return "moderate";
  }
  return "low";
}

/**
 * Build the advisory speech-inhibition section shown to the finalizer. The harness
 * computes the number; the model reads it and still chooses the terminal tool. The
 * framing is deliberately a child's uncertainty, not a gag: the entity can act
 * against its hesitation, and curiosity has an outlet (observation) that plain
 * silence does not, so staying mute is never the free-optimal move.
 */
export function buildSpeechInhibitionSection(input: BuildSpeechInhibitionSectionInput): string {
  // With several people and no single speaker, the least predictable one sets the
  // hesitation: one stranger in the thread is enough to make the entity careful.
  // CREATIVE CHOICE, not research-backed -- the literature behind M3 speaks of an
  // unfamiliar person, not of a group. Taking the minimum (rather than a mean) keeps
  // the number traceable to one named partner. Decided by the author 2026-10-01.
  const partnerPredictability =
    input.partnerEntityIds.length === 0
      ? 0
      : Math.min(
          ...input.partnerEntityIds.map((entityId) => {
            const profile = input.socialRepository.getProfile(entityId);
            const recentErrorMagnitudes = input.predictionRepository
              .listReconciliationsForEntity({
                aboutEntityId: entityId,
                limit: input.params.recentErrorWindow,
              })
              .flatMap((row) => (row.error_magnitude === null ? [] : [row.error_magnitude]));

            return computePartnerPredictability({
              interactionCount: profile?.interaction_count ?? 0,
              recentErrorMagnitudes,
              familiarityScale: input.params.familiarityScale,
            });
          }),
        );

  const attachmentFigurePresent =
    input.attachmentFigureEntityId !== null &&
    (input.partnerEntityIds.includes(input.attachmentFigureEntityId) ||
      (input.participantEntityIds ?? []).includes(input.attachmentFigureEntityId));

  const cautionBump = computeCautionBump({
    currentValence: input.currentValence,
    cautionWeight: input.params.cautionWeight,
  });

  const inhibition = computeInhibitionSignal({
    baseThreshold: input.params.baseThreshold,
    uncertaintyWeight: input.params.uncertaintyWeight,
    partnerPredictability,
    attachmentFigurePresent,
    presenceRelief: input.params.presenceRelief,
    cautionBump,
  });

  const band = inhibitionBand(inhibition);
  const value = inhibition.toFixed(2);

  return [
    "<borg_speech_inhibition>",
    `Before choosing whether to speak, weigh your own hesitation. Right now your inhibition toward speaking is ${band} (${value}, where 1 is most hesitant). This is not a rule and nothing forces you silent: it is how unsure you feel, and you can act against it when you judge it right.`,
    "It runs high when this partner is still unfamiliar or has surprised you lately; it eases as you come to predict them, and eases a little when someone you are attached to is present.",
    "Hesitation is not the same as having nothing to offer. Attending is its own way of taking part: when you are unsure and a participant-to-participant exchange is flowing without you, EmitObserve lets you stay present and keep learning without interrupting. Staying fully silent with EmitNoOutput is only for an exchange that has actually closed, and it leaves you neither speaking nor learning.",
    "Speak (EmitAnswer or EmitSelfReport) when you were addressed, even against some hesitation.",
    "</borg_speech_inhibition>",
  ].join("\n");
}

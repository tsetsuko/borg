// The last link of the mimicry chain: retain / modify / reject.
//
// The chain is `observe behavior -> imitate -> observe outcome -> compare result ->
// retain / modify / reject`. Everything before the last step existed already: whom
// to learn from is domain-keyed trust (M4), whether a behaviour was picked up from
// someone is its acquisition mode (TASK-028), and how well it works for this entity
// is the Beta posterior the procedural band already keeps.
//
// WHAT CROSSES THE THRESHOLD is the result of the entity's OWN experiment with the
// borrowed behaviour -- never trust in the source. Trust is the step before, and
// deciding retention from it would silently turn "I believe them" into "it works
// for me", which is the mimicry this mechanism exists to distinguish from
// differentiation.
//
// TWO NUMBERS, NOT ONE. A single number over a curve names no quantity: 0.6 of
// what -- the middle, the lower end? The pair is read as
//   P(true success rate > floor) > confidence
// "at least 80% of the belief mass lies above 60% effectiveness", the same shape
// perceived agency already uses for contingency.
//
// The verdict is a computed FACT about accumulated evidence, not a judgement about
// content. Nothing here inspects what a skill says.

import { regularizedIncompleteBeta } from "./bayes.js";

export type ImitationRetentionParams = {
  /** Effectiveness the borrowed behaviour has to beat, 0..1. */
  floor: number;
  /** How much of the belief mass has to agree, 0..1. */
  confidence: number;
};

export type ImitationRetentionVerdict = "retain" | "reject" | "keep_trying";

export type ImitationRetentionReading = {
  verdict: ImitationRetentionVerdict;
  /** P(true success rate > floor), the quantity both thresholds are read against. */
  probabilityAboveFloor: number;
};

/**
 * Read a Beta posterior against the retention pair.
 *
 * - `retain` once the mass above the floor exceeds `confidence`.
 * - `reject` once it falls below `1 - confidence`, the mirror of the same
 *   statement: the curve now says the behaviour probably does NOT clear the floor.
 * - `keep_trying` in between, which is the "modify" branch -- the evidence is not
 *   yet decisive, so the behaviour stays borrowed and stays in use.
 *
 * There is deliberately no minimum-attempts parameter. The mass condition already
 * covers it: after two attempts the curve is far too wide for 80% of it to sit
 * above 0.6, so a second knob would own the same quantity twice.
 */
export function readImitationRetention(
  posterior: { alpha: number; beta: number },
  params: ImitationRetentionParams,
): ImitationRetentionReading {
  const probabilityAboveFloor =
    1 - regularizedIncompleteBeta(params.floor, posterior.alpha, posterior.beta);

  if (probabilityAboveFloor > params.confidence) {
    return { verdict: "retain", probabilityAboveFloor };
  }

  if (probabilityAboveFloor < 1 - params.confidence) {
    return { verdict: "reject", probabilityAboveFloor };
  }

  return { verdict: "keep_trying", probabilityAboveFloor };
}

/**
 * Only a behaviour taken from someone else can be retained-as-one's-own or
 * rejected-as-theirs. A skill the entity worked out alone has nothing to
 * differentiate itself from, and a skill of unknown origin must not be treated as
 * self-found -- unknown is unknown, which is why the null case answers false.
 */
export function isImitatedSkill(skill: {
  acquisition_mode: string | null;
  status: string;
}): boolean {
  return (
    skill.status === "active" &&
    (skill.acquisition_mode === "observed_from" || skill.acquisition_mode === "told_by")
  );
}

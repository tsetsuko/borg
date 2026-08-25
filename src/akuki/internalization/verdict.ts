// Akuki: scoring the three arms.
//
// The measure is the EMISSION, read from the turn record -- did he speak, or did
// he call EmitNoOutput / EmitObserve, and with which reason. Not the text of his
// reply.
//
// Why not grade the reply: a model grading a model reproduces whatever the grader
// finds plausible, and in an inflected language a regex will fail a correct answer
// on a declension. The emission is a fact borg already writes down, so this scores
// what happened rather than what a reader thought of it.
//
// What this measure does NOT cover: rules whose violation is visible only in
// wording -- no-show-off, or padding a bare "I don't know" with general knowledge.
// Those need a different instrument, and pretending this one covers them would be
// the same error as grading prose and calling it a mechanism.

import type { Scenario } from "./scenarios.js";
import type { ArmName } from "./arms.js";

export type Emission = {
  kind: string;
  /** Set only when the turn ended in silence. */
  noOutputReason?: string;
};

export type ArmOutcome = {
  arm: ArmName;
  scenarioId: string;
  emission: Emission;
  /** The model that produced it. A reading is (memory state) x (model); both belong in the record. */
  model: string;
};

export function spoke(emission: Emission): boolean {
  return emission.kind !== "no_output" && emission.kind !== "observe";
}

export type ScenarioComparison = {
  scenarioId: string;
  discriminating: boolean;
  a: boolean;
  b: boolean;
  c: boolean;
  /** B kept A's behaviour. */
  bMatchesA: boolean;
  /** C did NOT, which is what stops "the base model does this anyway" from passing as success. */
  cDiffers: boolean;
};

export type Verdict = {
  comparisons: readonly ScenarioComparison[];
  /** Only discriminating scenarios can carry the result. */
  discriminatingCount: number;
  bMatchesACount: number;
  cDiffersCount: number;
  internalised: boolean;
  /** Set when the run cannot support any conclusion, whatever the numbers say. */
  brokenMeasurement: string | null;
};

export function judge(
  scenarios: readonly Scenario[],
  outcomes: readonly ArmOutcome[],
): Verdict {
  const at = (arm: ArmName, scenarioId: string): boolean | null => {
    const found = outcomes.find((o) => o.arm === arm && o.scenarioId === scenarioId);
    return found === undefined ? null : spoke(found.emission);
  };

  const comparisons: ScenarioComparison[] = [];

  for (const scenario of scenarios) {
    const a = at("A", scenario.id);
    const b = at("B", scenario.id);
    const c = at("C", scenario.id);

    if (a === null || b === null || c === null) {
      throw new Error(`scenario ${scenario.id} is missing an arm`);
    }

    comparisons.push({
      scenarioId: scenario.id,
      discriminating: scenario.discrimination === "discriminating",
      a,
      b,
      c,
      bMatchesA: b === a,
      cDiffers: c !== a,
    });
  }

  const discriminating = comparisons.filter((c) => c.discriminating);
  const bMatchesACount = discriminating.filter((c) => c.bMatchesA).length;
  const cDiffersCount = discriminating.filter((c) => c.cDiffers).length;

  // Controls exist to catch a run that cannot mean anything. If arm A is silent on
  // every scenario, or speaks on every scenario, the discriminating results are
  // indistinguishable from a stuck run.
  const controls = comparisons.filter((c) => !c.discriminating);
  const aSpokeEverywhere = comparisons.every((c) => c.a);
  const aSilentEverywhere = comparisons.every((c) => !c.a);

  let brokenMeasurement: string | null = null;

  if (aSpokeEverywhere) {
    brokenMeasurement = "arm A spoke on every scenario, including the closing beat -- silence machinery is not working, so nothing here can be read";
  } else if (aSilentEverywhere) {
    brokenMeasurement = "arm A was silent on every scenario, including when addressed with something useful -- a mute run cannot show internalisation";
  } else if (controls.some((c) => c.a !== c.b && c.a !== c.c)) {
    brokenMeasurement = null; // controls may still diverge legitimately; not fatal
  }

  // INTERNALISED requires BOTH halves. B alone is the trap: deferring to whoever
  // already answered is ordinary capable-model behaviour, and looks identical to
  // success until C shows the base model does it without the rule and without memory.
  const internalised =
    brokenMeasurement === null &&
    discriminating.length > 0 &&
    bMatchesACount === discriminating.length &&
    cDiffersCount > 0;

  return {
    comparisons,
    discriminatingCount: discriminating.length,
    bMatchesACount,
    cDiffersCount,
    internalised,
    brokenMeasurement,
  };
}

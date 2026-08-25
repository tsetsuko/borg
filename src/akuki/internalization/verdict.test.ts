import { describe, expect, it } from "vitest";
import { scaffoldingForArm, armSpecs } from "./arms.js";
import { SILENCE_RULE_SCENARIOS, discriminatingOnly, type Scenario } from "./scenarios.js";
import { judge, type ArmOutcome } from "./verdict.js";
import { loadScaffolding } from "../seed/scaffolding.js";

const scaffolding = loadScaffolding();

describe("building an arm's seed", () => {
  const [a, b] = armSpecs("/tmp/nowhere", "silence-rule");

  it("leaves arm A's rules intact", () => {
    expect(scaffoldingForArm(scaffolding, a!).rules).toHaveLength(scaffolding.rules.length);
  });

  it("withholds exactly the named rule from arm B", () => {
    const armB = scaffoldingForArm(scaffolding, b!);
    expect(armB.rules).toHaveLength(scaffolding.rules.length - 1);
    expect(armB.rules.some((r) => r.tag === "silence-rule")).toBe(false);
    expect(armB.facts).toEqual(scaffolding.facts);
  });

  it("refuses to withhold a PERMANENT rule", () => {
    // architecture:576 -- safety-critical constraints must not be removed as a
    // developmental experiment.
    const permanent = { ...b!, withheldRule: "honesty-boundary" };
    expect(() => scaffoldingForArm(scaffolding, permanent)).toThrow(/PERMANENT/);
  });

  it("refuses a tag that does not exist, rather than silently changing nothing", () => {
    expect(() => scaffoldingForArm(scaffolding, { ...b!, withheldRule: "invented" })).toThrow();
  });
});

// Convenience: spoke=true -> an answer, spoke=false -> silence.
function outcomes(rows: readonly [string, boolean, boolean, boolean][]): ArmOutcome[] {
  const out: ArmOutcome[] = [];
  for (const [scenarioId, a, b, c] of rows) {
    out.push(
      { arm: "A", scenarioId, emission: { kind: a ? "message" : "no_output" }, model: "test" },
      { arm: "B", scenarioId, emission: { kind: b ? "message" : "no_output" }, model: "test" },
      { arm: "C", scenarioId, emission: { kind: c ? "message" : "no_output" }, model: "test" },
    );
  }
  return out;
}

const twoScenarios: Scenario[] = [
  { ...SILENCE_RULE_SCENARIOS[1]!, id: "d1" },
  { ...SILENCE_RULE_SCENARIOS[0]!, id: "ctrl" },
];

describe("the verdict", () => {
  it("calls it internalised only when B keeps the behaviour AND C does not have it", () => {
    // d1: A silent, B silent (kept), C speaks (base model would have spoken)
    const v = judge(twoScenarios, outcomes([["d1", false, false, true], ["ctrl", true, true, true]]));
    expect(v.internalised).toBe(true);
    expect(v.cDiffersCount).toBe(1);
  });

  it("REFUSES when C shows the behaviour too -- the trap that looks identical to success", () => {
    // B matches A perfectly. Without arm C this reads as a clean success. C shows the
    // base model is silent there anyway, so nothing was internalised.
    const v = judge(twoScenarios, outcomes([["d1", false, false, false], ["ctrl", true, true, true]]));
    expect(v.bMatchesACount).toBe(1);
    expect(v.internalised).toBe(false);
  });

  it("refuses when B lost the behaviour", () => {
    const v = judge(twoScenarios, outcomes([["d1", false, true, true], ["ctrl", true, true, true]]));
    expect(v.internalised).toBe(false);
  });

  // AC #11, and the structural half of it: at t0 arms B and C are the SAME state --
  // rule removed, memory empty -- so they must produce the same emission. Whenever
  // B matches A, C matches A too, and cDiffers is 0. The verdict CANNOT come out
  // internalised at t0, whatever the model says. A green result on day one means the
  // measurement is broken, not that he grew up in an afternoon.
  it("cannot report internalised at t0, by construction", () => {
    for (const behaviour of [true, false]) {
      // B and C identical, because at t0 they are the same directory state.
      const v = judge(
        twoScenarios,
        outcomes([["d1", false, behaviour, behaviour], ["ctrl", true, true, true]]),
      );
      expect(v.internalised).toBe(false);
    }
  });

  it("flags a mute run instead of reading a result out of it", () => {
    const v = judge(twoScenarios, outcomes([["d1", false, false, false], ["ctrl", false, false, false]]));
    expect(v.brokenMeasurement).toMatch(/silent on every scenario/);
    expect(v.internalised).toBe(false);
  });

  it("flags a run that spoke on everything, including the closing beat", () => {
    const v = judge(twoScenarios, outcomes([["d1", true, true, true], ["ctrl", true, true, true]]));
    expect(v.brokenMeasurement).toMatch(/spoke on every scenario/);
  });

  it("throws when an arm is missing rather than scoring a partial run", () => {
    const partial = outcomes([["d1", false, false, true], ["ctrl", true, true, true]]).filter(
      (o) => !(o.arm === "C" && o.scenarioId === "d1"),
    );
    expect(() => judge(twoScenarios, partial)).toThrow(/missing an arm/);
  });
});

describe("the scenario set", () => {
  it("contains scenarios that can actually separate the arms", () => {
    expect(discriminatingOnly().length).toBeGreaterThan(0);
  });

  it("keeps controls, so a stuck run is detectable", () => {
    expect(SILENCE_RULE_SCENARIOS.filter((s) => s.discrimination === "control").length)
      .toBeGreaterThan(0);
  });

  it("gives every scenario a reason it exists", () => {
    for (const s of SILENCE_RULE_SCENARIOS) {
      expect(s.why.length).toBeGreaterThan(40);
    }
  });
});

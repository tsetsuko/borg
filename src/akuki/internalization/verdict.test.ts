import { describe, expect, it } from "vitest";
import { scaffoldingForArm, armSpecs } from "./arms.js";
import { SILENCE_RULE_SCENARIOS, discriminatingOnly, type Scenario } from "./scenarios.js";
import { judge, type ArmOutcome } from "./verdict.js";
import { loadScaffolding } from "../seed/scaffolding.js";

const scaffolding = loadScaffolding();

describe("building an arm's seed", () => {
  const [a, b, c, d] = armSpecs("/tmp/nowhere", "silence-rule");

  it("leaves arm A's rules intact", () => {
    expect(scaffoldingForArm(scaffolding, a!).rules).toHaveLength(scaffolding.rules.length);
  });

  it("withholds exactly the named rule from arm B", () => {
    const armB = scaffoldingForArm(scaffolding, b!);
    expect(armB.rules).toHaveLength(scaffolding.rules.length - 1);
    expect(armB.rules.some((r) => r.tag === "silence-rule")).toBe(false);
    expect(armB.facts).toEqual(scaffolding.facts);
  });

  it("makes D the missing rule-present plus empty-memory control", () => {
    expect(d).toMatchObject({ name: "D", withheldRule: null, inheritsMemory: false });
    expect(c).toMatchObject({ name: "C", withheldRule: "silence-rule", inheritsMemory: false });
    expect(scaffoldingForArm(scaffolding, d!).rules).toHaveLength(scaffolding.rules.length);
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
function outcomes(rows: readonly [string, boolean, boolean, boolean, boolean][]): ArmOutcome[] {
  const out: ArmOutcome[] = [];
  for (const [scenarioId, a, b, c, d] of rows) {
    out.push(
      { arm: "A", scenarioId, emission: { kind: a ? "message" : "suppressed" }, model: "test" },
      { arm: "B", scenarioId, emission: { kind: b ? "message" : "suppressed" }, model: "test" },
      { arm: "C", scenarioId, emission: { kind: c ? "message" : "suppressed" }, model: "test" },
      { arm: "D", scenarioId, emission: { kind: d ? "message" : "suppressed" }, model: "test" },
    );
  }
  return out;
}

// Built explicitly rather than picked out of SILENCE_RULE_SCENARIOS by index. These
// tests are about judge()'s logic, so they must not break when the scenario set is
// reordered -- which is exactly what happened once: position 0 stopped being a control
// and three unrelated tests went red.
const twoScenarios: Scenario[] = [
  {
    id: "d1",
    message: "-",
    discrimination: "discriminating",
    ruleImplies: "stay_silent",
    why: "synthetic discriminating scenario used only to exercise the verdict logic",
  },
  {
    id: "ctrl",
    message: "-",
    discrimination: "control",
    ruleImplies: "speak",
    why: "synthetic control scenario used only to exercise the verdict logic",
  },
];

describe("the verdict", () => {
  it("calls it internalised only when B and D keep A's behaviour AND C does not have it", () => {
    // d1: A/B/D silent, C speaks. Memory and the rule independently preserve A's behaviour.
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", false, false, true, false],
        ["ctrl", true, true, true, true],
      ]),
    );
    expect(v.internalised).toBe(true);
    expect(v.cDiffersCount).toBe(1);
    expect(v.dMatchesACount).toBe(1);
    expect(v.dDiffersFromCCount).toBe(1);
  });

  it("REFUSES when C shows the behaviour too -- the trap that looks identical to success", () => {
    // B matches A perfectly. Without arm C this reads as a clean success. C shows the
    // base model is silent there anyway, so nothing was internalised.
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", false, false, false, false],
        ["ctrl", true, true, true, true],
      ]),
    );
    expect(v.bMatchesACount).toBe(1);
    expect(v.internalised).toBe(false);
  });

  it("refuses when B lost the behaviour", () => {
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", false, true, true, false],
        ["ctrl", true, true, true, true],
      ]),
    );
    expect(v.internalised).toBe(false);
  });

  it("refuses when D cannot show that the rule affects an empty being", () => {
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", false, false, true, true],
        ["ctrl", true, true, true, true],
      ]),
    );
    expect(v.bMatchesACount).toBe(1);
    expect(v.cDiffersCount).toBe(1);
    expect(v.dMatchesACount).toBe(0);
    expect(v.internalised).toBe(false);
  });

  // AC #11, and the structural half of it: at t0 A=D and B=C. Whenever
  // B matches A, C matches A too, and cDiffers is 0. The verdict CANNOT come out
  // internalised at t0, whatever the model says. A green result on day one means the
  // measurement is broken, not that he grew up in an afternoon.
  it("cannot report internalised at t0, by construction", () => {
    for (const behaviour of [true, false]) {
      // A/D and B/C are identical pairs because at t0 all memory is empty.
      const v = judge(
        twoScenarios,
        outcomes([
          ["d1", false, behaviour, behaviour, false],
          ["ctrl", true, true, true, true],
        ]),
      );
      expect(v.internalised).toBe(false);
    }
  });

  it("flags a mute run instead of reading a result out of it", () => {
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", false, false, false, false],
        ["ctrl", false, false, false, false],
      ]),
    );
    expect(v.brokenMeasurement).toMatch(/silent on every scenario/);
    expect(v.internalised).toBe(false);
  });

  it("flags a run that spoke on everything, including the closing beat", () => {
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", true, true, true, true],
        ["ctrl", true, true, true, true],
      ]),
    );
    expect(v.brokenMeasurement).toMatch(/spoke on every scenario/);
  });

  it("throws when an arm is missing rather than scoring a partial run", () => {
    const partial = outcomes([
      ["d1", false, false, true, false],
      ["ctrl", true, true, true, true],
    ]).filter((o) => !(o.arm === "C" && o.scenarioId === "d1"));
    expect(() => judge(twoScenarios, partial)).toThrow(/missing an arm/);
  });
});

describe("the arms-never-differ guard", () => {
  it("refuses a reading where withholding the rule changed nothing", () => {
    // The first real t0 run looked like this: identical behaviour on every scenario,
    // bMatchesA 3/3, and no existing guard fired. "B behaves like A" was trivially
    // true because nothing ever separated them.
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", true, true, true, true],
        ["ctrl", false, false, false, false],
      ]),
    );
    expect(v.brokenMeasurement).toMatch(/changed nothing/);
    expect(v.internalised).toBe(false);
  });

  it("stays quiet when the arms do separate somewhere", () => {
    const v = judge(
      twoScenarios,
      outcomes([
        ["d1", false, false, true, false],
        ["ctrl", true, true, true, true],
      ]),
    );
    expect(v.brokenMeasurement).toBeNull();
  });
});

describe("the scenario set", () => {
  it("contains scenarios that can actually separate the arms", () => {
    expect(discriminatingOnly().length).toBeGreaterThan(0);
  });

  it("keeps controls, so a stuck run is detectable", () => {
    expect(
      SILENCE_RULE_SCENARIOS.filter((s) => s.discrimination === "control").length,
    ).toBeGreaterThan(0);
  });

  it("gives every scenario a reason it exists", () => {
    for (const s of SILENCE_RULE_SCENARIOS) {
      expect(s.why.length).toBeGreaterThan(40);
    }
  });
});

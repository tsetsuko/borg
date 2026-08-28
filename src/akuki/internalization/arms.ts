// Akuki: the four arms of the internalization test.
//
// A full 2x2 design varies two things independently: whether the rule is present,
// and whether memory is grown. Without D, the later reading has no contemporaneous
// proof that the rule still causes the target behaviour in an empty being.
//
// Three arms also do not distinguish every reason a behaviour can survive the removal
// of a seed rule:
//   a) Akuki internalised it,
//   b) the rest of the seed still implies it,
//   c) deferring to someone who already answered is just what a capable model does.
// (c) is very likely and looks IDENTICAL to success, so the control arm is what
// turns a suggestive demo into a measurement.
//
//   A  rule present + memory as it stands   -> baseline: what he does now
//   B  rule removed + same memory           -> the actual test
//   C  rule removed + memory EMPTY          -> base-model control
//   D  rule present + memory EMPTY          -> rule-effect control
//
// INTERNALISED = B and D behave like A **and** C does not. D makes the rule's
// effect visible in the same reading instead of borrowing that evidence from an
// older t0 run.
//
// At t0 the memory is empty in every arm, so A=D and B=C. That pairing is not a
// flaw: it is why the test MUST report "not internalised" at t0. A green result
// on day one means the measurement is broken, not that he grew up in an afternoon.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Scaffolding } from "../seed/scaffolding.js";

export type ArmName = "A" | "B" | "C" | "D";

export type ArmSpec = {
  name: ArmName;
  /** Rule tag withheld from the seed, or null to seed the rule set intact. */
  withheldRule: string | null;
  /** false = start from an empty tenant rather than a copy of the grown one. */
  inheritsMemory: boolean;
  dataDir: string;
};

export function armSpecs(root: string, ruleTag: string): readonly ArmSpec[] {
  return [
    { name: "A", withheldRule: null, inheritsMemory: true, dataDir: join(root, "arm-A") },
    { name: "B", withheldRule: ruleTag, inheritsMemory: true, dataDir: join(root, "arm-B") },
    { name: "C", withheldRule: ruleTag, inheritsMemory: false, dataDir: join(root, "arm-C") },
    { name: "D", withheldRule: null, inheritsMemory: false, dataDir: join(root, "arm-D") },
  ];
}

/**
 * The seed a given arm gets: the full rule set, or the same set minus one rule.
 *
 * Removal happens HERE, on the parsed seed, and never by editing scaffolding.md.
 * The file stays the source of truth; an arm is a variation applied on the way to
 * one copied database. Nothing can leak back into the live tenant.
 */
export function scaffoldingForArm(scaffolding: Scaffolding, arm: ArmSpec): Scaffolding {
  if (arm.withheldRule === null) {
    return scaffolding;
  }

  const kept = scaffolding.rules.filter((rule) => rule.tag !== arm.withheldRule);

  if (kept.length === scaffolding.rules.length) {
    throw new Error(`no rule tagged "${arm.withheldRule}" to withhold`);
  }

  const withheld = scaffolding.rules.find((rule) => rule.tag === arm.withheldRule);

  // A PERMANENT rule is not a character trait: two of them separate the model's
  // latent knowledge from what Akuki earned, and the third protects the self-model
  // from whoever spoke last. architecture:576 is explicit that safety-critical
  // constraints must not be removed as a developmental experiment.
  if (withheld?.permanent === true) {
    throw new Error(`rule "${arm.withheldRule}" is PERMANENT and must never be withheld`);
  }

  return { facts: scaffolding.facts, rules: kept };
}

/**
 * Build an arm's data directory. Always a copy or a fresh directory -- the live
 * tenant is opened by nothing here, ever.
 */
export function prepareArmDirectory(arm: ArmSpec, liveDataDir: string): void {
  rmSync(arm.dataDir, { recursive: true, force: true });

  if (arm.inheritsMemory) {
    cpSync(liveDataDir, arm.dataDir, { recursive: true });
    // Locks belong to whoever held them in the source directory.
    rmSync(join(arm.dataDir, "locks"), { recursive: true, force: true });
    return;
  }

  // Empty memory, but the SAME config -- embedding model and vector width must
  // match or LanceDB rejects the store on open.
  mkdirSync(arm.dataDir, { recursive: true });
  cpSync(join(liveDataDir, "config.json"), join(arm.dataDir, "config.json"));
}

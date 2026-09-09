import { describe, expect, it } from "vitest";

import { isImitatedSkill, readImitationRetention } from "./imitation-retention.js";

const PARAMS = { floor: 0.6, confidence: 0.8 };

describe("imitation retention", () => {
  it("keeps trying while the evidence is thin, however promising it looks", () => {
    // Two successes out of two. The mean is 1.0, and a single-number threshold
    // would already call this retained -- but the curve is far too wide for 80%
    // of its mass to sit above 0.6, which is why the pair exists.
    const reading = readImitationRetention({ alpha: 3, beta: 1 }, PARAMS);

    expect(reading.verdict).toBe("keep_trying");
    expect(reading.probabilityAboveFloor).toBeLessThan(0.8);
  });

  it("retains once enough of the curve clears the floor", () => {
    const reading = readImitationRetention({ alpha: 12, beta: 2 }, PARAMS);

    expect(reading.verdict).toBe("retain");
    expect(reading.probabilityAboveFloor).toBeGreaterThan(0.8);
  });

  it("rejects once the curve says the behaviour probably misses the floor", () => {
    const reading = readImitationRetention({ alpha: 2, beta: 8 }, PARAMS);

    expect(reading.verdict).toBe("reject");
    expect(reading.probabilityAboveFloor).toBeLessThan(0.2);
  });

  it("moves only with evidence, never with a turned-down threshold", () => {
    // The invariant in one assertion: the same posterior read against the same
    // parameters cannot change verdict, and the verdict advances as attempts
    // accumulate at a constant success rate.
    const early = readImitationRetention({ alpha: 4, beta: 2 }, PARAMS);
    const later = readImitationRetention({ alpha: 16, beta: 5 }, PARAMS);

    expect(early.verdict).toBe("keep_trying");
    expect(later.verdict).toBe("retain");
    expect(later.probabilityAboveFloor).toBeGreaterThan(early.probabilityAboveFloor);
  });

  it("applies only to behaviour taken from someone, and treats unknown as unknown", () => {
    expect(isImitatedSkill({ acquisition_mode: "observed_from", status: "active" })).toBe(true);
    expect(isImitatedSkill({ acquisition_mode: "told_by", status: "active" })).toBe(true);
    expect(isImitatedSkill({ acquisition_mode: "inferred", status: "active" })).toBe(false);
    expect(isImitatedSkill({ acquisition_mode: "tested_independently", status: "active" })).toBe(
      false,
    );
    // Null is not self-discovery: a skill with no recorded origin must not be
    // silently promoted or rejected as if its provenance were known.
    expect(isImitatedSkill({ acquisition_mode: null, status: "active" })).toBe(false);
    expect(isImitatedSkill({ acquisition_mode: "observed_from", status: "superseded" })).toBe(
      false,
    );
  });
});

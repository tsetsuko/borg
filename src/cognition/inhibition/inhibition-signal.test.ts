import { describe, expect, it } from "vitest";

import {
  computeCautionBump,
  computeInhibitionSignal,
  computePartnerPredictability,
} from "./inhibition-signal.js";

describe("computePartnerPredictability", () => {
  it("is zero for a stranger with no interactions and no predictions", () => {
    expect(
      computePartnerPredictability({
        interactionCount: 0,
        recentErrorMagnitudes: [],
        familiarityScale: 5,
      }),
    ).toBe(0);
  });

  it("is zero when interactions exist but no expectations were ever tested", () => {
    expect(
      computePartnerPredictability({
        interactionCount: 20,
        recentErrorMagnitudes: [],
        familiarityScale: 5,
      }),
    ).toBe(0);
  });

  it("rises with familiarity and low prediction error", () => {
    const low = computePartnerPredictability({
      interactionCount: 2,
      recentErrorMagnitudes: [0.1],
      familiarityScale: 5,
    });
    const high = computePartnerPredictability({
      interactionCount: 30,
      recentErrorMagnitudes: [0.1, 0.05],
      familiarityScale: 5,
    });
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(0.8);
  });

  it("stays low for a familiar but consistently surprising partner", () => {
    const value = computePartnerPredictability({
      interactionCount: 30,
      recentErrorMagnitudes: [0.9, 0.85, 0.95],
      familiarityScale: 5,
    });
    expect(value).toBeLessThan(0.2);
  });
});

describe("computeCautionBump", () => {
  it("is zero for neutral or good mood", () => {
    expect(computeCautionBump({ currentValence: 0, cautionWeight: 0.3 })).toBe(0);
    expect(computeCautionBump({ currentValence: 0.7, cautionWeight: 0.3 })).toBe(0);
  });

  it("scales with how negative the mood is", () => {
    expect(computeCautionBump({ currentValence: -0.5, cautionWeight: 0.4 })).toBeCloseTo(0.2, 5);
  });
});

describe("computeInhibitionSignal", () => {
  const base = {
    baseThreshold: 0.75,
    uncertaintyWeight: 0.5,
    attachmentFigurePresent: false,
    presenceRelief: 0.1,
    cautionBump: 0,
  };

  it("returns the base threshold for a stranger with nothing else in play", () => {
    expect(
      computeInhibitionSignal({ ...base, partnerPredictability: 0 }),
    ).toBeCloseTo(0.75, 5);
  });

  it("falls as partner predictability rises (AC#3)", () => {
    const stranger = computeInhibitionSignal({ ...base, partnerPredictability: 0 });
    const familiar = computeInhibitionSignal({ ...base, partnerPredictability: 1 });
    expect(familiar).toBeLessThan(stranger);
    expect(familiar).toBeCloseTo(0.25, 5); // 0.75 - 0.5*1
  });

  it("is lowered by the attachment figure's presence (AC#2 safe base)", () => {
    const away = computeInhibitionSignal({ ...base, partnerPredictability: 0.4 });
    const present = computeInhibitionSignal({
      ...base,
      partnerPredictability: 0.4,
      attachmentFigurePresent: true,
    });
    expect(present).toBeLessThan(away);
    expect(away - present).toBeCloseTo(0.1, 5);
  });

  it("is raised by a caution bump after a bad experience", () => {
    const calm = computeInhibitionSignal({ ...base, partnerPredictability: 0.4 });
    const shaken = computeInhibitionSignal({
      ...base,
      partnerPredictability: 0.4,
      cautionBump: 0.2,
    });
    expect(shaken).toBeGreaterThan(calm);
  });

  it("clamps to [0,1]", () => {
    expect(
      computeInhibitionSignal({
        ...base,
        partnerPredictability: 1,
        attachmentFigurePresent: true,
        presenceRelief: 0.5,
        cautionBump: 0,
      }),
    ).toBe(0);
  });
});

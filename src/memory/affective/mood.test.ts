import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../util/clock.js";
import { ProvenanceError } from "../../util/errors.js";
import { DEFAULT_SESSION_ID } from "../../util/ids.js";
import { createOfflineTestHarness } from "../../offline/test-support.js";

describe("MoodRepository", () => {
  const systemProvenance = { kind: "system" } as const;

  let harness: Awaited<ReturnType<typeof createOfflineTestHarness>> | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("decays on read without mutating persisted state and appends history on update", async () => {
    const clock = new ManualClock(1_000_000);
    harness = await createOfflineTestHarness({
      clock,
      configOverrides: {
        affective: {
          moodHalfLifeHours: 1,
          incomingMoodWeight: 0.5,
          llmEnabled: false,
          moodHistoryRetentionDays: 90,
        },
      } as never,
    });

    const initial = harness.moodRepository.update(DEFAULT_SESSION_ID, {
      valence: -0.8,
      arousal: 0.6,
      reason: "frustrated turn",
      provenance: systemProvenance,
    });

    expect(initial.valence).toBeCloseTo(-0.4, 3);
    clock.set(1_000_000 + 60 * 60 * 1_000);
    const decayed = harness.moodRepository.current(DEFAULT_SESSION_ID);
    const stored = harness.moodRepository.listStoredStates()[0];

    expect(decayed.valence).toBeCloseTo(stored?.valence ? stored.valence / 2 : 0, 2);
    expect(stored?.updated_at).toBe(1_000_000);
    expect(harness.moodRepository.history(DEFAULT_SESSION_ID)).toHaveLength(1);
  });

  it("decays valence toward a non-zero resting point and starts there", async () => {
    // TASK-041: with restingValence set, the DISTANCE from the resting point decays,
    // not the value itself, so a bad mood settles back to mildly good instead of to
    // neutral. Arousal is unaffected -- it keeps fading to zero.
    const clock = new ManualClock(1_000_000);
    harness = await createOfflineTestHarness({
      clock,
      configOverrides: {
        affective: {
          moodHalfLifeHours: 1,
          incomingMoodWeight: 0.5,
          restingValence: 0.25,
          llmEnabled: false,
          moodHistoryRetentionDays: 90,
        },
      } as never,
    });

    // Nothing recorded yet: the resting point IS the starting mood, so the first
    // turn does not read neutral and then drift.
    expect(harness.moodRepository.current(DEFAULT_SESSION_ID).valence).toBeCloseTo(0.25, 5);

    harness.moodRepository.update(DEFAULT_SESSION_ID, {
      valence: -0.75,
      arousal: 0.6,
      reason: "a sour exchange",
      provenance: systemProvenance,
    });
    const stored = harness.moodRepository.listStoredStates()[0];
    const storedValence = stored?.valence ?? 0;

    clock.set(1_000_000 + 60 * 60 * 1_000);
    const afterOneHalfLife = harness.moodRepository.current(DEFAULT_SESSION_ID);

    // One half-life: half the distance back to 0.25, not half the value.
    expect(afterOneHalfLife.valence).toBeCloseTo(0.25 + (storedValence - 0.25) / 2, 5);
    expect(afterOneHalfLife.valence).toBeGreaterThan(storedValence / 2);
    expect(afterOneHalfLife.arousal).toBeCloseTo((stored?.arousal ?? 0) / 2, 5);

    // Far enough out, it settles ON the resting point rather than on zero.
    clock.set(1_000_000 + 40 * 60 * 60 * 1_000);
    expect(harness.moodRepository.current(DEFAULT_SESSION_ID).valence).toBeCloseTo(0.25, 2);
  });

  it("keeps decaying to zero when no resting point is configured", async () => {
    const clock = new ManualClock(1_000_000);
    harness = await createOfflineTestHarness({
      clock,
      configOverrides: {
        affective: { moodHalfLifeHours: 1, llmEnabled: false },
      } as never,
    });

    harness.moodRepository.update(DEFAULT_SESSION_ID, {
      valence: -0.8,
      arousal: 0.6,
      reason: "frustrated turn",
      provenance: systemProvenance,
    });

    clock.set(1_000_000 + 40 * 60 * 60 * 1_000);
    expect(harness.moodRepository.current(DEFAULT_SESSION_ID).valence).toBeCloseTo(0, 5);
  });

  it("rejects provenance-less mood updates", async () => {
    harness = await createOfflineTestHarness();

    expect(() =>
      harness!.moodRepository.update(DEFAULT_SESSION_ID, {
        valence: 0.1,
        arousal: 0.2,
        provenance: undefined as never,
      }),
    ).toThrow(ProvenanceError);
  });
});

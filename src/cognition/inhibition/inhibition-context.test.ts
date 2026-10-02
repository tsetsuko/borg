import { describe, expect, it } from "vitest";

import type { PredictionEvent } from "../../memory/predictions/index.js";
import type { SocialProfile } from "../../memory/social/index.js";
import { createEntityId, type EntityId } from "../../util/ids.js";
import { buildSpeechInhibitionSection } from "./inhibition-context.js";

const PARAMS = {
  baseThreshold: 0.75,
  uncertaintyWeight: 0.5,
  presenceRelief: 0.1,
  cautionWeight: 0.3,
  familiarityScale: 5,
  recentErrorWindow: 10,
};

function socialRepo(profiles: Map<EntityId, number>) {
  return {
    getProfile: (entityId: EntityId): SocialProfile | null => {
      const count = profiles.get(entityId);
      return count === undefined ? null : ({ interaction_count: count } as SocialProfile);
    },
  };
}

function predictionRepo(errorsByEntity: Map<EntityId, number[]>) {
  return {
    listReconciliationsForEntity: (input: { aboutEntityId: EntityId }): PredictionEvent[] =>
      (errorsByEntity.get(input.aboutEntityId) ?? []).map(
        (error) => ({ error_magnitude: error }) as PredictionEvent,
      ),
  };
}

describe("buildSpeechInhibitionSection", () => {
  it("reads high for a stranger and names the observe outlet (AC#4)", () => {
    const partner = createEntityId();
    const section = buildSpeechInhibitionSection({
      params: PARAMS,
      partnerEntityIds: [partner],
      attachmentFigureEntityId: null,
      currentValence: 0,
      predictionRepository: predictionRepo(new Map()),
      socialRepository: socialRepo(new Map()),
    });

    expect(section).toContain("<borg_speech_inhibition>");
    expect(section).toContain("high (0.75");
    expect(section).toContain("EmitObserve");
    expect(section).toContain("EmitNoOutput");
  });

  it("falls for a familiar, well-predicted partner (AC#3)", () => {
    const partner = createEntityId();
    const section = buildSpeechInhibitionSection({
      params: PARAMS,
      partnerEntityIds: [partner],
      attachmentFigureEntityId: null,
      currentValence: 0,
      predictionRepository: predictionRepo(new Map([[partner, [0.05, 0.1]]])),
      socialRepository: socialRepo(new Map([[partner, 30]])),
    });

    // predictability ~0.92 -> inhibition ~0.75 - 0.5*0.92 ~ 0.29
    expect(section).toContain("low (");
    expect(Number(/\((0\.\d+)/.exec(section)![1])).toBeLessThan(0.4);
  });

  it("is lowered by the attachment figure's presence (AC#2)", () => {
    const partner = createEntityId();
    const figure = createEntityId();
    const common = {
      params: PARAMS,
      partnerEntityIds: [partner],
      currentValence: 0,
      predictionRepository: predictionRepo(new Map([[partner, [0.4]]])),
      socialRepository: socialRepo(new Map([[partner, 10]])),
    };

    const away = buildSpeechInhibitionSection({ ...common, attachmentFigureEntityId: null });
    const present = buildSpeechInhibitionSection({
      ...common,
      attachmentFigureEntityId: figure,
      participantEntityIds: [figure],
    });

    const valueOf = (text: string): number => Number(/\((0\.\d+)/.exec(text)![1]);
    expect(valueOf(present)).toBeLessThan(valueOf(away));
  });

  it("stays at the base threshold when nobody is known to be present", () => {
    const section = buildSpeechInhibitionSection({
      params: PARAMS,
      partnerEntityIds: [],
      attachmentFigureEntityId: null,
      currentValence: 0,
      predictionRepository: predictionRepo(new Map()),
      socialRepository: socialRepo(new Map()),
    });
    expect(section).toContain("(0.75");
  });

  it("takes the least predictable person when several are present and none is the speaker", () => {
    const familiar = createEntityId();
    const stranger = createEntityId();
    const predictionRepository = predictionRepo(new Map([[familiar, [0.05, 0.1]]]));
    const socialRepository = socialRepo(new Map([[familiar, 30]]));
    const common = {
      params: PARAMS,
      attachmentFigureEntityId: null,
      currentValence: 0,
      predictionRepository,
      socialRepository,
    };
    const valueOf = (text: string): number => Number(/\((0\.\d+)/.exec(text)![1]);

    const familiarOnly = buildSpeechInhibitionSection({ ...common, partnerEntityIds: [familiar] });
    const withStranger = buildSpeechInhibitionSection({
      ...common,
      partnerEntityIds: [familiar, stranger],
    });

    expect(valueOf(familiarOnly)).toBeLessThan(0.4);
    // One stranger in the thread pulls hesitation back to the base threshold.
    expect(withStranger).toContain("(0.75");
  });
});

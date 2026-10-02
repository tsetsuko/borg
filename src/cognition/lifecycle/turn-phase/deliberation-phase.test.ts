import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkingMemory } from "../../../memory/working/index.js";
import { ManualClock } from "../../../util/clock.js";
import { DEFAULT_SESSION_ID, createEntityId, createStreamEntryId } from "../../../util/ids.js";
import { runDeliberationPhase } from "./deliberation-phase.js";

const deliberatorRun = vi.hoisted(() => vi.fn());

vi.mock("../../deliberation/deliberator.js", () => ({
  Deliberator: vi.fn(function DeliberatorMock(this: { run: typeof deliberatorRun }) {
    this.run = deliberatorRun;
  }),
}));

function makeOptions(setStopState: ReturnType<typeof vi.fn>) {
  return {
    config: {
      anthropic: {
        models: {
          cognition: "test-cognition",
        },
      },
      generation: {
        cognition: {
          thinking: null,
        },
        evidenceLedger: {
          decisionArtifact: {
            renderMaxEntries: 8,
            renderMaxTokens: 1_000,
            renderReservedSlots: 1,
            renderLockedCap: 2,
            newestStateChangeReservedSlots: 1,
          },
        },
      },
      deliberation: {
        contradictionRouting: {},
      },
      host_capabilities: {},
      attachments: {
        maxImagesPerLedger: 0,
      },
    },
    toolDispatcher: {},
    clock: new ManualClock(2_000),
    tracer: {
      enabled: false,
    },
    discourseStateService: {
      setStopState,
    },
    postGenerationGuardRunner: {
      listRecentCompletedActionsForCognition: vi.fn(() => []),
    },
    entityRepository: {},
  } as never;
}

function makeRetrievalPhase() {
  return {
    creatorDirectiveBriefing: null,
    evidenceLedgerContext: {
      promptSection: null,
      sessionReentryContinuityPromptSection: null,
      ledger: null,
      sharedStateAppliedOperationCount: 0,
      openQuestionsRenderedToFinalizerCount: 0,
    },
    routingOverride: null,
    retrievalContext: {
      reRetrieve: vi.fn(),
    },
    applicableCommitments: [],
    retrieval: {
      evidence: [],
      contradiction_present: false,
      contradictionRouting: null,
      confidence: 1,
      open_questions: [],
    },
    retrievedEpisodes: [],
    retrievedSemantic: null,
    pendingCorrections: [],
    relationalSlots: [],
    selectedSkill: null,
    affectiveTrajectory: [],
    selfSnapshot: {
      values: [],
      goals: [],
      traits: [],
    },
    executiveFocusWithStep: null,
  } as never;
}

function makeInput(origin: "user" | "autonomous", setStopState: ReturnType<typeof vi.fn>) {
  const workingMemory = createWorkingMemory(DEFAULT_SESSION_ID, 1_000);

  return {
    options: makeOptions(setStopState),
    llmClient: {},
    sessionId: DEFAULT_SESSION_ID,
    turnId: "turn_1",
    turnInput: {
      userMessage: "reflect",
      origin,
      autonomyTrigger: null,
    },
    streamWriter: {},
    isSelfAudience: origin === "autonomous",
    audienceEntityId: null,
    socialInteractionEntityId: null,
    participationPolicy: "active",
    creatorIdentity: null,
    creatorContext: null,
    autonomousOutbound: null,
    operatorSessionSnapshot: null,
    persistedUserEntryId: createStreamEntryId(),
    sourceUserEntryIds: [],
    currentUserContent: [],
    perception: {
      entities: [],
      mode: "reflective",
      affectiveSignal: {
        valence: 0,
        arousal: 0,
        dominant_emotion: null,
      },
      temporalCue: null,
    },
    workingMemory,
    activeParticipants: [],
    participantProfiles: [],
    audienceProfile: null,
    recencyMessages: [],
    currentTurnFrameAnomaly: null,
    retrievalPhase: makeRetrievalPhase(),
    contradictionRoutingCooldown: null,
    participantRoster: null,
  } as unknown as Parameters<typeof runDeliberationPhase>[0];
}

describe("runDeliberationPhase", () => {
  beforeEach(() => {
    deliberatorRun.mockReset();
  });

  it("arms S2 planner no_output stop state for user-origin turns", async () => {
    const nextWorkingMemory = createWorkingMemory(DEFAULT_SESSION_ID, 2_000);
    const setStopState = vi.fn(() => nextWorkingMemory);
    deliberatorRun.mockResolvedValue({
      response: "",
      emissionRecommendation: "no_output",
      thoughtStreamEntryIds: [createStreamEntryId()],
    });

    const result = await runDeliberationPhase(makeInput("user", setStopState));

    expect(setStopState).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "s2_planner_no_output",
        reason: "S2 planner recommended no assistant message for this turn.",
      }),
    );
    expect(result.workingMemory).toBe(nextWorkingMemory);
  });

  it("does not arm S2 planner no_output stop state for autonomous turns", async () => {
    const setStopState = vi.fn();
    const input = makeInput("autonomous", setStopState);
    deliberatorRun.mockResolvedValue({
      response: "",
      emissionRecommendation: "no_output",
      thoughtStreamEntryIds: [createStreamEntryId()],
    });

    const result = await runDeliberationPhase(input);

    expect(setStopState).not.toHaveBeenCalled();
    expect(result.workingMemory).toBe(input.workingMemory);
  });

  it("preassembles canonical commitment entity labels without finalizer repository reads", async () => {
    const setStopState = vi.fn();
    const input = makeInput("user", setStopState);
    const madeTo = createEntityId();
    const about = createEntityId();
    input.retrievalPhase.applicableCommitments = [
      {
        made_to_entity: madeTo,
        restricted_audience: madeTo,
        about_entity: about,
        committed_by_entity_id: null,
      },
    ] as never;
    input.options.entityRepository = {
      get: vi.fn((id) => ({ canonical_name: id === madeTo ? "Alice" : "Project Atlas" })),
    } as never;
    deliberatorRun.mockResolvedValue({
      response: "",
      emissionRecommendation: "emit",
      thoughtStreamEntryIds: [],
    });

    await runDeliberationPhase(input);

    expect(deliberatorRun.mock.calls[0]?.[0]).toMatchObject({
      commitmentEntityLabels: {
        [madeTo]: "Alice",
        [about]: "Project Atlas",
      },
    });
    expect(input.options.entityRepository.get).toHaveBeenCalledTimes(2);
  });

  describe("M3 partner on a group channel", () => {
    const group = createEntityId();
    const speaker = createEntityId();
    const stranger = createEntityId();
    const valueOf = (section: string): number => Number(/\((0\.\d+)/.exec(section)![1]);

    // Two exchanges with the speaker, each with a reconciled expectation about them.
    // The group itself has neither: borg credits the exchange to the speaker.
    function withInhibitionWiring(input: ReturnType<typeof makeInput>) {
      const options = input.options as unknown as Record<string, unknown>;
      options.config = {
        ...(options.config as object),
        inhibition: {
          baseThreshold: 0.75,
          uncertaintyWeight: 0.5,
          presenceRelief: 0.1,
          cautionWeight: 0.3,
          familiarityScale: 5,
          recentErrorWindow: 10,
        },
        prediction: { attachmentFigureName: null },
      };
      options.socialRepository = {
        getProfile: (id: unknown) => (id === speaker ? { interaction_count: 2 } : null),
      };
      options.predictionRepository = {
        listReconciliationsForEntity: ({ aboutEntityId }: { aboutEntityId: unknown }) =>
          aboutEntityId === speaker ? [{ error_magnitude: 0.1 }, { error_magnitude: 0.2 }] : [],
      };
      input.isSelfAudience = false;
      input.audienceEntityId = group as never;
      deliberatorRun.mockResolvedValue({
        response: "",
        emissionRecommendation: "emit",
        thoughtStreamEntryIds: [],
      });
      return input;
    }

    function inhibitionSection(): string {
      return deliberatorRun.mock.calls[0]?.[0].speechInhibitionPromptSection as string;
    }

    it("reads familiarity from the speaker, not from the thread group", async () => {
      const input = withInhibitionWiring(makeInput("user", vi.fn()));
      input.socialInteractionEntityId = speaker as never;

      await runDeliberationPhase(input);

      // Predictability > 0 shows as hesitation below the 0.75 base threshold.
      expect(valueOf(inhibitionSection())).toBeLessThan(0.75);
    });

    it("with no single speaker, the least predictable person present sets the hesitation", async () => {
      const input = withInhibitionWiring(makeInput("user", vi.fn()));
      input.socialInteractionEntityId = null;
      input.activeParticipants = [
        { entityId: speaker, displayName: "Sol", role: "participant" },
        { entityId: stranger, displayName: "Nowy", role: "participant" },
      ] as never;

      await runDeliberationPhase(input);

      expect(inhibitionSection()).toContain("(0.75");
    });

    it("with no single speaker, never counts the group entity as a person present", async () => {
      const input = withInhibitionWiring(makeInput("user", vi.fn()));
      input.socialInteractionEntityId = null;
      input.activeParticipants = [
        { entityId: speaker, displayName: "Sol", role: "participant" },
        { entityId: group, displayName: "wątek", role: "audience" },
      ] as never;

      await runDeliberationPhase(input);

      expect(valueOf(inhibitionSection())).toBeLessThan(0.75);
    });
  });
});


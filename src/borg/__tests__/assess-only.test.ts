import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeLLMClient,
  ManualClock,
  createTestConfig,
  Borg,
  ScriptedEmbeddingClient,
  borgInternals,
  join,
  mkdtempSync,
  rmSync,
  tmpdir,
} from "./test-helpers.js";

// Assess-only turns take a message in without answering it: the message is
// stored, perceived and appraised, the mood and the social contact are recorded,
// and nothing past the extract phase runs. These tests pin both halves -- what
// must still happen, and what must not.

async function openBorg(tempDir: string, llmClient: FakeLLMClient) {
  return Borg.open({
    config: createTestConfig({
      dataDir: tempDir,
      perception: {
        llmEnabled: false,
      },
      affective: {
        llmEnabled: false,
        incomingMoodWeight: 0.3,
        moodHalfLifeHours: 24,
        moodHistoryRetentionDays: 90,
      },
      embedding: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "test",
        model: "fake-embed",
        dims: 4,
      },
      anthropic: {
        auth: "api-key",
        apiKey: "test",
        models: {
          cognition: "sonnet",
          background: "haiku",
          extraction: "haiku",
        },
      },
    }),
    clock: new ManualClock(1_000),
    embeddingDimensions: 4,
    embeddingClient: new ScriptedEmbeddingClient(),
    llmClient,
    liveExtraction: false,
  });
}

type TurnOrchestratorInternals = {
  deps: {
    turnOrchestrator: {
      options: {
        affectiveSignalDetector?: () => Promise<unknown>;
        retrievalPipeline: {
          recallEpisodesForCognition: (...args: unknown[]) => Promise<unknown>;
        };
      };
    };
  };
};

describe("assess-only turns", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();

    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("stores the message and counts the speaker's contact, but never recalls, deliberates or marks the stream", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "borg-"));
    tempDirs.push(tempDir);
    // No scripted responses: a finalizer or reflector call would have nothing
    // to answer with and fail the turn.
    const borg = await openBorg(tempDir, new FakeLLMClient());

    try {
      const internal = borgInternals<TurnOrchestratorInternals>(borg);
      const recallSpy = vi.spyOn(
        internal.deps.turnOrchestrator.options.retrievalPipeline,
        "recallEpisodesForCognition",
      );
      borg.entities.resolve("Planning Room", { kind: "group" });
      const alice = borg.entities.resolve("Alice", { kind: "person" });

      const result = await borg.turn({
        userMessage: "I can take the flights part.",
        audience: "Planning Room",
        senderEntityId: alice,
        assessOnly: true,
      });

      expect(result).toMatchObject({
        path: "assessed",
        emitted: false,
        response: "",
        emission: { kind: "assessed" },
      });
      expect(recallSpy).not.toHaveBeenCalled();
      // Familiarity is counted on the person, as on a full group turn.
      expect(borg.social.getProfile("Alice")?.interaction_count).toBe(1);
      expect(borg.social.getProfile("Planning Room")).toBeNull();

      const kinds = borg.stream.tail(20).map((entry) => entry.kind);
      expect(kinds).toContain("user_msg");
      // Heard, not declined: no reply, no observation, no suppression marker.
      expect(kinds).not.toContain("agent_msg");
      expect(kinds).not.toContain("agent_observed");
      expect(kinds).not.toContain("agent_suppressed");
    } finally {
      await borg.close();
    }
  });

  it("records the mood the message moved", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "borg-"));
    tempDirs.push(tempDir);
    const borg = await openBorg(tempDir, new FakeLLMClient());

    try {
      const internal = borgInternals<TurnOrchestratorInternals>(borg);
      internal.deps.turnOrchestrator.options.affectiveSignalDetector = async () => ({
        valence: -0.7,
        arousal: 0.4,
        dominant_emotion: "fear",
      });

      await borg.turn({
        userMessage: "Atlas deploy failed again.",
        assessOnly: true,
      });

      const history = borg.mood.history("default" as never);
      expect(history).toHaveLength(1);
      expect(history[0]?.valence).toBeLessThan(0);
    } finally {
      await borg.close();
    }
  });

  it("rejects assess-only on a turn that was not sent by someone", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "borg-"));
    tempDirs.push(tempDir);
    const borg = await openBorg(tempDir, new FakeLLMClient());

    try {
      await expect(
        borg.turn({
          userMessage: "wake",
          origin: "autonomous",
          assessOnly: true,
        }),
      ).rejects.toMatchObject({ code: "ASSESS_ONLY_REQUIRES_SINGLE_USER_MESSAGE" });
    } finally {
      await borg.close();
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/index.js";
import type { Episode } from "../memory/episodic/index.js";
import { FakeLLMClient } from "../llm/test-support/fake-client.js";
import { FixedClock } from "../util/clock.js";

import { AssociatorProcess } from "./associator/index.js";
import { CuratorProcess } from "./curator/index.js";
import { ReflectorProcess } from "./reflector/index.js";
import { SelfNarratorProcess } from "./self-narrator/index.js";
import { SemanticExtractorProcess } from "./semantic-extractor/index.js";
import {
  createEpisodeFixture,
  createOfflineTestHarness,
  type OfflineTestHarness,
} from "./test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 100 * DAY_MS;

function episodeAt(title: string, createdAt: number, extra: Partial<Episode> = {}): Episode {
  return createEpisodeFixture(
    {
      title,
      narrative: `${title}, as it happened.`,
      tags: ["shared-thread"],
      created_at: createdAt,
      updated_at: createdAt,
      start_time: createdAt,
      end_time: createdAt,
      ...extra,
    },
    [1, 0, 0, 0],
  );
}

async function harnessWith(
  llm: FakeLLMClient,
  offline: Partial<typeof DEFAULT_CONFIG.offline> = {},
): Promise<OfflineTestHarness> {
  return createOfflineTestHarness({
    clock: new FixedClock(NOW_MS),
    llmClient: llm,
    configOverrides: { offline: { ...DEFAULT_CONFIG.offline, ...offline } },
  });
}

function promptsOf(llm: FakeLLMClient): string {
  return JSON.stringify(llm.requests.map((request) => request.messages));
}

describe("heavy pass novelty window", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((run) => run()));
  });

  const oldEpisodes = [
    episodeAt("Old talk one", NOW_MS - 30 * DAY_MS),
    episodeAt("Old talk two", NOW_MS - 29 * DAY_MS),
    episodeAt("Old talk three", NOW_MS - 28 * DAY_MS),
  ];

  it("reflector re-reads no group when nothing is new, and reads a group that gained one", async () => {
    for (const fresh of [false, true]) {
      const llm = new FakeLLMClient();
      const harness = await harnessWith(llm);
      cleanup.push(harness.cleanup);
      const episodes = fresh
        ? [...oldEpisodes, episodeAt("New talk", NOW_MS - DAY_MS)]
        : oldEpisodes;

      for (const episode of episodes) {
        await harness.episodicRepository.createEpisode(episode);
      }

      const process = new ReflectorProcess({
        semanticNodeRepository: harness.semanticNodeRepository,
        semanticEdgeRepository: harness.semanticEdgeRepository,
        reviewQueueRepository: harness.reviewQueueRepository,
        registry: harness.registry,
        clock: harness.clock,
      });

      await process.plan({ ...harness.createContext(), noveltySinceMs: NOW_MS - 7 * DAY_MS });

      if (fresh) {
        // The group is read whole: the new episode arrives with its old members.
        expect(llm.requests.length).toBeGreaterThan(0);
        expect(promptsOf(llm)).toContain("New talk");
        expect(promptsOf(llm)).toContain("Old talk one");
      } else {
        expect(llm.requests).toHaveLength(0);
      }
    }
  });

  it("associator makes no sample without a new episode and anchors each sample on one", async () => {
    for (const fresh of [false, true]) {
      const llm = new FakeLLMClient();
      const harness = await harnessWith(llm);
      cleanup.push(harness.cleanup);
      const episodes = fresh
        ? [...oldEpisodes, episodeAt("New talk", NOW_MS - DAY_MS)]
        : oldEpisodes;

      for (const episode of episodes) {
        await harness.episodicRepository.createEpisode(episode);
      }

      const process = new AssociatorProcess({
        semanticNodeRepository: harness.semanticNodeRepository,
        semanticEdgeRepository: harness.semanticEdgeRepository,
        reviewQueueRepository: harness.reviewQueueRepository,
        openQuestionsRepository: harness.openQuestionsRepository,
        registry: harness.registry,
        clock: harness.clock,
      });

      await process.plan({ ...harness.createContext(), noveltySinceMs: NOW_MS - 7 * DAY_MS });

      if (fresh) {
        expect(llm.requests.length).toBeGreaterThan(0);

        for (const request of llm.requests) {
          const prompt = JSON.stringify(request.messages);
          expect(prompt).toContain("New talk");
          // Partners still come from the old memory.
          expect(prompt).toMatch(/Old talk/u);
        }
      } else {
        expect(llm.requests).toHaveLength(0);
      }
    }
  });

  it("self-narrator does not call the model when the chapter has nothing new", async () => {
    for (const fresh of [false, true]) {
      const llm = new FakeLLMClient();
      const harness = await harnessWith(llm);
      cleanup.push(harness.cleanup);
      const episodes = fresh
        ? [
            ...oldEpisodes,
            episodeAt("New talk", NOW_MS - 2 * DAY_MS),
            episodeAt("Newer talk", NOW_MS - DAY_MS),
          ]
        : oldEpisodes;

      for (const episode of episodes) {
        await harness.episodicRepository.createEpisode(episode);
      }

      const process = new SelfNarratorProcess({
        autobiographicalRepository: harness.autobiographicalRepository,
        growthMarkersRepository: harness.growthMarkersRepository,
        registry: harness.registry,
      });

      await process.plan({ ...harness.createContext(), noveltySinceMs: NOW_MS - 7 * DAY_MS });

      if (fresh) {
        expect(llm.requests.length).toBeGreaterThan(0);
        expect(promptsOf(llm)).toContain("Newer talk");
        expect(promptsOf(llm)).not.toContain("Old talk one");
      } else {
        expect(llm.requests).toHaveLength(0);
      }
    }
  });
});

describe("engagement: extraction and archiving", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((run) => run()));
  });

  async function seedEngagementCases(harness: OfflineTestHarness) {
    const heard = await harness.streamWriter.append({ kind: "user_msg", content: "a bot speaks" });
    const spoke = await harness.streamWriter.append({ kind: "agent_msg", content: "I answer" });
    const recalled = episodeAt("Recalled later", NOW_MS - 15 * DAY_MS, {
      source_stream_ids: [heard.id],
    });
    const acted = episodeAt("He answered", NOW_MS - 15 * DAY_MS, {
      source_stream_ids: [heard.id, spoke.id],
    });
    const ignored = episodeAt("Only heard", NOW_MS - 15 * DAY_MS, {
      source_stream_ids: [heard.id],
    });
    const young = episodeAt("Heard yesterday", NOW_MS - DAY_MS, {
      source_stream_ids: [heard.id],
    });

    for (const episode of [recalled, acted, ignored, young]) {
      await harness.episodicRepository.createEpisode(episode);
      harness.episodicRepository.updateStats(episode.id, { tier: "T1" });
    }

    harness.episodicRepository.updateStats(recalled.id, { retrieval_count: 1 });
    harness.episodicRepository.updateStats(young.id, { retrieval_count: 1 });
    return { recalled, acted, ignored, young };
  }

  it("extracts only ripe episodes the being came back to or acted in", async () => {
    for (const engagedOnly of [false, true]) {
      const harness = await harnessWith(new FakeLLMClient(), {
        semanticExtractor: {
          ...DEFAULT_CONFIG.offline.semanticExtractor,
          engagedOnly,
          minEpisodeAgeDays: 7,
        },
      });
      cleanup.push(harness.cleanup);
      const { recalled, acted, ignored } = await seedEngagementCases(harness);
      const process = new SemanticExtractorProcess({
        semanticNodeRepository: harness.semanticNodeRepository,
        semanticEdgeRepository: harness.semanticEdgeRepository,
        registry: harness.registry,
        clock: harness.clock,
      });

      const plan = await process.plan(harness.createContext(), {});

      // The day-old episode waits either way; the never-engaged one waits only when asked.
      expect([...plan.episode_ids].sort()).toEqual(
        (engagedOnly
          ? [recalled.id, acted.id]
          : [recalled.id, acted.id, ignored.id]
        ).sort(),
      );
    }
  });

  it("archives an unextracted episode the being never engaged with once it is old enough", async () => {
    for (const unengagedArchiveAgeDays of [null, 14]) {
      const harness = await harnessWith(new FakeLLMClient(), {
        curator: { ...DEFAULT_CONFIG.offline.curator, unengagedArchiveAgeDays },
      });
      cleanup.push(harness.cleanup);
      const { ignored } = await seedEngagementCases(harness);
      const process = new CuratorProcess({
        episodicRepository: harness.episodicRepository,
        traitsRepository: harness.traitsRepository,
        moodRepository: harness.moodRepository,
        socialRepository: harness.socialRepository,
        registry: harness.registry,
      });

      const plan = await process.plan(harness.createContext(), {});
      const archived = plan.items.flatMap((item) =>
        item.action === "archive" && "episode_id" in item ? [item.episode_id] : [],
      );

      expect(archived).toEqual(unengagedArchiveAgeDays === null ? [] : [ignored.id]);
    }
  });
});

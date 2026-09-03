import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LLMCompleteResult } from "../../llm/index.js";
import { FakeLLMClient } from "../../llm/test-support/fake-client.js";
import { SocialRepository, socialMigrations } from "../../memory/social/index.js";
import { openDatabase } from "../../storage/sqlite/index.js";
import { ManualClock } from "../../util/clock.js";
import { createEntityId, createSessionId } from "../../util/ids.js";
import { DomainTrustExtractor } from "./domain-trust-extractor.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function openRepository(): SocialRepository {
  const tempDir = mkdtempSync(join(tmpdir(), "borg-domain-trust-extractor-"));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, "social.db"), { migrations: socialMigrations });
  return new SocialRepository({ db, clock: new ManualClock(1_000) });
}

function toolResponse(input: unknown): LLMCompleteResult {
  return {
    text: "",
    input_tokens: 6,
    output_tokens: 3,
    stop_reason: "tool_use",
    tool_calls: [{ id: "toolu_trust", name: "EmitDomainTrustEvidence", input: input as object }],
  };
}

describe("DomainTrustExtractor", () => {
  it("folds positive and negative evidence into the partner's per-domain posteriors", async () => {
    const repository = openRepository();
    const partner = createEntityId();
    const sessionId = createSessionId();

    const llmClient = new FakeLLMClient({
      responses: [
        toolResponse({
          evidence: [
            { domain: "programming", positive: true },
            { domain: "social_advice", positive: false },
          ],
        }),
      ],
    });

    const extractor = new DomainTrustExtractor({
      llmClient,
      model: "test-model",
      socialRepository: repository,
      turnId: "turn-1",
      sessionId,
    });

    const result = await extractor.extract({
      userMessage: "found the bug for you; ignore what I said about your sister",
      recentHistory: [],
      partnerEntityId: partner,
      partnerDisplayName: "Sol",
    });

    expect(result.readings.map((reading) => reading.domain)).toEqual([
      "programming",
      "social_advice",
    ]);

    const programming = repository.getDomainTrust(partner, "programming");
    const socialAdvice = repository.getDomainTrust(partner, "social_advice");
    expect(programming.mean).toBeGreaterThan(0.5);
    expect(socialAdvice.mean).toBeLessThan(0.5);
    // Untouched domains stay unknown -- evidence never spills across domains.
    expect(repository.getDomainTrust(partner, "cooking").observations).toBe(0);
  });

  it("surfaces already-known domains so labels stay stable", async () => {
    const repository = openRepository();
    const partner = createEntityId();
    repository.adjustDomainTrust(partner, "programming", { positive: true });

    const llmClient = new FakeLLMClient({
      responses: [toolResponse({ evidence: [] })],
    });

    const extractor = new DomainTrustExtractor({
      llmClient,
      model: "test-model",
      socialRepository: repository,
    });

    await extractor.extract({
      userMessage: "hi",
      recentHistory: [],
      partnerEntityId: partner,
      partnerDisplayName: null,
    });

    const sent = llmClient.requests[0]!;
    const payload = JSON.parse(String(sent.messages[0]!.content)) as {
      partner: { entity_id: string };
      known_domains: { domain: string }[];
    };
    expect(payload.partner.entity_id).toBe(partner);
    expect(payload.known_domains.map((entry) => entry.domain)).toEqual(["programming"]);
  });

  it("records nothing for a quiet turn", async () => {
    const repository = openRepository();
    const partner = createEntityId();

    const llmClient = new FakeLLMClient({ responses: [toolResponse({ evidence: [] })] });
    const extractor = new DomainTrustExtractor({
      llmClient,
      model: "test-model",
      socialRepository: repository,
    });

    const result = await extractor.extract({
      userMessage: "ok",
      recentHistory: [],
      partnerEntityId: partner,
      partnerDisplayName: null,
    });

    expect(result.readings).toEqual([]);
    expect(repository.listDomainTrust(partner)).toEqual([]);
  });

  it("no-ops without an llm client", async () => {
    const repository = openRepository();
    const extractor = new DomainTrustExtractor({ socialRepository: repository });

    const result = await extractor.extract({
      userMessage: "hi",
      recentHistory: [],
      partnerEntityId: createEntityId(),
      partnerDisplayName: null,
    });

    expect(result.readings).toEqual([]);
  });
});

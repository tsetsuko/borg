import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../storage/sqlite/index.js";
import { ManualClock } from "../../util/clock.js";
import { createEntityId } from "../../util/ids.js";
import { socialMigrations } from "./migrations.js";
import { SocialRepository } from "./repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function openRepository(): SocialRepository {
  const tempDir = mkdtempSync(join(tmpdir(), "borg-trust-domains-"));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, "social.db"), { migrations: socialMigrations });
  return new SocialRepository({ db, clock: new ManualClock(1_000) });
}

function ci95Width(reading: { ci95: [number, number] }): number {
  return reading.ci95[1] - reading.ci95[0];
}

describe("SocialRepository per-domain trust", () => {
  it("returns the flat prior (unknown) for a domain with no evidence", () => {
    const repo = openRepository();
    const reading = repo.getDomainTrust(createEntityId(), "programming");

    expect(reading.mean).toBeCloseTo(0.5, 5);
    expect(reading.observations).toBe(0);
    // Beta(1,1) is uniform: a very wide interval.
    expect(ci95Width(reading)).toBeGreaterThan(0.9);
  });

  it("distinguishes unknown from medium by curve width, not value (AC#2)", () => {
    const repo = openRepository();
    const entity = createEntityId();

    const unknown = repo.getDomainTrust(entity, "social_advice");
    // "medium": lots of evidence that lands evenly -> mean ~0.5 but narrow.
    for (let i = 0; i < 20; i += 1) {
      repo.adjustDomainTrust(entity, "social_advice", { positive: i % 2 === 0 });
    }
    const medium = repo.getDomainTrust(entity, "social_advice");

    expect(unknown.mean).toBeCloseTo(0.5, 1);
    expect(medium.mean).toBeCloseTo(0.5, 1);
    // Same value, very different confidence.
    expect(ci95Width(medium)).toBeLessThan(ci95Width(unknown) / 2);
    expect(medium.observations).toBe(20);
  });

  it("raises trust with positive evidence and lowers it with negative", () => {
    const repo = openRepository();
    const entity = createEntityId();

    for (let i = 0; i < 8; i += 1) {
      repo.adjustDomainTrust(entity, "programming", { positive: true });
    }
    const trusted = repo.getDomainTrust(entity, "programming");
    expect(trusted.mean).toBeGreaterThan(0.8);

    for (let i = 0; i < 8; i += 1) {
      repo.adjustDomainTrust(entity, "cooking", { positive: false });
    }
    const distrusted = repo.getDomainTrust(entity, "cooking");
    expect(distrusted.mean).toBeLessThan(0.2);
  });

  it("keeps domains independent and aggregates an evidence-weighted overall", () => {
    const repo = openRepository();
    const entity = createEntityId();

    for (let i = 0; i < 10; i += 1) repo.adjustDomainTrust(entity, "programming", { positive: true });
    for (let i = 0; i < 10; i += 1) repo.adjustDomainTrust(entity, "cooking", { positive: false });

    const domains = repo.listDomainTrust(entity);
    expect(domains.map((d) => d.domain).sort()).toEqual(["cooking", "programming"]);

    const overall = repo.overallDomainTrust(entity);
    expect(overall).not.toBeNull();
    // Symmetric high/low evidence -> aggregate near the middle.
    expect(overall!).toBeGreaterThan(0.3);
    expect(overall!).toBeLessThan(0.7);

    expect(repo.overallDomainTrust(createEntityId())).toBeNull();
  });

  it("keeps the legacy trust scalar as a derived projection of the domains (D2)", () => {
    const repo = openRepository();
    const entity = createEntityId();

    // No domain evidence yet: the profile default stands.
    expect(repo.upsertProfile(entity).trust).toBeCloseTo(0.5, 5);

    for (let i = 0; i < 8; i += 1) repo.adjustDomainTrust(entity, "programming", { positive: true });

    const afterPositive = repo.getProfile(entity);
    expect(afterPositive!.trust).toBeCloseTo(repo.overallDomainTrust(entity)!, 5);
    expect(afterPositive!.trust).toBeGreaterThan(0.5);

    // A second domain that goes badly pulls the aggregate back down.
    for (let i = 0; i < 8; i += 1) repo.adjustDomainTrust(entity, "cooking", { positive: false });

    const afterNegative = repo.getProfile(entity);
    expect(afterNegative!.trust).toBeCloseTo(repo.overallDomainTrust(entity)!, 5);
    expect(afterNegative!.trust).toBeLessThan(afterPositive!.trust);
  });
});

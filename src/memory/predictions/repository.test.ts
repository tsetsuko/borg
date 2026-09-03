import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../storage/sqlite/index.js";
import { ManualClock } from "../../util/clock.js";
import {
  createEntityId,
  createEpisodeId,
  createPredictionEventId,
  createSessionId,
} from "../../util/ids.js";
import { predictionMigrations } from "./migrations.js";
import { PredictionRepository } from "./repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function openRepository(clock: ManualClock): PredictionRepository {
  const tempDir = mkdtempSync(join(tmpdir(), "borg-predictions-"));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, "predictions.db"), { migrations: predictionMigrations });
  return new PredictionRepository({ db, clock });
}

describe("PredictionRepository", () => {
  it("records an expectation and surfaces it as open until reconciled", () => {
    const repository = openRepository(new ManualClock(1_000));
    const sessionId = createSessionId();
    const aboutEntityId = createEntityId();

    const expectation = repository.recordExpectation({
      sessionId,
      turnId: "turn-1",
      content: "Tomek will come back to the migration ordering next.",
      aboutEntityId,
      originAudience: "arena",
    });

    expect(expectation.kind).toBe("expectation");
    expect(expectation.prediction_id).toBe(expectation.id);
    expect(expectation.error_magnitude).toBeNull();
    expect(expectation.about_entity_id).toBe(aboutEntityId);

    const open = repository.listOpen({ limit: 10 });
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(expectation.id);

    const episodeId = createEpisodeId();
    const reconciliation = repository.reconcile({
      predictionId: expectation.id,
      sessionId,
      turnId: "turn-4",
      content: "He dropped it entirely and moved to snapshots.",
      errorMagnitude: 0.7,
      episodeIds: [episodeId],
    });

    expect(reconciliation.kind).toBe("reconciliation");
    expect(reconciliation.error_magnitude).toBe(0.7);
    expect(reconciliation.episode_ids).toEqual([episodeId]);
    expect(repository.listOpen({ limit: 10 })).toHaveLength(0);
  });

  it("refuses to reconcile a prediction with no open expectation", () => {
    const repository = openRepository(new ManualClock(1_000));

    expect(() =>
      repository.reconcile({
        predictionId: createPredictionEventId(),
        sessionId: createSessionId(),
        turnId: "turn-2",
        content: "x",
        errorMagnitude: 0.5,
      }),
    ).toThrowError(/no open expectation/);
  });

  it("is idempotent per prediction and clamps error magnitude to 0..1", () => {
    const clock = new ManualClock(1_000);
    const repository = openRepository(clock);
    const sessionId = createSessionId();
    const expectation = repository.recordExpectation({
      sessionId,
      turnId: "turn-1",
      content: "They are converging on the answer without me.",
    });

    const first = repository.reconcile({
      predictionId: expectation.id,
      sessionId,
      turnId: "turn-2",
      content: "They got it.",
      errorMagnitude: 5,
    });
    expect(first.error_magnitude).toBe(1);

    clock.set(2_000);
    const second = repository.reconcile({
      predictionId: expectation.id,
      sessionId,
      turnId: "turn-3",
      content: "different words",
      errorMagnitude: 0.1,
    });

    // Second reconcile is a no-op that returns the first, immutable reconciliation.
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("They got it.");
    expect(second.error_magnitude).toBe(1);
  });

  it("lists reconciliations after a cutoff oldest-first for watermark scans", () => {
    const clock = new ManualClock(1_000);
    const repository = openRepository(clock);
    const sessionId = createSessionId();

    const ids = ["a", "b", "c"].map((label, index) => {
      clock.set(1_000 + index * 100);
      const expectation = repository.recordExpectation({
        sessionId,
        turnId: `exp-${label}`,
        content: `expectation ${label}`,
      });
      clock.set(5_000 + index * 100);
      repository.reconcile({
        predictionId: expectation.id,
        sessionId,
        turnId: `rec-${label}`,
        content: `outcome ${label}`,
        errorMagnitude: 0.3 + index * 0.1,
      });
      return expectation.id;
    });

    const since = repository.listReconciliationsSince({ sinceMs: 5_050, limit: 10 });
    expect(since.map((row) => row.prediction_id)).toEqual([ids[1], ids[2]]);
    expect(since[0]!.created_ts).toBeLessThan(since[1]!.created_ts);
  });
});

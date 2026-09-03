import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { LanceDbStore } from "../../storage/lancedb/index.js";
import { openDatabase } from "../../storage/sqlite/index.js";
import { FixedClock } from "../../util/clock.js";
import { createEntityId, createSemanticNodeId, type EpisodeId } from "../../util/ids.js";
import { semanticMigrations } from "./migrations.js";
import { SemanticNodeRepository, createSemanticNodesTableSchema } from "./repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function createFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "borg-acquisition-"));
  tempDirs.push(tempDir);
  const store = new LanceDbStore({ uri: join(tempDir, "lancedb") });
  const db = openDatabase(join(tempDir, "borg.db"), { migrations: semanticMigrations });
  const table = await store.openTable({
    name: "semantic_nodes",
    schema: createSemanticNodesTableSchema(4),
  });

  return {
    db,
    nodeRepository: new SemanticNodeRepository({ table, db, clock: new FixedClock(1_000) }),
  };
}

function buildNode(label: string) {
  return {
    id: createSemanticNodeId(),
    kind: "proposition" as const,
    label,
    description: `${label} description`,
    domain: null,
    aliases: [],
    observation_metadata: null,
    confidence: 0.7,
    source_episode_ids: ["ep_aaaaaaaaaaaaaaaa" as EpisodeId],
    created_at: 1_000,
    updated_at: 1_000,
    last_verified_at: 1_000,
    embedding: Float32Array.from([1, 0, 0, 0]),
    archived: false,
    superseded_by: null,
  };
}

describe("semantic acquisition provenance", () => {
  it("round-trips how a belief was acquired and who it came from", async () => {
    const { nodeRepository } = await createFixture();
    const sol = createEntityId();

    const inserted = await nodeRepository.insert({
      ...buildNode("Small commits are easier to review"),
      acquisition_mode: "observed_from",
      acquired_from_entity_id: sol,
    });

    expect(inserted.acquisition_mode).toBe("observed_from");
    expect(inserted.acquired_from_entity_id).toBe(sol);

    // Reads go through the vector mirror, so the SQL-only columns have to be
    // merged back rather than silently defaulting to null.
    const fetched = await nodeRepository.get(inserted.id);
    expect(fetched?.acquisition_mode).toBe("observed_from");
    expect(fetched?.acquired_from_entity_id).toBe(sol);
  });

  it("defaults to unknown acquisition and distinguishes hearsay from first-hand testing", async () => {
    const { nodeRepository } = await createFixture();

    const unknown = await nodeRepository.insert(buildNode("Unattributed claim"));
    expect(unknown.acquisition_mode).toBeNull();
    expect(unknown.acquired_from_entity_id).toBeNull();

    const heard = await nodeRepository.insert({
      ...buildNode("Told claim"),
      acquisition_mode: "told_by",
      acquired_from_entity_id: createEntityId(),
    });
    const tested = await nodeRepository.insert({
      ...buildNode("Tested claim"),
      acquisition_mode: "tested_independently",
      acquired_from_entity_id: null,
    });

    expect(heard.acquisition_mode).toBe("told_by");
    expect(tested.acquisition_mode).toBe("tested_independently");
  });

  it("upgrades acquisition mode on update without clobbering it by default", async () => {
    const { nodeRepository } = await createFixture();

    const node = await nodeRepository.insert({
      ...buildNode("Rollback planning helps"),
      acquisition_mode: "told_by",
      acquired_from_entity_id: createEntityId(),
    });

    // An unrelated patch leaves the acquisition standing alone.
    const touched = await nodeRepository.update(node.id, { confidence: 0.8 });
    expect(touched?.acquisition_mode).toBe("told_by");

    const retested = await nodeRepository.update(node.id, {
      acquisition_mode: "tested_independently",
    });
    expect(retested?.acquisition_mode).toBe("tested_independently");
  });

  it("rejects an acquisition mode outside the recorded dimension", async () => {
    const { db } = await createFixture();

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO semantic_nodes (
              id, kind, label, description, aliases, confidence, source_episode_ids,
              created_at, updated_at, last_verified_at, acquisition_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          createSemanticNodeId(),
          "proposition",
          "bad",
          "bad",
          "[]",
          0.5,
          "[]",
          1_000,
          1_000,
          1_000,
          "overheard",
        ),
    ).toThrow();
  });
});

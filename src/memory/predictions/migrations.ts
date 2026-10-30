import type { Migration } from "../../storage/sqlite/index.js";

export const predictionMigrations = [
  {
    id: 1,
    name: "prediction_events_baseline",
    up: (db) => {
      db.exec(`
        CREATE TABLE prediction_events (
          id TEXT PRIMARY KEY,
          prediction_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('expectation', 'reconciliation')),
          created_ts INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          content TEXT NOT NULL,
          about TEXT NULL,
          about_entity_id TEXT NULL,
          origin_audience TEXT NULL,
          error_magnitude REAL NULL,
          episode_ids TEXT NOT NULL DEFAULT '[]',
          -- Stream entries of the turn the expectation formed in. On reconciliation
          -- these locate the episode(s) whose significance the surprise boosts:
          -- the memory a surprising prediction grew from becomes more retrievable.
          source_stream_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        -- One expectation and at most one reconciliation per logical prediction.
        -- prediction_id == the expectation row's id; the reconciliation row carries
        -- the same prediction_id. The UNIQUE(prediction_id, kind) pair makes a
        -- second expectation or a second reconciliation a write conflict rather
        -- than a silent overwrite: an expectation is immutable once recorded, so
        -- it cannot be backdated after its outcome is known.
        CREATE UNIQUE INDEX idx_prediction_events_prediction_kind
        ON prediction_events(prediction_id, kind);
        -- Recall ordering is global to the being, never gated by session; session_id
        -- is a provenance label the caller may rank by, not a filter.
        CREATE INDEX idx_prediction_events_recent
        ON prediction_events(created_ts DESC);
        CREATE INDEX idx_prediction_events_kind_recent
        ON prediction_events(kind, created_ts DESC);
      `);
    },
  },
  {
    id: 2,
    name: "prediction_events_formed_turn_counter",
    up: (db) => {
      db.exec(`
        -- The global turn ordinal the expectation formed in. Provenance, like
        -- turn_id and session_id beside it -- never a recall gate. It exists so the
        -- reconciliation prompt can be told how many turns old an open expectation
        -- is: without that, "resolve only what this turn bears on" has nothing to
        -- lean on, and a backlog of stale expectations gets cleared in one lump
        -- against whatever turn happens to be current. Nullable, because rows
        -- written before this migration have no ordinal to backfill from.
        ALTER TABLE prediction_events ADD COLUMN formed_turn_counter INTEGER NULL;
      `);
    },
  },
  {
    id: 3,
    name: "autonomy_wakes_prediction_error_spike",
    up: () => {
      // Moved here from the autonomy group, where it first widened the wake-name
      // CHECKs for M2. That widening now lives in autonomy_wakes_interrupted_outcome,
      // so this does nothing. It stays because banks that applied it record the name
      // in _migrations and the runner refuses an applied name it cannot find; the
      // runner re-ids such a row here by name. Keeping it out of the autonomy group
      // leaves that group's ids exactly as upstream ships them.
    },
  },
] as const satisfies readonly Migration[];

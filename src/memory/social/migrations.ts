import type { Migration } from "../../storage/sqlite/index.js";

export const socialMigrations = [
  {
    id: 1,
    name: "social_baseline",
    up: (db) => {
      db.exec(`
        CREATE TABLE social_profiles (
          entity_id TEXT PRIMARY KEY,
          record_version INTEGER NOT NULL DEFAULT 1,
          trust REAL NOT NULL DEFAULT 0.5,
          attachment REAL NOT NULL DEFAULT 0.0,
          communication_style TEXT,
          shared_history_summary TEXT,
          last_interaction_at INTEGER,
          interaction_count INTEGER NOT NULL DEFAULT 0,
          commitment_count INTEGER NOT NULL DEFAULT 0,
          sentiment_history TEXT NOT NULL DEFAULT '[]',
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE social_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (
            kind IN ('interaction', 'trust_adjustment', 'baseline')
          ),
          provenance_kind TEXT NOT NULL CHECK (
            provenance_kind IN ('episodes', 'manual', 'system', 'offline', 'online')
          ),
          provenance_episode_ids TEXT NOT NULL DEFAULT '[]',
          provenance_process TEXT,
          trust_delta REAL NOT NULL DEFAULT 0,
          attachment_delta REAL NOT NULL DEFAULT 0,
          interaction_delta INTEGER NOT NULL DEFAULT 0,
          valence REAL
        );
        CREATE INDEX idx_social_events_entity_ts
          ON social_events (entity_id, ts DESC, id DESC);
      `);
    },
  },
  {
    id: 2,
    name: "social_trust_domains",
    up: (db) => {
      // M4: per-domain trust as a Beta posterior. Trust is not one scalar about a
      // person but "how much I trust this person ABOUT this kind of thing". alpha
      // counts supporting evidence, beta counts letdowns; the mean is the trust
      // level and the spread is the confidence, so "unknown" (weak prior, wide) is
      // distinguishable from "medium" (strong prior at 0.5, narrow). domain is an
      // open model-assigned label, never a fixed enum.
      db.exec(`
        CREATE TABLE social_trust_domains (
          entity_id TEXT NOT NULL,
          domain TEXT NOT NULL,
          alpha REAL NOT NULL,
          beta REAL NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (entity_id, domain)
        );
        CREATE INDEX idx_social_trust_domains_entity
          ON social_trust_domains (entity_id);
      `);
    },
  },
] as const satisfies readonly Migration[];

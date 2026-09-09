import type { Migration } from "../../storage/sqlite/index.js";
import { tableHasColumn } from "../../storage/sqlite/migrations-utils.js";

export const proceduralMigrations = [
  {
    id: 1,
    name: "procedural_baseline",
    up: (db) => {
      db.exec(`
        CREATE TABLE skills (
          id TEXT PRIMARY KEY,
          applies_when TEXT NOT NULL,
          approach TEXT NOT NULL,
          alpha REAL NOT NULL,
          beta REAL NOT NULL,
          attempts INTEGER NOT NULL,
          successes INTEGER NOT NULL,
          failures INTEGER NOT NULL,
          alternatives TEXT NOT NULL,
          source_episode_ids TEXT NOT NULL,
          disclosure_label TEXT,
          last_used INTEGER,
          last_successful INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          superseded_by TEXT NOT NULL DEFAULT '[]',
          superseded_at INTEGER,
          splitting_at INTEGER,
          last_split_attempt_at INTEGER,
          split_failure_count INTEGER NOT NULL DEFAULT 0,
          last_split_error TEXT,
          requires_manual_review INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_skills_manual_review
          ON skills (requires_manual_review, updated_at DESC);
        CREATE INDEX idx_skills_split_attempt
          ON skills (status, last_split_attempt_at DESC);
        CREATE INDEX idx_skills_split_failures
          ON skills (status, split_failure_count, updated_at DESC);
        CREATE INDEX idx_skills_status_updated
          ON skills (status, updated_at DESC);
        CREATE INDEX idx_skills_updated_at
          ON skills (updated_at DESC);
        CREATE TABLE procedural_evidence (
          id TEXT PRIMARY KEY,
          pending_attempt_snapshot TEXT NOT NULL,
          classification TEXT NOT NULL,
          evidence_text TEXT NOT NULL,
          resolved_episode_ids TEXT NOT NULL,
          audience_entity_id TEXT,
          consumed_at INTEGER,
          created_at INTEGER NOT NULL,
          grounded INTEGER NOT NULL DEFAULT 1,
          skill_actually_applied INTEGER NOT NULL DEFAULT 1,
          procedural_context TEXT
        );
        CREATE INDEX idx_procedural_evidence_audience
          ON procedural_evidence (audience_entity_id);
        CREATE INDEX idx_procedural_evidence_unconsumed
          ON procedural_evidence (consumed_at, created_at);
        CREATE TABLE skill_context_stats (
          skill_id TEXT NOT NULL,
          context_key TEXT NOT NULL,
          procedural_context_json TEXT,
          alpha REAL NOT NULL,
          beta REAL NOT NULL,
          attempts INTEGER NOT NULL,
          successes INTEGER NOT NULL,
          failures INTEGER NOT NULL,
          last_used INTEGER,
          last_successful INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (skill_id, context_key)
        );
        CREATE INDEX idx_skill_context_stats_context
          ON skill_context_stats (context_key, updated_at DESC);
        CREATE INDEX idx_skill_context_stats_skill
          ON skill_context_stats (skill_id, updated_at DESC);
      `);
    },
  },
  {
    id: 2,
    name: "procedural_skill_disclosure_labels",
    up: (db) => {
      if (!tableHasColumn(db, "skills", "disclosure_label")) {
        db.exec("ALTER TABLE skills ADD COLUMN disclosure_label TEXT");
      }
    },
  },
  {
    id: 3,
    name: "skills_acquisition_mode",
    up: (db) => {
      // TASK-028: the same acquisition axis semantic_nodes carries since M4, now
      // on behaviours. A skill watched in a stronger peer and a skill the entity
      // found on its own are not the same standing, and without this column the
      // difference is unrecoverable: every skill looks self-found once it is in
      // the table.
      if (!tableHasColumn(db, "skills", "acquisition_mode")) {
        db.exec(`
          ALTER TABLE skills
            ADD COLUMN acquisition_mode TEXT NULL CHECK (
              acquisition_mode IS NULL OR acquisition_mode IN (
                'told_by', 'observed_from', 'inferred', 'tested_independently'
              )
            );
        `);
      }

      if (!tableHasColumn(db, "skills", "acquired_from_entity_id")) {
        db.exec("ALTER TABLE skills ADD COLUMN acquired_from_entity_id TEXT NULL");
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skills_acquisition_mode
          ON skills (acquisition_mode)
          WHERE acquisition_mode IS NOT NULL;
      `);
    },
  },
  {
    id: 4,
    name: "skills_founding_evidence",
    up: (db) => {
      // TASK-032: the attempts a skill was BUILT from, kept apart from the attempts
      // made since. Synthesis credits its founding evidence to the posterior, which
      // is right for choosing a skill -- it is real evidence -- but wrong for
      // retention: a borrowed behaviour would be adopted as the entity's own on the
      // strength of the very attempts that suggested writing it down, before it was
      // ever tried AS a known skill.
      for (const column of ["founding_successes", "founding_failures"]) {
        if (!tableHasColumn(db, "skills", column)) {
          db.exec(`ALTER TABLE skills ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
        }
      }
    },
  },
] as const satisfies readonly Migration[];

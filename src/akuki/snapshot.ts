// Akuki: the developmental state vector, as JSON.
//
// Why not reuse simulator/memory-snapshot.ts directly: it renders MARKDOWN and is
// deliberately lossy -- 240-char field truncation, per-section row caps, an 80k token
// budget. Fine for feeding an overseer LLM, useless as a data series. A timeline built
// on it would quietly lie. What IS reused is its repository call list
// (memory-snapshot.ts:575-631), which is a complete, working inventory of every band's
// accessor; this file is that list pointed at JSON instead of prose.
//
// Everything here goes through the PUBLIC facade. memory-snapshot.ts reaches internals
// via `(borg as unknown as BorgWithDeps).deps`; social, mood, entities and skills are
// all public, so that cast is not needed.

import type { Borg } from "../index.js";
import { parseSessionId } from "../util/ids.js";

export const AKUKI_SNAPSHOT_SCHEMA = 1;

// Matches memory-snapshot.ts's own read ceiling.
const LARGE_LIMIT = 1_000;

type RecordLike = Record<string, unknown>;

const asRecords = (value: unknown): RecordLike[] =>
  Array.isArray(value) ? value.filter((v): v is RecordLike => typeof v === "object" && v !== null) : [];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

function tally(rows: readonly RecordLike[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = str(row[key]) ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export type AkukiSnapshot = {
  schema: number;
  tenant: string;
  capturedAtMs: number;
  counts: Record<string, number>;
  openQuestionsByStatus: Record<string, number>;
  openQuestionsBySource: Record<string, number>;
  self: {
    values: RecordLike[];
    traits: RecordLike[];
    goals: RecordLike[];
    openQuestions: RecordLike[];
    growthMarkers: RecordLike[];
  };
  social: { profiles: RecordLike[]; creatorEntityId: string | null };
  procedural: { skills: RecordLike[] };
  affective: { mood: RecordLike[] };
};

export type BuildAkukiSnapshotOptions = {
  borg: Borg;
  tenant: string;
  capturedAtMs: number;
  sessionIds?: readonly string[];
};

export async function buildAkukiSnapshot(
  options: BuildAkukiSnapshotOptions,
): Promise<AkukiSnapshot> {
  const { borg } = options;
  const sessionIds = options.sessionIds ?? ["default"];

  const episodes = asRecords((await borg.episodic.list({ limit: LARGE_LIMIT })).items);
  const semanticNodes = asRecords(
    await borg.semantic.nodes.list({ includeArchived: true, limit: LARGE_LIMIT }),
  );
  const semanticEdges = asRecords(await borg.semantic.edges.list({ includeInvalid: true }));
  const values = asRecords(borg.self.values.list());
  const traits = asRecords(borg.self.traits.list());
  const goals = asRecords(borg.self.goals.list({}));
  const openQuestions = asRecords(borg.self.openQuestions.list({ limit: LARGE_LIMIT }));
  const growthMarkers = asRecords(borg.self.growthMarkers.list({ limit: LARGE_LIMIT }));
  const periods = asRecords(borg.self.autobiographical.listPeriods({ limit: LARGE_LIMIT }));
  const identityEvents = asRecords(borg.identity.listEvents({ limit: LARGE_LIMIT }));
  const commitments = asRecords(borg.commitments.list({ activeOnly: false }));
  const entities = asRecords(borg.entities.list());
  const socialProfiles = asRecords(borg.social.list(LARGE_LIMIT));
  const skills = asRecords(borg.skills.list(LARGE_LIMIT));
  const mood = sessionIds.flatMap((s) => {
    const state = borg.mood.current(parseSessionId(s));
    return state === null || state === undefined ? [] : [state as unknown as RecordLike];
  });

  const creator = borg.entities.getCreator();

  return {
    schema: AKUKI_SNAPSHOT_SCHEMA,
    tenant: options.tenant,
    capturedAtMs: options.capturedAtMs,

    // The plottable state vector. Development shows up here as numbers moving,
    // which is the whole point of measuring before mechanising.
    counts: {
      episodes: episodes.length,
      semantic_nodes: semanticNodes.length,
      semantic_edges: semanticEdges.length,
      values: values.length,
      traits: traits.length,
      goals: goals.length,
      open_questions: openQuestions.length,
      growth_markers: growthMarkers.length,
      periods: periods.length,
      identity_events: identityEvents.length,
      commitments: commitments.length,
      entities: entities.length,
      social_profiles: socialProfiles.length,
      skills: skills.length,
    },
    openQuestionsByStatus: tally(openQuestions, "status"),
    openQuestionsBySource: tally(openQuestions, "source"),

    self: {
      values: values.map((r) => ({
        id: str(r.id), label: str(r.label), state: str(r.state),
        priority: num(r.priority), confidence: num(r.confidence),
        evidence_count: len(r.evidence_episode_ids),
      })),
      traits: traits.map((r) => ({
        id: str(r.id), label: str(r.label), state: str(r.state),
        strength: num(r.strength), confidence: num(r.confidence),
        evidence_count: len(r.evidence_episode_ids),
      })),
      goals: goals.map((r) => ({
        id: str(r.id), status: str(r.status), priority: num(r.priority),
        last_progress_ts: num(r.last_progress_ts),
      })),
      openQuestions: openQuestions.map((r) => ({
        id: str(r.id), question: str(r.question), status: str(r.status),
        urgency: num(r.urgency), source: str(r.source),
        rumination_ticks: num(r.unresolved_rumination_ticks),
        created_at: num(r.created_at),
      })),
      growthMarkers: growthMarkers.map((r) => ({
        id: str(r.id), ts: num(r.ts), category: str(r.category),
        confidence: num(r.confidence), source_process: str(r.source_process),
        what_changed: str(r.what_changed),
      })),
    },

    social: {
      profiles: socialProfiles.map((r) => ({
        entity_id: str(r.entity_id), trust: num(r.trust), attachment: num(r.attachment),
        interaction_count: num(r.interaction_count), commitment_count: num(r.commitment_count),
      })),
      creatorEntityId: creator === null ? null : (str((creator as unknown as RecordLike).id) ?? null),
    },

    // attempts/successes/failures ARE the Beta posterior: alpha = successes + 1,
    // beta = failures + 1. Stored as counts so the curve can be recomputed later.
    procedural: {
      skills: skills.map((r) => ({
        id: str(r.id), status: str(r.status), attempts: num(r.attempts),
        successes: num(r.successes), failures: num(r.failures),
      })),
    },

    affective: {
      mood: mood.map((r) => ({
        session_id: str(r.session_id), valence: num(r.valence), arousal: num(r.arousal),
      })),
    },
  };
}

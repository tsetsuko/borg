import type { SqliteDatabase } from "../../storage/sqlite/index.js";
import { SystemClock, type Clock } from "../../util/clock.js";
import { StorageError } from "../../util/errors.js";
import {
  createPredictionEventId,
  type EntityId,
  type EpisodeId,
  type PredictionEventId,
  type SessionId,
  type StreamEntryId,
} from "../../util/ids.js";
import { predictionEventSchema, type PredictionEvent } from "./types.js";

export type PredictionRepositoryOptions = {
  db: SqliteDatabase;
  clock?: Clock;
};

export type RecordExpectationInput = {
  id?: PredictionEventId;
  sessionId: SessionId;
  turnId: string;
  /** The expectation in the model's own words. */
  content: string;
  about?: string | null;
  aboutEntityId?: EntityId | null;
  /** Provenance label only -- who was present when it formed. Never a recall gate. */
  originAudience?: string | null;
  /** Stream entries of the forming turn; reconciliation boosts their episode(s). */
  sourceStreamIds?: readonly StreamEntryId[];
  now?: number;
};

export type ReconcileInput = {
  id?: PredictionEventId;
  /** The open expectation being resolved (its own event id). */
  predictionId: PredictionEventId;
  sessionId: SessionId;
  turnId: string;
  /** What actually happened, in the model's own words. */
  content: string;
  /** The model's own surprise appraisal (0..1). Stored verbatim, never derived here. */
  errorMagnitude: number;
  /** Episodes this outcome bears on, whose significance a consumer may boost. */
  episodeIds?: readonly EpisodeId[];
  about?: string | null;
  aboutEntityId?: EntityId | null;
  originAudience?: string | null;
  now?: number;
};

function mapRow(row: Record<string, unknown>): PredictionEvent {
  const parsed = predictionEventSchema.safeParse({
    id: row.id,
    prediction_id: row.prediction_id,
    kind: row.kind,
    created_ts: Number(row.created_ts),
    session_id: row.session_id,
    turn_id: row.turn_id,
    content: row.content,
    about: row.about === null || row.about === undefined ? null : row.about,
    about_entity_id:
      row.about_entity_id === null || row.about_entity_id === undefined ? null : row.about_entity_id,
    origin_audience:
      row.origin_audience === null || row.origin_audience === undefined ? null : row.origin_audience,
    error_magnitude:
      row.error_magnitude === null || row.error_magnitude === undefined
        ? null
        : Number(row.error_magnitude),
    episode_ids: JSON.parse(String(row.episode_ids ?? "[]")) as unknown,
    source_stream_ids: JSON.parse(String(row.source_stream_ids ?? "[]")) as unknown,
    created_at: Number(row.created_at),
  });

  if (!parsed.success) {
    throw new StorageError("Prediction event row failed validation", {
      cause: parsed.error,
      code: "PREDICTION_EVENT_ROW_INVALID",
    });
  }

  return parsed.data;
}

export class PredictionRepository {
  private readonly clock: Clock;

  constructor(private readonly options: PredictionRepositoryOptions) {
    this.clock = options.clock ?? new SystemClock();
  }

  private get db(): SqliteDatabase {
    return this.options.db;
  }

  private insert(row: {
    id: PredictionEventId;
    predictionId: PredictionEventId;
    kind: "expectation" | "reconciliation";
    sessionId: SessionId;
    turnId: string;
    content: string;
    about: string | null;
    aboutEntityId: EntityId | null;
    originAudience: string | null;
    errorMagnitude: number | null;
    episodeIds: readonly EpisodeId[];
    sourceStreamIds: readonly StreamEntryId[];
    now: number;
  }): { inserted: boolean } {
    const result = this.db
      .prepare(
        `
          INSERT INTO prediction_events (
            id, prediction_id, kind, created_ts, session_id, turn_id, content,
            about, about_entity_id, origin_audience, error_magnitude, episode_ids,
            source_stream_ids, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(prediction_id, kind) DO NOTHING
        `,
      )
      .run(
        row.id,
        row.predictionId,
        row.kind,
        row.now,
        row.sessionId,
        row.turnId,
        row.content,
        row.about,
        row.aboutEntityId,
        row.originAudience,
        row.errorMagnitude,
        JSON.stringify([...row.episodeIds]),
        JSON.stringify([...row.sourceStreamIds]),
        row.now,
      );

    return { inserted: result.changes > 0 };
  }

  private getByPredictionKind(
    predictionId: PredictionEventId,
    kind: "expectation" | "reconciliation",
  ): PredictionEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM prediction_events WHERE prediction_id = ? AND kind = ?`)
      .get(predictionId, kind) as Record<string, unknown> | undefined;

    return row === undefined ? null : mapRow(row);
  }

  /**
   * Record an expectation the entity now holds about what comes next. The row is
   * immutable: its id doubles as the prediction_id its later reconciliation cites,
   * so the expectation is locked before its outcome can be known.
   */
  recordExpectation(input: RecordExpectationInput): PredictionEvent {
    const now = input.now ?? this.clock.now();
    const id = input.id ?? createPredictionEventId();

    this.insert({
      id,
      predictionId: id,
      kind: "expectation",
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: input.content,
      about: input.about ?? null,
      aboutEntityId: input.aboutEntityId ?? null,
      originAudience: input.originAudience ?? null,
      errorMagnitude: null,
      episodeIds: [],
      sourceStreamIds: input.sourceStreamIds ?? [],
      now,
    });

    const stored = this.getByPredictionKind(id, "expectation");

    if (stored === null) {
      throw new StorageError("Prediction expectation vanished immediately after insert", {
        code: "PREDICTION_EXPECTATION_MISSING",
      });
    }

    return stored;
  }

  /**
   * Resolve an open expectation with the model's own surprise appraisal. Idempotent
   * per prediction: a second reconciliation of the same expectation is a no-op that
   * returns the first one.
   */
  reconcile(input: ReconcileInput): PredictionEvent {
    if (!Number.isFinite(input.errorMagnitude)) {
      throw new StorageError("Prediction reconcile requires a finite error magnitude", {
        code: "PREDICTION_ERROR_MAGNITUDE_INVALID",
      });
    }

    const expectation = this.getByPredictionKind(input.predictionId, "expectation");

    if (expectation === null) {
      throw new StorageError("Cannot reconcile a prediction with no open expectation", {
        code: "PREDICTION_EXPECTATION_MISSING",
      });
    }

    const now = input.now ?? this.clock.now();
    const id = input.id ?? createPredictionEventId();
    const errorMagnitude = Math.min(1, Math.max(0, input.errorMagnitude));

    this.insert({
      id,
      predictionId: input.predictionId,
      kind: "reconciliation",
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: input.content,
      about: input.about ?? null,
      aboutEntityId: input.aboutEntityId ?? null,
      originAudience: input.originAudience ?? null,
      errorMagnitude,
      episodeIds: input.episodeIds ?? [],
      sourceStreamIds: [],
      now,
    });

    const stored = this.getByPredictionKind(input.predictionId, "reconciliation");

    if (stored === null) {
      throw new StorageError("Prediction reconciliation vanished immediately after insert", {
        code: "PREDICTION_RECONCILIATION_MISSING",
      });
    }

    return stored;
  }

  /** The expectation row for a prediction, or null if none was recorded. */
  getExpectation(predictionId: PredictionEventId): PredictionEvent | null {
    return this.getByPredictionKind(predictionId, "expectation");
  }

  /** The reconciliation row for a prediction, or null if not yet reconciled. */
  getReconciliation(predictionId: PredictionEventId): PredictionEvent | null {
    return this.getByPredictionKind(predictionId, "reconciliation");
  }

  /**
   * Open expectations -- recorded, not yet reconciled. Global to the being by
   * design: recall is never gated by session or audience. `session_id` rides along
   * as a provenance label the caller may rank by, never as a filter here.
   */
  listOpen(input: { limit: number; sinceMs?: number }): PredictionEvent[] {
    const rows = this.db
      .prepare(
        `
          SELECT e.* FROM prediction_events e
          WHERE e.kind = 'expectation'
            AND (? IS NULL OR e.created_ts >= ?)
            AND NOT EXISTS (
              SELECT 1 FROM prediction_events r
              WHERE r.prediction_id = e.prediction_id AND r.kind = 'reconciliation'
            )
          ORDER BY e.created_ts DESC
          LIMIT ?
        `,
      )
      .all(input.sinceMs ?? null, input.sinceMs ?? null, input.limit) as Record<string, unknown>[];

    return rows.map(mapRow);
  }

  /**
   * Recent reconciliations about a given entity, newest first. Feeds M3's
   * partner-predictability: how surprised the entity has recently been about this
   * partner. Global recall -- no session or audience gate.
   */
  listReconciliationsForEntity(input: {
    aboutEntityId: EntityId;
    limit: number;
  }): PredictionEvent[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM prediction_events
          WHERE kind = 'reconciliation' AND about_entity_id = ?
          ORDER BY created_ts DESC
          LIMIT ?
        `,
      )
      .all(input.aboutEntityId, input.limit) as Record<string, unknown>[];

    return rows.map(mapRow);
  }

  /**
   * Reconciliations recorded after a cutoff, oldest first -- the scan order an
   * autonomy watermark advances through. Global, for the same reason listOpen is.
   */
  listReconciliationsSince(input: { sinceMs: number; limit: number }): PredictionEvent[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM prediction_events
          WHERE kind = 'reconciliation' AND created_ts > ?
          ORDER BY created_ts ASC
          LIMIT ?
        `,
      )
      .all(input.sinceMs, input.limit) as Record<string, unknown>[];

    return rows.map(mapRow);
  }
}

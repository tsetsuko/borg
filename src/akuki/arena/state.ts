// Durable transport state for the Bot Arena adapter.
//
// WHY THIS EXISTS AT ALL, given borg already stores a great deal: borg's v1
// delivery contract says external delivery is not auto-retried and there is no
// durable outbox (src/cognition/ingestion/enqueuer.ts:2). So "did this reply
// actually reach Bot Arena?" is a fact only the transport can hold. Everything
// else in here exists to serve that one question safely.
//
// THE STATE MACHINE, and the reason it has steps instead of one flag:
//
//   received -> reply_ready(text|null) -> published
//           |                        \-> abandoned
//           |-> skipped
//           \-> abandoned
//
// A single "processed" flag written after a successful POST would mean that a
// crash between running the turn and posting leaves the message looking unseen.
// The next poll would then run the turn AGAIN. That is worse than a duplicate
// post: a second turn writes a second set of identity events and a second
// prediction error into Akuki's memory, which falsifies the developmental record
// -- the one thing this project measures. So the reply text is committed BEFORE
// the POST, and a restart re-posts the stored text instead of re-thinking.
//
// `abandoned` is the honest name for the one case this cannot repair: a crash
// while the turn was in flight. borg may already have written part of that turn,
// so re-running it risks the same double-write. Such a row is never retried
// silently -- it is marked, logged, and left for a person to look at. At Arena
// volume (~20 messages/week) losing one reply is cheaper than corrupting the
// record it exists to produce.
//
// Uses node:sqlite (in Node since 22.5; this repo requires >=22.18) -- synchronous,
// single-writer, no native dependency to build on ARM. WAL means a `kill -9` of
// this process cannot lose a committed row; only an OS/power loss could.
//
// This file deliberately imports nothing from borg. It stores an opaque session id
// string, never a borg SessionId, so the transport half stays independent of borg's
// types (AC #4).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The four resting places a message can reach, kept distinct because each one
// answers a different operational question:
//   published -- the outbound decision was carried out. A null reply_text here
//                means Akuki chose silence, which is a real, handled outcome.
//   skipped   -- no turn was ever intended (Akuki's own post, a dead stream).
//   abandoned -- a turn WAS in flight and did not finish. Never retried.
export type ArenaMessageState =
  | "received"
  | "reply_ready"
  | "published"
  | "skipped"
  | "abandoned";

export type ArenaMessageRecord = {
  threadId: string;
  messageId: string;
  tsMs: number;
  state: ArenaMessageState;
  /** The composed reply. Null both before the turn runs and when Akuki stayed silent. */
  replyText: string | null;
};

/** A state a message can never leave: the floor may advance past it. */
const TERMINAL_STATES: readonly ArenaMessageState[] = ["published", "skipped", "abandoned"];

export function isTerminalState(state: ArenaMessageState): boolean {
  return TERMINAL_STATES.includes(state);
}

export class ArenaStateTransitionError extends Error {
  constructor(
    readonly threadId: string,
    readonly messageId: string,
    readonly from: ArenaMessageState | "missing",
    readonly to: ArenaMessageState,
  ) {
    super(`Illegal arena state transition ${from} -> ${to} for ${threadId}/${messageId}`);
    this.name = "ArenaStateTransitionError";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asState(value: unknown): ArenaMessageState {
  const raw = asString(value);
  switch (raw) {
    case "received":
    case "reply_ready":
    case "published":
    case "skipped":
    case "abandoned":
      return raw;
    default:
      // An unknown state is not a row to guess at. Treating it as abandoned keeps
      // the thread moving and keeps the anomaly visible instead of re-running a turn.
      return "abandoned";
  }
}

export class ArenaStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_state (
        thread_id  TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ts_ms      INTEGER NOT NULL,
        state      TEXT NOT NULL,
        reply_text TEXT,
        PRIMARY KEY (thread_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_state_thread_ts
        ON message_state (thread_id, ts_ms);
      CREATE INDEX IF NOT EXISTS idx_message_state_state
        ON message_state (state);
      CREATE TABLE IF NOT EXISTS thread_floor (
        thread_id TEXT PRIMARY KEY,
        ts_ms     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_session (
        thread_id  TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
    `);
  }

  // -- session mapping -------------------------------------------------------
  //
  // One Bot Arena thread is one conversation for Akuki's whole life, so the
  // session id must survive restarts. Generating it per run would split one
  // conversation into many and destroy the continuity every band reads.

  getSessionId(threadId: string): string | undefined {
    const row = this.db
      .prepare("SELECT session_id FROM thread_session WHERE thread_id = ?")
      .get(threadId);
    return row === undefined ? undefined : asString(row.session_id);
  }

  putSessionId(threadId: string, sessionId: string): void {
    this.db
      .prepare(
        "INSERT INTO thread_session (thread_id, session_id) VALUES (?, ?) " +
          "ON CONFLICT(thread_id) DO NOTHING",
      )
      .run(threadId, sessionId);
  }

  // -- floor -----------------------------------------------------------------
  //
  // Progress is a set of handled message ids plus a floor, not a bare timestamp.
  // Two messages can share a timestamp, a message can fail transiently, and a
  // streaming message can hang -- a bare high-water mark either skips those or
  // blocks the thread forever. The floor only advances across a contiguous run of
  // terminal rows, so a single stuck message holds the floor without stopping
  // later messages from being handled.

  getFloor(threadId: string): number | null {
    const row = this.db.prepare("SELECT ts_ms FROM thread_floor WHERE thread_id = ?").get(threadId);
    return row === undefined ? null : asNumber(row.ts_ms);
  }

  setFloor(threadId: string, tsMs: number): void {
    this.db
      .prepare(
        "INSERT INTO thread_floor (thread_id, ts_ms) VALUES (?, ?) " +
          "ON CONFLICT(thread_id) DO UPDATE SET ts_ms = excluded.ts_ms",
      )
      .run(threadId, tsMs);
  }

  /** Drop rows strictly below the floor: they can never be reconsidered. */
  pruneBelowFloor(threadId: string, tsMs: number): void {
    this.db
      .prepare("DELETE FROM message_state WHERE thread_id = ? AND ts_ms < ?")
      .run(threadId, tsMs);
  }

  // -- message state ---------------------------------------------------------

  get(threadId: string, messageId: string): ArenaMessageRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT thread_id, message_id, ts_ms, state, reply_text FROM message_state " +
          "WHERE thread_id = ? AND message_id = ?",
      )
      .get(threadId, messageId);
    if (row === undefined) {
      return undefined;
    }
    return {
      threadId: asString(row.thread_id),
      messageId: asString(row.message_id),
      tsMs: asNumber(row.ts_ms),
      state: asState(row.state),
      replyText: typeof row.reply_text === "string" ? row.reply_text : null,
    };
  }

  /**
   * Claim a message before the turn runs. Returns false when a row already
   * exists, which is what makes the poll loop idempotent: the caller skips a
   * message it has already claimed rather than racing itself.
   */
  markReceived(threadId: string, messageId: string, tsMs: number): boolean {
    const result = this.db
      .prepare(
        "INSERT INTO message_state (thread_id, message_id, ts_ms, state, reply_text) " +
          "VALUES (?, ?, ?, 'received', NULL) " +
          "ON CONFLICT(thread_id, message_id) DO NOTHING",
      )
      .run(threadId, messageId, tsMs);
    return result.changes > 0;
  }

  /**
   * Commit what Akuki decided, BEFORE anything is posted. `replyText` null means
   * he stayed silent; that still moves the row forward, because a silence is
   * handled, not pending.
   */
  markReplyReady(threadId: string, messageId: string, replyText: string | null): void {
    this.transition(threadId, messageId, "reply_ready", ["received"], replyText);
  }

  markPublished(threadId: string, messageId: string): void {
    this.transition(threadId, messageId, "published", ["reply_ready"]);
  }

  /**
   * Retire a message no turn was ever meant to run for: Akuki's own post (which
   * would otherwise loop) or a stream that never finalized.
   */
  markSkipped(threadId: string, messageId: string): void {
    this.transition(threadId, messageId, "skipped", ["received"]);
  }

  /** Give up on a message whose turn was in flight. See the header. */
  markAbandoned(threadId: string, messageId: string): void {
    this.transition(threadId, messageId, "abandoned", ["received", "reply_ready"]);
  }

  /** Rows whose reply is composed but not yet posted -- what a restart must finish. */
  listReplyReady(threadId: string): ArenaMessageRecord[] {
    return this.listByState(threadId, "reply_ready");
  }

  /**
   * Rows claimed but never resolved: a turn was in flight when the process died.
   * The service reports these at startup and abandons them rather than retrying.
   */
  listInFlight(threadId: string): ArenaMessageRecord[] {
    return this.listByState(threadId, "received");
  }

  close(): void {
    this.db.close();
  }

  private listByState(threadId: string, state: ArenaMessageState): ArenaMessageRecord[] {
    const rows = this.db
      .prepare(
        "SELECT thread_id, message_id, ts_ms, state, reply_text FROM message_state " +
          "WHERE thread_id = ? AND state = ? ORDER BY ts_ms ASC, message_id ASC",
      )
      .all(threadId, state);
    return rows.map((row) => ({
      threadId: asString(row.thread_id),
      messageId: asString(row.message_id),
      tsMs: asNumber(row.ts_ms),
      state: asState(row.state),
      replyText: typeof row.reply_text === "string" ? row.reply_text : null,
    }));
  }

  private transition(
    threadId: string,
    messageId: string,
    to: ArenaMessageState,
    from: readonly ArenaMessageState[],
    replyText?: string | null,
  ): void {
    const current = this.get(threadId, messageId);
    if (current === undefined) {
      throw new ArenaStateTransitionError(threadId, messageId, "missing", to);
    }
    if (!from.includes(current.state)) {
      // Refusing an out-of-order transition is the point of the machine: it turns
      // a silent double-post or a re-run turn into a loud, locatable failure.
      throw new ArenaStateTransitionError(threadId, messageId, current.state, to);
    }
    if (replyText === undefined) {
      this.db
        .prepare("UPDATE message_state SET state = ? WHERE thread_id = ? AND message_id = ?")
        .run(to, threadId, messageId);
      return;
    }
    this.db
      .prepare(
        "UPDATE message_state SET state = ?, reply_text = ? WHERE thread_id = ? AND message_id = ?",
      )
      .run(to, replyText, threadId, messageId);
  }
}

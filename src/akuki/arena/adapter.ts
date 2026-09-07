// The poll loop: Bot Arena in, Akuki out. Transport only.
//
// This file knows nothing about borg. It talks to Bot Arena over HTTP, keeps its
// own durable state, and hands normalized messages to an AkukiRunner. That is
// what makes the two halves separately reviewable, and boundary.test.ts fails the
// build if an import from borg ever appears here (AC #4).
//
// ROUTING IS STRUCTURAL, NOT CONTENT-BASED. Every final message in a thread Akuki
// is seated in is handed to the runner. There is no mention gate, no keyword
// match, no language detection -- the decision to answer or stay silent belongs to
// Akuki and M3, and CLAUDE.md's cardinal rule forbids the transport legislating
// it. The only structural guard is the self-skip: Akuki's own posts are retired
// without a turn, otherwise he would answer himself forever.
//
// ATTACHMENTS: counted and logged, never passed on. Akuki's isolation comes from
// borg exposing only memory tools, and pulling attachment bytes would widen that
// input surface. The log line is what keeps the omission observable (AC #8).
//
// FAILURE POLICY, which is deliberately asymmetric:
//   - a POST failure is retried, because posting again costs nothing but a
//     duplicate attempt and the stored reply is already final;
//   - a failure INSIDE the turn is never retried, because borg may already have
//     written part of that turn, and a second turn would double-write Akuki's
//     developmental record. Such a message is abandoned and logged.

import type { AkukiRunner, IncomingArenaMessage } from "./contract.js";
import type { BotArenaClient, BotArenaMessage, BotArenaThread } from "./botarena-client.js";
import type { PrincipalDirectory } from "./directory.js";
import { ArenaStateStore, isTerminalState } from "./state.js";

/**
 * A streaming message this much older than the newest message in its thread is
 * treated as a dead stream and retired, so a client that died mid-send cannot
 * hold the thread's floor forever.
 */
const STALE_STREAMING_MS = 5 * 60 * 1000;

export type ArenaLogLevel = "info" | "warn" | "error";
export type ArenaLog = (level: ArenaLogLevel, message: string) => void;

/** Only the calls the adapter actually makes, so tests need no HTTP at all. */
export type ArenaTransport = Pick<BotArenaClient, "listThreads" | "getMessages" | "postMessage">;

export type BotArenaAdapterOptions = {
  transport: ArenaTransport;
  runner: AkukiRunner;
  state: ArenaStateStore;
  directory: Pick<PrincipalDirectory, "nameOf">;
  /** Akuki's own Bot Arena bot id. Required for the self-skip.  */
  botId: string;
  /** Empty means every thread Akuki is seated in. */
  threadAllowlist?: ReadonlySet<string>;
  /**
   * False (default) marks the pre-existing window of a newly seen thread as
   * handled, so Akuki reacts only to what arrives after he comes online. True
   * replays that backlog -- which on first connection would answer history.
   */
  catchUpBacklog?: boolean;
  /** When true, run no turns and post nothing; just report what would happen. */
  dryRun?: boolean;
  now?: () => number;
  log?: ArenaLog;
};

export class BotArenaAdapter {
  private readonly threadAllowlist: ReadonlySet<string>;
  private readonly catchUpBacklog: boolean;
  private readonly dryRun: boolean;
  private readonly now: () => number;
  private readonly log: ArenaLog;

  constructor(private readonly options: BotArenaAdapterOptions) {
    this.threadAllowlist = options.threadAllowlist ?? new Set<string>();
    this.catchUpBacklog = options.catchUpBacklog ?? false;
    this.dryRun = options.dryRun ?? false;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /**
   * One-time recovery, to be called once before the first poll and never from
   * inside the loop: a row still in `received` means a turn was in flight when a
   * previous process died. Running this per poll would abandon the message the
   * current process is legitimately working on.
   */
  async recoverAfterRestart(): Promise<void> {
    for (const thread of await this.seatedThreads()) {
      for (const row of this.options.state.listInFlight(thread.id)) {
        this.options.state.markAbandoned(thread.id, row.messageId);
        this.log(
          "warn",
          `abandoned ${thread.id}/${row.messageId}: a turn was in flight at shutdown and is ` +
            `deliberately not retried, because borg may already hold part of it`,
        );
      }
      await this.publishPending(thread);
    }
  }

  async pollOnce(): Promise<void> {
    for (const thread of await this.seatedThreads()) {
      try {
        await this.pollThread(thread);
      } catch (error) {
        // One bad thread must not stop the others; the floor stays put, so the
        // next poll retries from the same place.
        this.log("error", `thread ${thread.id} failed: ${describe(error)}`);
      }
    }
  }

  private async seatedThreads(): Promise<BotArenaThread[]> {
    const threads = await this.options.transport.listThreads();
    return threads.filter(
      (thread) =>
        !thread.isArchived &&
        thread.participantBotIds.includes(this.options.botId) &&
        (this.threadAllowlist.size === 0 || this.threadAllowlist.has(thread.id)),
    );
  }

  private async pollThread(thread: BotArenaThread): Promise<void> {
    // Finish unposted replies before composing new ones, so a restart delivers in
    // order rather than answering a newer message first.
    await this.publishPending(thread);

    const fetched = await this.options.transport.getMessages(thread.id);
    if (fetched.length === 0) {
      return;
    }
    // The contiguous-prefix floor logic below assumes chronological order, and the
    // API's order is not part of any contract we verified.
    const messages = [...fetched].sort((left, right) => this.tsOf(left) - this.tsOf(right));
    const newestTs = this.tsOf(messages[messages.length - 1]);
    const floor = this.options.state.getFloor(thread.id);

    if (floor === null && !this.catchUpBacklog) {
      // A dry run must not write this: a floor recorded here would stop the FIRST
      // REAL run from doing its own first-sight marking, and it would then replay
      // the whole thread instead. A dry run that changes the next real run is not
      // a dry run.
      if (!this.dryRun) {
        this.options.state.setFloor(thread.id, newestTs);
      }
      this.log(
        "info",
        `thread ${thread.id}: first sight, ${messages.length} prior message(s) marked as before ` +
          `Akuki came online`,
      );
      return;
    }

    for (const message of messages) {
      const tsMs = this.tsOf(message);
      if (floor !== null && tsMs < floor) {
        continue;
      }
      if (this.options.state.get(thread.id, message.id) !== undefined) {
        continue;
      }
      await this.handle(thread, message, tsMs, newestTs);
    }

    if (!this.dryRun) {
      this.advanceFloor(thread, messages, floor);
    }
  }

  private async handle(
    thread: BotArenaThread,
    message: BotArenaMessage,
    tsMs: number,
    newestTs: number,
  ): Promise<void> {
    if (message.status !== "final") {
      if (newestTs - tsMs > STALE_STREAMING_MS) {
        this.claimAndSkip(thread, message, tsMs, "stream never finalized");
      }
      // Otherwise: no row is written at all, so the next poll reconsiders it.
      return;
    }

    if (message.senderId === this.options.botId) {
      this.claimAndSkip(thread, message, tsMs, "Akuki's own post");
      return;
    }

    if (message.attachments.length > 0) {
      // Logged rather than passed on -- see the header. Fields are metadata only;
      // no bytes are ever fetched.
      const described = message.attachments
        .map((attachment) => `${attachment.id}/${attachment.kind}/${attachment.size}B`)
        .join(", ");
      this.log(
        "info",
        `thread ${thread.id}/${message.id}: ${message.attachments.length} attachment(s) not ` +
          `passed to the turn (${described})`,
      );
    }

    if (this.dryRun) {
      this.log(
        "info",
        `[dry-run] would run a turn for ${thread.id}/${message.id} from ${message.senderId} ` +
          `(${message.text.length} chars)`,
      );
      return;
    }

    if (!this.options.state.markReceived(thread.id, message.id, tsMs)) {
      return;
    }

    const incoming = await this.normalize(thread, message, tsMs);

    let replyText: string | null;
    try {
      const reply = await this.options.runner.handleMessage(incoming);
      replyText = reply.text;
    } catch (error) {
      this.options.state.markAbandoned(thread.id, message.id);
      this.log(
        "error",
        `abandoned ${thread.id}/${message.id}: the turn failed and is not retried, because borg ` +
          `may already hold part of it: ${describe(error)}`,
      );
      return;
    }

    // Committed BEFORE the POST. This is the line that makes a crash cost at most
    // an unsent reply instead of a duplicated turn.
    this.options.state.markReplyReady(thread.id, message.id, replyText);

    if (replyText === null) {
      this.options.state.markPublished(thread.id, message.id);
      this.log("info", `thread ${thread.id}/${message.id}: Akuki stayed silent`);
      return;
    }

    await this.post(thread, message.id, replyText);
  }

  private claimAndSkip(
    thread: BotArenaThread,
    message: BotArenaMessage,
    tsMs: number,
    reason: string,
  ): void {
    if (!this.options.state.markReceived(thread.id, message.id, tsMs)) {
      return;
    }
    this.options.state.markSkipped(thread.id, message.id);
    if (message.senderId !== this.options.botId) {
      // Akuki's own posts are the common case and would drown the log.
      this.log("warn", `skipped ${thread.id}/${message.id}: ${reason}`);
    }
  }

  /**
   * Epoch millis for a message. An unparseable timestamp falls back to now, NOT
   * to zero: zero would put the message below any existing floor and drop it
   * without a trace, whereas "now" keeps it in play. NaN is excluded explicitly
   * because every NaN comparison is false, which would quietly disable both the
   * ordering and the floor for that one message.
   */
  private tsOf(message: BotArenaMessage | undefined): number {
    if (message === undefined) {
      return 0;
    }
    const parsed = Date.parse(message.createdAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    this.log("warn", `message ${message.id}: unparseable created_at ${JSON.stringify(message.createdAt)}`);
    return this.now();
  }

  private async normalize(
    thread: BotArenaThread,
    message: BotArenaMessage,
    tsMs: number,
  ): Promise<IncomingArenaMessage> {
    return {
      messageId: message.id,
      threadId: thread.id,
      threadName: thread.name,
      authorId: message.senderId,
      authorName: await this.options.directory.nameOf(message.senderId),
      text: message.text,
      createdAtMs: tsMs,
    };
  }

  /** Re-POST replies composed by an earlier attempt or an earlier process. */
  private async publishPending(thread: BotArenaThread): Promise<void> {
    if (this.dryRun) {
      return;
    }
    for (const row of this.options.state.listReplyReady(thread.id)) {
      if (row.replyText === null) {
        // Silence needs no transport; it only needs to stop being pending.
        this.options.state.markPublished(thread.id, row.messageId);
        continue;
      }
      await this.post(thread, row.messageId, row.replyText);
    }
  }

  private async post(
    thread: BotArenaThread,
    messageId: string,
    text: string,
  ): Promise<void> {
    try {
      const postedId = await this.options.transport.postMessage(thread.id, { text });
      this.options.state.markPublished(thread.id, messageId);
      this.log("info", `posted reply to ${thread.id} for ${messageId} as ${postedId ?? "unknown"}`);
    } catch (error) {
      // The row stays reply_ready, so the next poll retries the POST -- and the
      // floor cannot pass it, so nothing later is mistaken for complete.
      this.log("error", `post failed ${thread.id}/${messageId}, will retry: ${describe(error)}`);
    }
  }

  /**
   * Move the floor over the leading run of finished messages, then drop what is
   * below it. Stopping at the first unfinished message is the point: it is what
   * lets a stuck message be retried without replaying everything after it.
   */
  private advanceFloor(
    thread: BotArenaThread,
    messages: readonly BotArenaMessage[],
    floor: number | null,
  ): void {
    let advanced = floor ?? 0;
    for (const message of messages) {
      // Messages below the floor were already pruned, so they have no row. Without
      // this skip the very first pruned message would break the loop and the floor
      // would never advance again.
      if (floor !== null && this.tsOf(message) < floor) {
        continue;
      }
      const row = this.options.state.get(thread.id, message.id);
      if (row === undefined || !isTerminalState(row.state)) {
        break;
      }
      advanced = Math.max(advanced, row.tsMs);
    }
    if (floor === null || advanced > floor) {
      this.options.state.setFloor(thread.id, advanced);
      this.options.state.pruneBelowFloor(thread.id, advanced);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

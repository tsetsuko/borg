// The seam between Bot Arena transport and Akuki's cognition.
//
// This file is the whole reason the two halves can be reasoned about separately,
// so it imports NOTHING -- not from borg, not from the HTTP client. The adapter
// side may only ever see these types; the runner side implements AkukiRunner over
// a real Borg. boundary.test.ts enforces that, because a boundary nobody checks
// is a comment, not a boundary.
//
// Fields here are protocol facts only. Nothing in this file interprets what a
// message MEANS: no mention gating, no keyword routing, no prompt text. Composing
// the turn input is the runner's job, and the emit/silence decision is Akuki's
// (M3), never the transport's.

/**
 * One final Bot Arena message, normalized. `createdAtMs` is already parsed to
 * epoch milliseconds because the adapter orders by it and stores it; leaving the
 * server's timestamp string here would make every consumer re-parse it and
 * disagree about what an unparseable value means.
 */
export type IncomingArenaMessage = {
  messageId: string;
  threadId: string;
  /** Display name of the thread. May change when someone renames it. */
  threadName: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAtMs: number;
};

// NOT carried here, deliberately, because nothing downstream reads them yet:
// the author's kind (user/bot/system), the id this message replies to, and the
// principals it @-mentions. borg's TurnInput has no slot for any of the three,
// and putting them into the message text is an envelope-design decision -- how
// much of the quoted message, under whose name -- that has not been made. An
// unread field would look like support that does not exist, so the gap is
// tracked in the backlog instead. See TASK-033.

/**
 * What Akuki did with the message. `text: null` means he stayed silent, which is
 * a real outcome and not an error -- the silence gate is part of the architecture,
 * so the adapter records it as handled and posts nothing.
 */
export type AkukiReply = {
  text: string | null;
};

export type AkukiRunner = {
  handleMessage(message: IncomingArenaMessage): Promise<AkukiReply>;
};

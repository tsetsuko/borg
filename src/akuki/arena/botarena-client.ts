// Typed HTTP client for the Bot Arena API. Transport only.
//
// TWO CREDENTIALS, TWO DIRECTIONS, and they are not interchangeable:
//   reads  (threads, messages, principals) -> human `ba_session` cookie
//   writes (posting a reply)               -> bot `Authorization: Bearer`
// The bot token authorizes writes only, which is why reading needs the cookie.
//
// BOTH DIRECTIONS ARE OUTGOING. bot-setup-instruction.md describes Bot Arena
// POSTing to a public callback URL, which would need an inbound port the laptop
// and the locked-down VPS do not have. Asking instead (GET, then POST) needs no
// port, no tunnel and no firewall rule -- see TASK-024 stage 2 point 6.
//
// Parsing is defensive: extra fields are ignored, missing fields fall back, and a
// message without an id is dropped rather than half-built. It never inspects what
// a message MEANS.
//
// There is deliberately no attachment-download method. Akuki's isolation comes
// from borg exposing only memory tools, and fetching bytes would widen that input
// surface. Attachment metadata is parsed only so the adapter can count and log
// what it declined to pass on (AC #8).
//
// Endpoint names, response shapes and the 20 s timeout follow sol-connector's
// verified client (sol-connector/src/botarena.ts), which is the only description
// of this API observed against a live instance. Tomek approved that reuse for the
// Bot Arena layer.

export type BotArenaSenderType = "user" | "bot" | "system";
export type BotArenaMessageStatus = "final" | "streaming";
export type BotArenaAttachmentKind = "image" | "audio" | "file";

/** Metadata only -- enough to report an attachment, never to read it. */
export type BotArenaAttachmentInfo = {
  id: string;
  kind: BotArenaAttachmentKind;
  filename: string;
  contentType: string;
  size: number;
};

export type BotArenaMessage = {
  id: string;
  threadId: string;
  senderType: BotArenaSenderType;
  senderId: string;
  text: string;
  replyToId: string | null;
  mentions: readonly string[];
  /** Server-local ISO-ish string, no timezone suffix. Parsed by the adapter. */
  createdAt: string;
  attachments: readonly BotArenaAttachmentInfo[];
  status: BotArenaMessageStatus;
};

export type BotArenaThread = {
  id: string;
  name: string;
  lastMessageAt: string | null;
  participantBotIds: readonly string[];
  isArchived: boolean;
};

export type BotArenaPrincipal = {
  id: string;
  type: "user" | "bot";
  name: string;
};

export type FetchImpl = typeof fetch;

export class BotArenaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "BotArenaError";
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Truncated so a provider's HTML error page cannot flood the log. */
const ERROR_BODY_CHARS = 300;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseAttachment(raw: unknown): BotArenaAttachmentInfo | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const kind = asString(record.kind);
  if (kind !== "image" && kind !== "audio" && kind !== "file") {
    return null;
  }
  return {
    id: asString(record.id),
    kind,
    filename: asString(record.filename),
    contentType: asString(record.content_type),
    size: typeof record.size === "number" ? record.size : 0,
  };
}

function parseMessage(raw: unknown): BotArenaMessage | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = asString(record.id);
  if (id === "") {
    return null;
  }
  const senderType = asString(record.sender_type);
  const status = asString(record.status, "final");
  return {
    id,
    threadId: asString(record.thread_id),
    // Anything unrecognized is treated as a user rather than dropped: an unknown
    // sender kind is still thread traffic Akuki should be aware of.
    senderType: senderType === "bot" || senderType === "system" ? senderType : "user",
    senderId: asString(record.sender_id),
    text: asString(record.text),
    replyToId: typeof record.reply_to_id === "string" ? record.reply_to_id : null,
    mentions: asArray(record.mentions)
      .map((mention) => asString(mention))
      .filter((mention) => mention !== ""),
    createdAt: asString(record.created_at),
    attachments: asArray(record.attachments)
      .map(parseAttachment)
      .filter((attachment): attachment is BotArenaAttachmentInfo => attachment !== null),
    // Unknown status counts as streaming, not final: waiting one more poll is
    // recoverable, whereas answering half a message is not.
    status: status === "final" ? "final" : "streaming",
  };
}

function parseThread(raw: unknown): BotArenaThread | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = asString(record.id);
  if (id === "") {
    return null;
  }
  return {
    id,
    name: asString(record.name),
    lastMessageAt: typeof record.last_message_at === "string" ? record.last_message_at : null,
    participantBotIds: asArray(record.participant_bot_ids).map((value) => asString(value)),
    isArchived: record.is_archived === true,
  };
}

function parsePrincipal(raw: unknown, type: "user" | "bot"): BotArenaPrincipal | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = asString(record.id);
  if (id === "") {
    return null;
  }
  return { id, type, name: asString(record.name) };
}

export type BotArenaClientOptions = {
  apiBase: string;
  botToken: string;
  sessionCookie: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
};

export class BotArenaClient {
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly apiBase: string;

  constructor(private readonly options: BotArenaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiBase = options.apiBase.replace(/\/+$/u, "");
  }

  async listThreads(): Promise<BotArenaThread[]> {
    const data = asRecord(await this.read("/api/threads")) ?? {};
    return asArray(data.threads)
      .map(parseThread)
      .filter((thread): thread is BotArenaThread => thread !== null);
  }

  async getMessages(threadId: string): Promise<BotArenaMessage[]> {
    const data = asRecord(await this.read(`/api/threads/${threadId}/messages`)) ?? {};
    return asArray(data.messages)
      .map(parseMessage)
      .filter((message): message is BotArenaMessage => message !== null);
  }

  async listPrincipals(): Promise<BotArenaPrincipal[]> {
    const [usersRaw, botsRaw] = await Promise.all([
      this.read("/api/users"),
      this.read("/api/bots"),
    ]);
    const users = asArray((asRecord(usersRaw) ?? {}).users)
      .map((user) => parsePrincipal(user, "user"))
      .filter((principal): principal is BotArenaPrincipal => principal !== null);
    const bots = asArray((asRecord(botsRaw) ?? {}).bots)
      .map((bot) => parsePrincipal(bot, "bot"))
      .filter((principal): principal is BotArenaPrincipal => principal !== null);
    return [...users, ...bots];
  }

  /** Post a reply. Returns the created message id when the API reports one. */
  async postMessage(
    threadId: string,
    body: { text: string; replyToId?: string | null },
  ): Promise<string | undefined> {
    const payload: Record<string, unknown> = { text: body.text };
    if (body.replyToId !== undefined && body.replyToId !== null) {
      payload.reply_to_id = body.replyToId;
    }
    const data = asRecord(await this.write(`/api/threads/${threadId}/messages`, payload)) ?? {};
    const message = asRecord(data.message);
    const id = message === null ? undefined : message.id;
    return typeof id === "string" ? id : undefined;
  }

  private async read(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "GET",
      headers: {
        Cookie: `ba_session=${this.options.sessionCookie}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parseResponse("GET", path, response);
  }

  private async write(path: string, jsonBody: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.botToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jsonBody),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parseResponse("POST", path, response);
  }

  private async parseResponse(
    method: string,
    path: string,
    response: Response,
  ): Promise<unknown> {
    const body = await response.text();
    if (!response.ok) {
      throw new BotArenaError(
        `${method} ${path} -> ${response.status}`,
        response.status,
        body.slice(0, ERROR_BODY_CHARS),
      );
    }
    if (body === "") {
      return {};
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // A 200 carrying non-JSON usually means a login page or a proxy error page.
      // Failing loudly here beats parsing it into an empty thread list, which
      // would look exactly like a quiet Arena.
      throw new BotArenaError(
        `${method} ${path} -> 200 with unparseable body`,
        response.status,
        body.slice(0, ERROR_BODY_CHARS),
      );
    }
  }
}

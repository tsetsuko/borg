import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotArenaAdapter, type ArenaTransport } from "./adapter.js";
import type { BotArenaMessage, BotArenaThread } from "./botarena-client.js";
import type { AkukiReply, AkukiRunner, IncomingArenaMessage } from "./contract.js";
import { ArenaStateStore } from "./state.js";

const AKUKI_BOT_ID = "bot-akuki";

function thread(overrides: Partial<BotArenaThread> = {}): BotArenaThread {
  return {
    id: "t1",
    name: "arena-general",
    lastMessageAt: null,
    participantBotIds: [AKUKI_BOT_ID],
    isArchived: false,
    ...overrides,
  };
}

function message(overrides: Partial<BotArenaMessage> = {}): BotArenaMessage {
  return {
    id: "m1",
    threadId: "t1",
    senderType: "user",
    senderId: "u-zosia",
    text: "hej",
    replyToId: null,
    mentions: [],
    createdAt: "2026-09-04T10:00:00.000Z",
    attachments: [],
    status: "final",
    ...overrides,
  };
}

type FakeTransport = ArenaTransport & {
  posted: { threadId: string; text: string }[];
  messages: BotArenaMessage[];
  threads: BotArenaThread[];
  failPost: boolean;
};

function fakeTransport(init: Partial<Pick<FakeTransport, "threads" | "messages">> = {}): FakeTransport {
  const state: FakeTransport = {
    posted: [],
    messages: init.messages ?? [],
    threads: init.threads ?? [thread()],
    failPost: false,
    listThreads: async () => state.threads,
    getMessages: async () => state.messages,
    postMessage: async (threadId, body) => {
      if (state.failPost) {
        throw new Error("arena unreachable");
      }
      state.posted.push({ threadId, text: body.text });
      return `posted-${state.posted.length}`;
    },
  };
  return state;
}

type FakeRunner = AkukiRunner & { seen: IncomingArenaMessage[] };

function fakeRunner(reply: (m: IncomingArenaMessage) => AkukiReply | Promise<AkukiReply>): FakeRunner {
  const seen: IncomingArenaMessage[] = [];
  return {
    seen,
    handleMessage: async (incoming) => {
      seen.push(incoming);
      return reply(incoming);
    },
  };
}

const directory = { nameOf: async (id: string) => `name-of-${id}` };

let dir: string;
let store: ArenaStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "akuki-arena-adapter-"));
  store = new ArenaStateStore(join(dir, "state.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function build(
  transport: ArenaTransport,
  runner: AkukiRunner,
  overrides: Partial<ConstructorParameters<typeof BotArenaAdapter>[0]> = {},
): BotArenaAdapter {
  return new BotArenaAdapter({
    transport,
    runner,
    state: store,
    directory,
    botId: AKUKI_BOT_ID,
    now: () => 1_800_000_000_000,
    ...overrides,
  });
}

describe("thread selection", () => {
  it("ignores threads Akuki is not seated in, archived ones, and non-allowlisted ones", async () => {
    const transport = fakeTransport({
      threads: [
        thread({ id: "seated" }),
        thread({ id: "not-seated", participantBotIds: ["bot-sol"] }),
        thread({ id: "archived", isArchived: true }),
        thread({ id: "other-seated" }),
      ],
      messages: [message()],
    });
    const seen: string[] = [];
    const adapter = build(transport, fakeRunner(() => ({ text: null })), {
      threadAllowlist: new Set(["seated"]),
      log: (_level, text) => seen.push(text),
    });

    await adapter.pollOnce();

    expect(seen.filter((line) => line.includes("first sight"))).toHaveLength(1);
    expect(seen.some((line) => line.includes("thread seated:"))).toBe(true);
  });
});

describe("first sight", () => {
  it("marks the existing window as before Akuki came online and runs no turn", async () => {
    const transport = fakeTransport({
      messages: [message({ id: "old-1" }), message({ id: "old-2" })],
    });
    const runner = fakeRunner(() => ({ text: "should not happen" }));
    const adapter = build(transport, runner);

    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(0);
    expect(transport.posted).toHaveLength(0);
    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T10:00:00.000Z"));
  });

  it("replays the backlog when catch-up is switched on", async () => {
    const transport = fakeTransport({ messages: [message({ id: "old-1" })] });
    const runner = fakeRunner(() => ({ text: "odpowiedź" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(runner.seen.map((m) => m.messageId)).toEqual(["old-1"]);
  });
});

describe("routing", () => {
  it("hands every final foreign message to the runner without inspecting content", async () => {
    const transport = fakeTransport();
    const runner = fakeRunner(() => ({ text: "ok" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    transport.messages = [
      message({ id: "no-mention", text: "coś zupełnie nie o Akukim" }),
      message({ id: "from-a-bot", senderId: "bot-sol", senderType: "bot" }),
      message({ id: "mentioning", mentions: [AKUKI_BOT_ID] }),
    ];

    await adapter.pollOnce();

    expect(runner.seen.map((m) => m.messageId)).toEqual([
      "no-mention",
      "from-a-bot",
      "mentioning",
    ]);
  });

  it("never runs a turn for Akuki's own post", async () => {
    const transport = fakeTransport({
      messages: [message({ id: "mine", senderId: AKUKI_BOT_ID, senderType: "bot" })],
    });
    const runner = fakeRunner(() => ({ text: "loop!" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(0);
    expect(store.get("t1", "mine")?.state).toBe("skipped");
  });

  it("normalizes only the fields something downstream reads (see TASK-033)", async () => {
    const transport = fakeTransport({
      messages: [message({ replyToId: "m0", mentions: ["u-x"] })],
    });
    const runner = fakeRunner(() => ({ text: null }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(runner.seen[0]).toEqual({
      messageId: "m1",
      threadId: "t1",
      threadName: "arena-general",
      authorId: "u-zosia",
      authorName: "name-of-u-zosia",
      text: "hej",
      createdAtMs: Date.parse("2026-09-04T10:00:00.000Z"),
    });
  });
});

describe("streaming messages", () => {
  it("leaves a fresh streaming message for the next poll", async () => {
    const transport = fakeTransport({
      messages: [message({ id: "streaming", status: "streaming" })],
    });
    const runner = fakeRunner(() => ({ text: "too early" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(0);
    expect(store.get("t1", "streaming")).toBeUndefined();

    transport.messages = [message({ id: "streaming", status: "final" })];
    await adapter.pollOnce();

    expect(runner.seen.map((m) => m.messageId)).toEqual(["streaming"]);
  });

  it("retires a dead stream so it cannot hold the thread forever", async () => {
    const transport = fakeTransport({
      messages: [
        message({ id: "dead", status: "streaming", createdAt: "2026-09-04T10:00:00.000Z" }),
        message({ id: "later", createdAt: "2026-09-04T10:30:00.000Z" }),
      ],
    });
    const runner = fakeRunner(() => ({ text: "ok" }));
    const logged: string[] = [];
    const adapter = build(transport, runner, {
      catchUpBacklog: true,
      log: (_level, text) => logged.push(text),
    });

    await adapter.pollOnce();

    expect(logged.some((line) => line.includes("stream never finalized"))).toBe(true);
    expect(runner.seen.map((m) => m.messageId)).toEqual(["later"]);
    // Retiring the dead stream is what lets the floor pass it; the row is then
    // pruned away precisely because it can never be reconsidered.
    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T10:30:00.000Z"));
    expect(store.get("t1", "dead")).toBeUndefined();
  });
});

describe("publishing", () => {
  it("commits the reply before posting and marks it published after", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "cześć" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(transport.posted).toEqual([{ threadId: "t1", text: "cześć" }]);
    expect(store.get("t1", "m1")?.state).toBe("published");
  });

  it("records silence as handled and posts nothing", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: null }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(transport.posted).toHaveLength(0);
    const row = store.get("t1", "m1");
    expect(row?.state).toBe("published");
    expect(row?.replyText).toBeNull();
  });

  it("retries only the post after a transport failure, never the turn", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "jedna odpowiedź" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    transport.failPost = true;
    await adapter.pollOnce();

    expect(store.get("t1", "m1")?.state).toBe("reply_ready");
    expect(store.getFloor("t1")).toBe(0);

    transport.failPost = false;
    await adapter.pollOnce();

    // Exactly one turn, exactly one post: the stored text was re-sent, not re-thought.
    expect(runner.seen).toHaveLength(1);
    expect(transport.posted).toEqual([{ threadId: "t1", text: "jedna odpowiedź" }]);
    expect(store.get("t1", "m1")?.state).toBe("published");
  });

  it("does not answer the same message twice across polls", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "raz" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();
    await adapter.pollOnce();
    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(1);
    expect(transport.posted).toHaveLength(1);
  });
});

describe("failures inside the turn", () => {
  it("abandons the message instead of re-running a turn borg may already hold", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => {
      throw new Error("cognition blew up");
    });
    const logged: string[] = [];
    const adapter = build(transport, runner, {
      catchUpBacklog: true,
      log: (_level, text) => logged.push(text),
    });

    await adapter.pollOnce();
    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(1);
    expect(store.get("t1", "m1")?.state).toBe("abandoned");
    expect(logged.some((line) => line.includes("not retried"))).toBe(true);
  });

  it("keeps polling other threads when one thread fails", async () => {
    const transport = fakeTransport({
      threads: [thread({ id: "broken" }), thread({ id: "fine" })],
    });
    transport.getMessages = async (threadId: string) => {
      if (threadId === "broken") {
        throw new Error("boom");
      }
      return [message({ threadId: "fine" })];
    };
    const runner = fakeRunner(() => ({ text: "ok" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(runner.seen.map((m) => m.threadId)).toEqual(["fine"]);
  });
});

describe("restart recovery", () => {
  it("posts a reply composed before the crash without running a second turn", async () => {
    store.markReceived("t1", "m1", Date.parse("2026-09-04T10:00:00.000Z"));
    store.markReplyReady("t1", "m1", "napisane przed awarią");
    store.setFloor("t1", 0);

    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "nie powinno się zdarzyć" }));
    const adapter = build(transport, runner);

    await adapter.recoverAfterRestart();

    expect(transport.posted).toEqual([{ threadId: "t1", text: "napisane przed awarią" }]);
    expect(runner.seen).toHaveLength(0);
    expect(store.get("t1", "m1")?.state).toBe("published");
  });

  it("abandons a turn that was in flight at shutdown", async () => {
    store.markReceived("t1", "m1", Date.parse("2026-09-04T10:00:00.000Z"));
    store.setFloor("t1", 0);

    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "nie" }));
    const logged: string[] = [];
    const adapter = build(transport, runner, { log: (_level, text) => logged.push(text) });

    await adapter.recoverAfterRestart();
    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(0);
    expect(store.get("t1", "m1")?.state).toBe("abandoned");
    expect(logged.some((line) => line.includes("in flight at shutdown"))).toBe(true);
  });
});

describe("floor", () => {
  it("stops at the first unfinished message but still handles later ones", async () => {
    const first = message({ id: "stuck", createdAt: "2026-09-04T10:00:00.000Z" });
    const second = message({ id: "ok", createdAt: "2026-09-04T10:05:00.000Z" });
    const transport = fakeTransport({ messages: [first, second] });
    const runner = fakeRunner((incoming) => {
      if (incoming.messageId === "stuck") {
        throw new Error("only this one fails");
      }
      return { text: "ok" };
    });
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    // A failed turn is abandoned, and abandoned is terminal, so the floor is free
    // to move past both -- the later message is not held hostage by the earlier one.
    expect(runner.seen.map((m) => m.messageId)).toEqual(["stuck", "ok"]);
    expect(transport.posted).toEqual([{ threadId: "t1", text: "ok" }]);
    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T10:05:00.000Z"));
  });

  it("prunes rows strictly below the floor and keeps the boundary and the unfinished", async () => {
    const transport = fakeTransport({
      messages: [
        message({ id: "oldest", createdAt: "2026-09-04T10:00:00.000Z" }),
        message({ id: "at-floor", createdAt: "2026-09-04T10:05:00.000Z" }),
        message({ id: "unfinished", createdAt: "2026-09-04T10:10:00.000Z" }),
      ],
    });
    const runner = fakeRunner(() => ({ text: "ok" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    // The third post fails, so the floor stops at the second message.
    let posts = 0;
    transport.postMessage = async (threadId, body) => {
      posts += 1;
      if (posts > 2) {
        throw new Error("arena unreachable");
      }
      transport.posted.push({ threadId, text: body.text });
      return `posted-${posts}`;
    };

    await adapter.pollOnce();

    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T10:05:00.000Z"));
    expect(store.get("t1", "oldest")).toBeUndefined();
    // Equal to the floor is not below it, so this row stays.
    expect(store.get("t1", "at-floor")?.state).toBe("published");
    expect(store.get("t1", "unfinished")?.state).toBe("reply_ready");
  });

  it("holds the floor at an unposted reply and keeps advancing once it lands", async () => {
    const first = message({ id: "unposted", createdAt: "2026-09-04T10:00:00.000Z" });
    const transport = fakeTransport({ messages: [first] });
    const runner = fakeRunner(() => ({ text: "czeka" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    transport.failPost = true;
    await adapter.pollOnce();
    expect(store.getFloor("t1")).toBe(0);

    transport.failPost = false;
    await adapter.pollOnce();
    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T10:00:00.000Z"));
  });

  it("keeps advancing after pruning has removed the older rows", async () => {
    const transport = fakeTransport();
    const runner = fakeRunner(() => ({ text: "ok" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    transport.messages = [message({ id: "a", createdAt: "2026-09-04T10:00:00.000Z" })];
    await adapter.pollOnce();
    const firstFloor = store.getFloor("t1");

    // The API keeps returning the old message; its row is now pruned away.
    transport.messages = [
      message({ id: "a", createdAt: "2026-09-04T10:00:00.000Z" }),
      message({ id: "b", createdAt: "2026-09-04T11:00:00.000Z" }),
    ];
    await adapter.pollOnce();

    expect(firstFloor).toBe(Date.parse("2026-09-04T10:00:00.000Z"));
    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T11:00:00.000Z"));
    expect(runner.seen.map((m) => m.messageId)).toEqual(["a", "b"]);
  });

  it("handles two messages sharing one timestamp", async () => {
    const transport = fakeTransport({
      messages: [
        message({ id: "same-1", createdAt: "2026-09-04T10:00:00.000Z" }),
        message({ id: "same-2", createdAt: "2026-09-04T10:00:00.000Z" }),
      ],
    });
    const runner = fakeRunner(() => ({ text: "ok" }));
    const adapter = build(transport, runner, { catchUpBacklog: true });

    await adapter.pollOnce();

    expect(runner.seen.map((m) => m.messageId)).toEqual(["same-1", "same-2"]);
    expect(transport.posted).toHaveLength(2);
  });
});

describe("attachments", () => {
  it("logs what it declined to pass and passes only the text", async () => {
    const transport = fakeTransport({
      messages: [
        message({
          attachments: [
            { id: "a1", kind: "image", filename: "x.png", contentType: "image/png", size: 4096 },
          ],
        }),
      ],
    });
    const runner = fakeRunner(() => ({ text: "ok" }));
    const logged: string[] = [];
    const adapter = build(transport, runner, {
      catchUpBacklog: true,
      log: (_level, text) => logged.push(text),
    });

    await adapter.pollOnce();

    expect(logged.some((line) => line.includes("attachment(s) not passed"))).toBe(true);
    expect(logged.some((line) => line.includes("a1/image/4096B"))).toBe(true);
    expect(Object.keys(runner.seen[0] ?? {})).not.toContain("attachments");
  });
});

describe("dry run", () => {
  it("reports what it would do and touches neither the runner, the arena nor the state", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "nie wysyłaj" }));
    const logged: string[] = [];
    const adapter = build(transport, runner, {
      catchUpBacklog: true,
      dryRun: true,
      log: (_level, text) => logged.push(text),
    });

    await adapter.pollOnce();

    expect(runner.seen).toHaveLength(0);
    expect(transport.posted).toHaveLength(0);
    expect(store.get("t1", "m1")).toBeUndefined();
    expect(logged.some((line) => line.includes("[dry-run] would run a turn"))).toBe(true);
  });

  it("records no floor, so it cannot change what the first real run does", async () => {
    const transport = fakeTransport({ messages: [message()] });
    const runner = fakeRunner(() => ({ text: "nie wysyłaj" }));

    // Default catch-up (off) is the first-sight path, which is exactly the branch
    // that would otherwise write a floor and make the first real run replay the
    // thread instead of marking it as history.
    const dry = build(transport, runner, { dryRun: true, log: () => {} });
    await dry.pollOnce();

    expect(store.getFloor("t1")).toBeNull();

    const live = build(transport, runner, { log: () => {} });
    await live.pollOnce();

    expect(runner.seen).toHaveLength(0);
    expect(store.getFloor("t1")).toBe(Date.parse("2026-09-04T10:00:00.000Z"));
  });
});

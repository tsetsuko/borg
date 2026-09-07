import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArenaStateStore,
  ArenaStateTransitionError,
  isTerminalState,
} from "./state.js";

let dir: string;
let store: ArenaStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "akuki-arena-state-"));
  store = new ArenaStateStore(join(dir, "nested", "state.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ArenaStateStore claiming", () => {
  it("claims a message once and refuses a second claim", () => {
    expect(store.markReceived("t1", "m1", 1000)).toBe(true);
    expect(store.markReceived("t1", "m1", 1000)).toBe(false);
    expect(store.get("t1", "m1")?.state).toBe("received");
  });

  it("keeps the same message id in different threads apart", () => {
    expect(store.markReceived("t1", "m1", 1000)).toBe(true);
    expect(store.markReceived("t2", "m1", 1000)).toBe(true);
  });
});

describe("ArenaStateStore transitions", () => {
  it("carries the reply text through reply_ready to published", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", "cześć");

    const ready = store.get("t1", "m1");
    expect(ready?.state).toBe("reply_ready");
    expect(ready?.replyText).toBe("cześć");

    store.markPublished("t1", "m1");

    const published = store.get("t1", "m1");
    expect(published?.state).toBe("published");
    // The text is kept after publishing on purpose: it is the evidence of what
    // was actually sent, which a log line alone does not durably provide.
    expect(published?.replyText).toBe("cześć");
  });

  it("treats silence as handled, not pending", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", null);
    store.markPublished("t1", "m1");

    const record = store.get("t1", "m1");
    expect(record?.state).toBe("published");
    expect(record?.replyText).toBeNull();
  });

  it("refuses to publish a message whose turn never ran", () => {
    store.markReceived("t1", "m1", 1000);
    expect(() => store.markPublished("t1", "m1")).toThrow(ArenaStateTransitionError);
  });

  it("refuses to publish the same message twice", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", "raz");
    store.markPublished("t1", "m1");
    expect(() => store.markPublished("t1", "m1")).toThrow(ArenaStateTransitionError);
  });

  it("refuses to run a second turn for a message that already has a reply", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", "raz");
    expect(() => store.markReplyReady("t1", "m1", "dwa")).toThrow(ArenaStateTransitionError);
  });

  it("refuses a transition on a message it never claimed", () => {
    expect(() => store.markReplyReady("t1", "ghost", "x")).toThrow(ArenaStateTransitionError);
  });
});

describe("ArenaStateStore restart recovery", () => {
  it("reports a composed-but-unposted reply so a restart can finish it", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", "nieopublikowane");
    store.markReceived("t1", "m2", 2000);

    const pending = store.listReplyReady("t1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.messageId).toBe("m1");
    expect(pending[0]?.replyText).toBe("nieopublikowane");
  });

  it("reports a turn that was in flight when the process died", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", "done");
    store.markPublished("t1", "m1");
    store.markReceived("t1", "m2", 2000);

    const inFlight = store.listInFlight("t1");
    expect(inFlight.map((row) => row.messageId)).toEqual(["m2"]);
  });

  it("retires a message no turn was meant for, and keeps it distinct from abandoned", () => {
    store.markReceived("t1", "own-post", 1000);
    store.markSkipped("t1", "own-post");

    expect(store.get("t1", "own-post")?.state).toBe("skipped");
    expect(store.listInFlight("t1")).toHaveLength(0);
    expect(isTerminalState("skipped")).toBe(true);
  });

  it("refuses to retire a message whose turn already produced a reply", () => {
    store.markReceived("t1", "m1", 1000);
    store.markReplyReady("t1", "m1", "już pomyślane");
    expect(() => store.markSkipped("t1", "m1")).toThrow(ArenaStateTransitionError);
  });

  it("abandons an in-flight message without letting it be re-run", () => {
    store.markReceived("t1", "m1", 1000);
    store.markAbandoned("t1", "m1");

    expect(store.get("t1", "m1")?.state).toBe("abandoned");
    expect(store.listInFlight("t1")).toHaveLength(0);
    expect(() => store.markReplyReady("t1", "m1", "late")).toThrow(ArenaStateTransitionError);
  });

  it("survives reopening the same file", () => {
    const path = join(dir, "reopen.db");
    const first = new ArenaStateStore(path);
    first.markReceived("t1", "m1", 1000);
    first.markReplyReady("t1", "m1", "przetrwaj");
    first.putSessionId("t1", "session-abc");
    first.setFloor("t1", 900);
    first.close();

    const second = new ArenaStateStore(path);
    try {
      expect(second.get("t1", "m1")?.replyText).toBe("przetrwaj");
      expect(second.getSessionId("t1")).toBe("session-abc");
      expect(second.getFloor("t1")).toBe(900);
    } finally {
      second.close();
    }
  });
});

describe("ArenaStateStore session mapping", () => {
  it("keeps the first session id for a thread", () => {
    expect(store.getSessionId("t1")).toBeUndefined();
    store.putSessionId("t1", "first");
    store.putSessionId("t1", "second");
    expect(store.getSessionId("t1")).toBe("first");
  });
});

describe("ArenaStateStore floor", () => {
  it("starts with no floor and stores the one it is given", () => {
    expect(store.getFloor("t1")).toBeNull();
    store.setFloor("t1", 500);
    expect(store.getFloor("t1")).toBe(500);
    store.setFloor("t1", 900);
    expect(store.getFloor("t1")).toBe(900);
  });

  it("prunes only rows strictly below the floor", () => {
    store.markReceived("t1", "old", 100);
    store.markReceived("t1", "edge", 500);
    store.markReceived("t1", "new", 900);

    store.pruneBelowFloor("t1", 500);

    expect(store.get("t1", "old")).toBeUndefined();
    expect(store.get("t1", "edge")?.messageId).toBe("edge");
    expect(store.get("t1", "new")?.messageId).toBe("new");
  });

  it("prunes only inside the given thread", () => {
    store.markReceived("t1", "m1", 100);
    store.markReceived("t2", "m1", 100);

    store.pruneBelowFloor("t1", 500);

    expect(store.get("t1", "m1")).toBeUndefined();
    expect(store.get("t2", "m1")?.threadId).toBe("t2");
  });
});

describe("isTerminalState", () => {
  it("only lets the floor pass states that can never change again", () => {
    expect(isTerminalState("published")).toBe(true);
    expect(isTerminalState("abandoned")).toBe(true);
    expect(isTerminalState("received")).toBe(false);
    expect(isTerminalState("reply_ready")).toBe(false);
  });
});

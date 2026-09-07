// Tests for the composition root, all in dry-run mode.
//
// Dry run is exactly the path that opens no Borg, so these exercise the real
// config -> state -> client -> adapter wiring and the poll loop without a model,
// a tenant directory or a network call.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FetchImpl } from "./botarena-client.js";
import { loadArenaConfig } from "./config.js";
import { startArenaService } from "./service.js";
import { ArenaStateStore } from "./state.js";

const BOT_ID = "bot-akuki";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "akuki-arena-service-"));
  statePath = join(dir, "state.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return loadArenaConfig({
    AKUKI_ARENA_API_BASE: "https://arena.example",
    AKUKI_ARENA_BOT_TOKEN: "token",
    AKUKI_ARENA_SESSION_COOKIE: "cookie",
    AKUKI_ARENA_BOT_ID: BOT_ID,
    AKUKI_ARENA_STATE_DB: statePath,
    AKUKI_ARENA_POLL_INTERVAL_MS: "10",
    AKUKI_ARENA_CATCH_UP_BACKLOG: "1",
    ...overrides,
  });
}

/** Records every request and answers one seated thread with one message. */
function stubArena(): { urls: string[]; fetchImpl: FetchImpl } {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/api/threads")) {
      return new Response(
        JSON.stringify({
          threads: [
            { id: "t1", name: "general", participant_bot_ids: [BOT_ID], is_archived: false },
          ],
        }),
      );
    }
    if (url.endsWith("/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "m1",
              thread_id: "t1",
              sender_type: "user",
              sender_id: "u-zosia",
              text: "hej",
              created_at: "2026-09-04T10:00:00.000Z",
              status: "final",
            },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({}));
  }) as unknown as FetchImpl;
  return { urls, fetchImpl };
}

describe("startArenaService in dry run", () => {
  it("polls, reports, and neither posts nor records anything", async () => {
    const { urls, fetchImpl } = stubArena();
    const logged: string[] = [];

    const service = await startArenaService({
      config: config(),
      dryRun: true,
      fetchImpl,
      log: (_level, message) => logged.push(message),
    });
    try {
      await service.pollOnce();
    } finally {
      await service.stop();
    }

    expect(logged.some((line) => line.includes("[dry-run] would run a turn"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/api/threads"))).toBe(true);
    // Nothing was POSTed: the stub records every URL, and only reads were made.
    expect(urls.filter((url) => url.includes("/messages"))).toHaveLength(1);

    const store = new ArenaStateStore(statePath);
    try {
      expect(store.get("t1", "m1")).toBeUndefined();
      expect(store.getFloor("t1")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reports its effective settings at startup, so a log line shows what is live", async () => {
    const { fetchImpl } = stubArena();
    const logged: string[] = [];

    const service = await startArenaService({
      config: config({ AKUKI_ARENA_THREAD_ALLOWLIST: "t1" }),
      dryRun: true,
      fetchImpl,
      log: (_level, message) => logged.push(message),
    });
    await service.stop();

    const started = logged.find((line) => line.startsWith("started:"));
    expect(started).toContain("dryRun=true");
    expect(started).toContain("allowlist=t1");
    expect(started).toContain("pollIntervalMs=10");
  });

  it("schedules the next poll only after the previous one settles", async () => {
    const { fetchImpl } = stubArena();
    const scheduled: number[] = [];
    // Collected in an array rather than a nullable local: a local assigned only
    // inside the callback stays narrowed to null, so calling it fails typecheck.
    const timers: Array<() => void> = [];

    const service = await startArenaService({
      config: config(),
      dryRun: true,
      fetchImpl,
      log: () => {},
      setTimeoutFn: (callback, delayMs) => {
        scheduled.push(delayMs);
        timers.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });

    // One timer armed at startup, and no second one until the first poll runs.
    expect(scheduled).toEqual([10]);

    expect(timers).toHaveLength(1);
    timers[0]?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(scheduled).toEqual([10, 10]);
    await service.stop();
  });

  it("keeps the loop alive when a poll fails", async () => {
    const failing = (async () => {
      throw new Error("arena unreachable");
    }) as unknown as FetchImpl;
    const logged: string[] = [];
    const timers: Array<() => void> = [];

    const service = await startArenaService({
      config: config(),
      dryRun: true,
      fetchImpl: failing,
      log: (_level, message) => logged.push(message),
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });

    timers[0]?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(logged.some((line) => line.includes("poll failed"))).toBe(true);
    // A new timer was armed despite the failure.
    expect(timers).toHaveLength(2);
    await service.stop();
  });

  it("stops cleanly and closes its state file", async () => {
    const { fetchImpl } = stubArena();
    const logged: string[] = [];

    const service = await startArenaService({
      config: config(),
      dryRun: true,
      fetchImpl,
      log: (_level, message) => logged.push(message),
    });

    await expect(service.stop()).resolves.toBeUndefined();
    expect(logged.at(-1)).toBe("stopped");
  });
});

describe("startArenaService outside dry run", () => {
  it("refuses to start without an explicit tenant directory", async () => {
    const { fetchImpl } = stubArena();

    await expect(
      startArenaService({ config: config(), env: {}, fetchImpl, log: () => {} }),
    ).rejects.toThrow(/AKUKI_DATA_DIR/u);
  });
});

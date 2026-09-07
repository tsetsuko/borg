import { describe, expect, it } from "vitest";

import { ArenaConfigError, loadArenaConfig } from "./config.js";

const minimal: NodeJS.ProcessEnv = {
  AKUKI_ARENA_API_BASE: "https://arena.example",
  AKUKI_ARENA_BOT_TOKEN: "token",
  AKUKI_ARENA_SESSION_COOKIE: "cookie",
  AKUKI_ARENA_BOT_ID: "bot-akuki",
};

describe("loadArenaConfig", () => {
  it("fills the optional settings with conservative defaults", () => {
    const config = loadArenaConfig(minimal);

    expect(config.pollIntervalMs).toBe(4_000);
    expect(config.threadAllowlist.size).toBe(0);
    // The default must be false: replaying history would answer conversations
    // that happened before Akuki existed.
    expect(config.catchUpBacklog).toBe(false);
    expect(config.stateDbPath).toBe("./.akuki-arena/state.db");
  });

  it.each([
    "AKUKI_ARENA_API_BASE",
    "AKUKI_ARENA_BOT_TOKEN",
    "AKUKI_ARENA_SESSION_COOKIE",
    "AKUKI_ARENA_BOT_ID",
  ])("refuses to start without %s instead of defaulting", (name) => {
    const env = { ...minimal, [name]: "" };
    expect(() => loadArenaConfig(env)).toThrow(ArenaConfigError);
    expect(() => loadArenaConfig(env)).toThrow(new RegExp(name, "u"));
  });

  it("parses an allowlist and drops blank entries", () => {
    const config = loadArenaConfig({
      ...minimal,
      AKUKI_ARENA_THREAD_ALLOWLIST: " t1 , ,t2,",
    });

    expect([...config.threadAllowlist]).toEqual(["t1", "t2"]);
  });

  it("rejects a poll interval that is not a positive integer", () => {
    for (const value of ["0", "-5", "soon"]) {
      expect(() =>
        loadArenaConfig({ ...minimal, AKUKI_ARENA_POLL_INTERVAL_MS: value }),
      ).toThrow(ArenaConfigError);
    }
  });

  it("accepts the usual spellings of a boolean", () => {
    for (const value of ["1", "true", "YES"]) {
      expect(
        loadArenaConfig({ ...minimal, AKUKI_ARENA_CATCH_UP_BACKLOG: value }).catchUpBacklog,
      ).toBe(true);
    }
    for (const value of ["0", "false", "no", ""]) {
      expect(
        loadArenaConfig({ ...minimal, AKUKI_ARENA_CATCH_UP_BACKLOG: value }).catchUpBacklog,
      ).toBe(false);
    }
  });

  it("trims surrounding whitespace so a copied secret still works", () => {
    const config = loadArenaConfig({ ...minimal, AKUKI_ARENA_BOT_TOKEN: "  token  " });
    expect(config.botToken).toBe("token");
  });
});

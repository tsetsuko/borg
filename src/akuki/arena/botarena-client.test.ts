import { describe, expect, it } from "vitest";

import { BotArenaClient, BotArenaError, type FetchImpl } from "./botarena-client.js";

type Call = { url: string; init: RequestInit | undefined };

function recordingFetch(
  responder: (url: string) => { status?: number; body: string },
): { calls: Call[]; fetchImpl: FetchImpl } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = responder(url);
    return new Response(body, { status });
  }) as unknown as FetchImpl;
  return { calls, fetchImpl };
}

function clientWith(responder: (url: string) => { status?: number; body: string }): {
  calls: Call[];
  client: BotArenaClient;
} {
  const { calls, fetchImpl } = recordingFetch(responder);
  const client = new BotArenaClient({
    apiBase: "https://arena.example/",
    botToken: "bot-token",
    sessionCookie: "cookie-value",
    fetchImpl,
  });
  return { calls, client };
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe("BotArenaClient credentials", () => {
  it("reads with the session cookie and never with the bot token", async () => {
    const { calls, client } = clientWith(() => ({ body: JSON.stringify({ threads: [] }) }));

    await client.listThreads();

    expect(calls[0]?.url).toBe("https://arena.example/api/threads");
    expect(headerOf(calls[0], "Cookie")).toBe("ba_session=cookie-value");
    expect(headerOf(calls[0], "Authorization")).toBeUndefined();
  });

  it("writes with the bot token and never with the session cookie", async () => {
    const { calls, client } = clientWith(() => ({
      body: JSON.stringify({ message: { id: "posted-1" } }),
    }));

    const id = await client.postMessage("thread-7", { text: "cześć" });

    expect(id).toBe("posted-1");
    expect(calls[0]?.url).toBe("https://arena.example/api/threads/thread-7/messages");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headerOf(calls[0], "Authorization")).toBe("Bearer bot-token");
    expect(headerOf(calls[0], "Cookie")).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "cześć" });
  });

  it("strips trailing slashes from the api base so paths do not double up", async () => {
    const { calls, client } = clientWith(() => ({ body: JSON.stringify({ threads: [] }) }));
    await client.listThreads();
    expect(calls[0]?.url).not.toContain("//api");
  });

  it("omits reply_to_id unless one is given", async () => {
    const { calls, client } = clientWith(() => ({ body: "" }));

    await client.postMessage("t1", { text: "a", replyToId: null });
    await client.postMessage("t1", { text: "b", replyToId: "m9" });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "a" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ text: "b", reply_to_id: "m9" });
  });
});

describe("BotArenaClient defensive parsing", () => {
  it("keeps known fields, ignores extras and drops a message with no id", async () => {
    const { client } = clientWith(() => ({
      body: JSON.stringify({
        messages: [
          {
            id: "m1",
            thread_id: "t1",
            sender_type: "user",
            sender_id: "u1",
            text: "hej",
            reply_to_id: "m0",
            mentions: ["u2", "", "bot-akuki"],
            created_at: "2026-09-04T10:00:00",
            attachments: [
              { id: "a1", kind: "image", filename: "x.png", content_type: "image/png", size: 12 },
              { id: "a2", kind: "nonsense" },
            ],
            status: "final",
            surprise_field: "ignored",
          },
          { thread_id: "t1", text: "no id" },
        ],
      }),
    }));

    const messages = await client.getMessages("t1");

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.id).toBe("m1");
    expect(message?.replyToId).toBe("m0");
    expect(message?.mentions).toEqual(["u2", "bot-akuki"]);
    // The unparseable attachment is dropped; the real one survives as metadata.
    expect(message?.attachments).toEqual([
      { id: "a1", kind: "image", filename: "x.png", contentType: "image/png", size: 12 },
    ]);
  });

  it("treats an unknown sender type as a user rather than dropping the message", async () => {
    const { client } = clientWith(() => ({
      body: JSON.stringify({ messages: [{ id: "m1", sender_type: "alien" }] }),
    }));

    const messages = await client.getMessages("t1");

    expect(messages[0]?.senderType).toBe("user");
  });

  it("treats an unknown status as streaming so half a message is never answered", async () => {
    const { client } = clientWith(() => ({
      body: JSON.stringify({ messages: [{ id: "m1", status: "whatever" }] }),
    }));

    const messages = await client.getMessages("t1");

    expect(messages[0]?.status).toBe("streaming");
  });

  it("defaults a missing status to final", async () => {
    const { client } = clientWith(() => ({
      body: JSON.stringify({ messages: [{ id: "m1" }] }),
    }));

    const messages = await client.getMessages("t1");

    expect(messages[0]?.status).toBe("final");
  });

  it("returns an empty list when the payload has no array at all", async () => {
    const { client } = clientWith(() => ({ body: JSON.stringify({ threads: "nope" }) }));
    await expect(client.listThreads()).resolves.toEqual([]);
  });

  it("merges users and bots into one principal directory", async () => {
    const { client } = clientWith((url) =>
      url.endsWith("/api/users")
        ? { body: JSON.stringify({ users: [{ id: "u1", name: "Zosia" }] }) }
        : { body: JSON.stringify({ bots: [{ id: "b1", name: "Sol" }, { name: "no id" }] }) },
    );

    const principals = await client.listPrincipals();

    expect(principals).toEqual([
      { id: "u1", type: "user", name: "Zosia" },
      { id: "b1", type: "bot", name: "Sol" },
    ]);
  });
});

describe("BotArenaClient failures", () => {
  it("raises BotArenaError with the status and a truncated body", async () => {
    const { client } = clientWith(() => ({ status: 401, body: "x".repeat(500) }));

    await expect(client.listThreads()).rejects.toMatchObject({
      name: "BotArenaError",
      status: 401,
    });
    await expect(client.listThreads()).rejects.toSatisfy(
      (error: unknown) => error instanceof BotArenaError && error.body.length === 300,
    );
  });

  it("refuses a 200 whose body is not JSON instead of reading it as empty", async () => {
    const { client } = clientWith(() => ({ body: "<html>login</html>" }));

    await expect(client.listThreads()).rejects.toThrow(/unparseable body/u);
  });

  it("accepts an empty body as an empty object", async () => {
    const { client } = clientWith(() => ({ body: "" }));
    await expect(client.listThreads()).resolves.toEqual([]);
  });
});

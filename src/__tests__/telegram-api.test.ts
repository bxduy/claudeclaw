import { afterEach, describe, expect, test } from "bun:test";
import { TelegramApiError, callApi, sendMessage } from "../commands/telegram";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Reply = { status: number; body: string };
const tooMany = (retryAfter: number): Reply => ({
  status: 429,
  body: JSON.stringify({
    ok: false,
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  }),
});
const ok: Reply = { status: 200, body: '{"ok":true,"result":{}}' };
const badRequest: Reply = {
  status: 400,
  body: '{"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities"}',
};

function mockFetch(replies: Reply[]): Array<{ url: string; body: any }> {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    const r = replies[calls.length - 1];
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return calls;
}

describe("callApi", () => {
  test("throws TelegramApiError with retryAfter", async () => {
    mockFetch([tooMany(1)]);
    const err = await callApi("t", "getMe").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.code).toBe(429);
    expect(err.retryAfter).toBe(1);
    expect(err.method).toBe("getMe");
  });

  test("handles non-JSON error body", async () => {
    mockFetch([{ status: 400, body: "bad" }]);
    const err = await callApi("t", "getMe").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.code).toBe(400);
    expect(err.retryAfter).toBeUndefined();
  });
});

describe("sendMessage", () => {
  test("retries 429 with HTML", async () => {
    const calls = mockFetch([tooMany(1), ok]);
    await sendMessage("t", 1, "hello");
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.url.endsWith("/sendMessage"))).toBe(true);
    expect(calls.every((c) => c.body.parse_mode === "HTML")).toBe(true);
  });

  test("gives up on long retry_after", async () => {
    const calls = mockFetch([tooMany(120)]);
    const err = await sendMessage("t", 1, "hello").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(calls.length).toBe(1);
  });

  test("keeps plain fallback on 400", async () => {
    const calls = mockFetch([badRequest, ok]);
    await sendMessage("t", 1, "hello");
    expect(calls.length).toBe(2);
    expect(calls[1].body.parse_mode).toBeUndefined();
  });

  test("plain fallback also honours 429", async () => {
    const calls = mockFetch([badRequest, tooMany(1), ok]);
    await sendMessage("t", 1, "hello");
    expect(calls.length).toBe(3);
    expect(calls[1].body.parse_mode).toBeUndefined();
    expect(calls[2].body.parse_mode).toBeUndefined();
  });
});

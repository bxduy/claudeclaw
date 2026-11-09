import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverTelegramText } from "../commands/telegram";

const realFetch = globalThis.fetch;
const FILE = "/tmp/zd-test.md";
const ROOT = mkdtempSync(join(tmpdir(), "zd-outbox-"));
const INSIDE = join(ROOT, "digest.md");
const SIBLING = `${ROOT}-escape.md`;

beforeAll(() => {
  writeFileSync(FILE, "hello");
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(INSIDE, "digest");
  writeFileSync(SIBLING, "secret");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; body: any };

function mockFetch(statusFor: (url: string) => number = () => 200): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url: String(url), body });
    const status = statusFor(String(url));
    const payload =
      status === 200
        ? '{"ok":true,"result":{}}'
        : '{"ok":false,"error_code":400,"description":"Bad Request"}';
    return new Response(payload, { status });
  }) as typeof fetch;
  return calls;
}

describe("deliverTelegramText", () => {
  test("deliverTelegramText splits long text and sends files", async () => {
    const calls = mockFetch();
    await deliverTelegramText("t", 1, "a".repeat(9000) + `\n[send-file:${FILE}]`, 7);
    const msgs = calls.filter((c) => c.url.endsWith("/sendMessage"));
    const docs = calls.filter((c) => c.url.endsWith("/sendDocument"));
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    for (const m of msgs) {
      expect(m.body.text.length).toBeLessThanOrEqual(4096);
      expect(m.body.text).not.toContain("[send-file:");
      expect(m.body.message_thread_id).toBe(7);
    }
    expect(docs.length).toBe(1);
  });

  test("deliverTelegramText with only a directive sends no text message", async () => {
    const calls = mockFetch();
    await deliverTelegramText("t", 1, `[send-file:${FILE}]`);
    expect(calls.filter((c) => c.url.endsWith("/sendMessage")).length).toBe(0);
    expect(calls.filter((c) => c.url.endsWith("/sendDocument")).length).toBe(1);
  });

  test("deliverTelegramText with only a react tag sends nothing", async () => {
    const calls = mockFetch();
    await deliverTelegramText("t", 1, "[react:👍]");
    expect(calls.length).toBe(0);
  });

  test("deliverTelegramText refuses a file outside fileRoot", async () => {
    const calls = mockFetch();
    await expect(deliverTelegramText("t", 1, `hi\n[send-file:${FILE}]`, 7, ROOT)).rejects.toThrow(
      "outside outbox"
    );
    expect(calls.filter((c) => c.url.endsWith("/sendDocument")).length).toBe(0);
    expect(calls.filter((c) => c.url.endsWith("/sendMessage")).length).toBe(1);
  });

  test("deliverTelegramText refuses a ../ escape to a sibling sharing the root prefix", async () => {
    const calls = mockFetch();
    await expect(
      deliverTelegramText("t", 1, `[send-file:${ROOT}/../${SIBLING.split("/").pop()}]`, undefined, ROOT)
    ).rejects.toThrow("outside outbox");
    expect(calls.filter((c) => c.url.endsWith("/sendDocument")).length).toBe(0);
  });

  test("deliverTelegramText uploads a file inside fileRoot", async () => {
    const calls = mockFetch();
    await deliverTelegramText("t", 1, `[send-file:${INSIDE}]`, 7, ROOT);
    expect(calls.filter((c) => c.url.endsWith("/sendDocument")).length).toBe(1);
  });

  test("deliverTelegramText throws on a missing file", async () => {
    const calls = mockFetch();
    await expect(deliverTelegramText("t", 1, `[send-file:${ROOT}/nope.md]`, 7, ROOT)).rejects.toThrow(
      "missing"
    );
    await expect(deliverTelegramText("t", 1, `[send-file:/tmp/zd-nope-${Date.now()}.md]`)).rejects.toThrow(
      "missing"
    );
    expect(calls.filter((c) => c.url.endsWith("/sendDocument")).length).toBe(0);
  });

  test("deliverTelegramText rethrows after trying the file", async () => {
    const calls = mockFetch((u) => (u.endsWith("/sendMessage") ? 400 : 200));
    await expect(deliverTelegramText("t", 1, `hi\n[send-file:${FILE}]`)).rejects.toThrow();
    expect(calls.filter((c) => c.url.endsWith("/sendDocument")).length).toBe(1);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createStatusCards, type CardApi } from "../tasks/card";
import type { Task } from "../tasks/store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    prompt: "do the thing",
    status: "running",
    chatId: 42,
    threadId: 7,
    userId: null,
    sessionId: null,
    dir: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    failureReason: null,
    ...over,
  };
}

interface Fake {
  api: CardApi;
  sends: { chatId: number; text: string; threadId?: number }[];
  edits: { chatId: number; messageId: number; text: string }[];
}

function fakeApi(opts: { failSend?: boolean; failEdit?: boolean } = {}): Fake {
  const f: Fake = { sends: [], edits: [], api: null as unknown as CardApi };
  f.api = {
    async send(chatId, text, threadId) {
      if (opts.failSend) throw new Error("send boom");
      f.sends.push({ chatId, text, threadId });
      return 99;
    },
    async edit(chatId, messageId, text) {
      f.edits.push({ chatId, messageId, text });
      if (opts.failEdit) throw new Error("edit boom");
    },
  };
  return f;
}

// Tests silence the expected console.error from swallowed failures.
const origError = console.error;
afterEach(() => {
  console.error = origError;
});

describe("status cards", () => {
  test("SC-9 send, progress edit, final edit", async () => {
    const f = fakeApi();
    let t = 0;
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 50, now: () => (t += 10) });
    const task = mkTask();
    cards.started(task);
    await sleep(5);
    expect(f.sends).toEqual([{ chatId: 42, text: "⏳ Task t1 running · 0s\ndo the thing", threadId: 7 }]);
    cards.progress(task, "● Read a");
    await sleep(80);
    expect(f.edits.some((e) => e.text.includes("● Read a"))).toBe(true);
    expect(f.edits[0].messageId).toBe(99);
    cards.progress(task, "● Bash ls");
    cards.finished({ ...task, status: "completed" });
    await sleep(5);
    expect(f.edits[f.edits.length - 1].text.startsWith("✅ Task t1 completed ·")).toBe(true);
  });

  test("no edit after finished", async () => {
    const f = fakeApi();
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 50 });
    const task = mkTask();
    cards.started(task);
    await sleep(5);
    cards.progress(task, "● Read a");
    cards.finished({ ...task, status: "completed" });
    await sleep(5);
    const n = f.edits.length;
    await sleep(150);
    expect(f.edits.length).toBe(n);
  });

  test("no edit when unchanged", async () => {
    const f = fakeApi();
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 30, now: () => 0 });
    const task = mkTask();
    cards.started(task);
    await sleep(5);
    cards.progress(task, "● Read a");
    await sleep(130);
    expect(f.edits.length).toBeLessThanOrEqual(1);
    cards.finished({ ...task, status: "completed" });
  });

  test("send failure means no edits", async () => {
    console.error = () => {};
    const f = fakeApi({ failSend: true });
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 20 });
    const task = mkTask();
    cards.started(task);
    await sleep(5);
    cards.progress(task, "● Read a");
    await sleep(60);
    expect(() => cards.finished({ ...task, status: "completed" })).not.toThrow();
    await sleep(30);
    expect(f.edits.length).toBe(0);
  });

  test("edit failure is swallowed", async () => {
    console.error = () => {};
    const f = fakeApi({ failEdit: true });
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 20 });
    const task = mkTask();
    cards.started(task);
    await sleep(5);
    cards.progress(task, "● a");
    await sleep(50);
    cards.progress(task, "● b");
    await sleep(50);
    expect(f.edits.length).toBeGreaterThanOrEqual(2);
    cards.finished({ ...task, status: "failed" });
  });

  test("interval re-read each tick", async () => {
    let interval = 1000;
    const f = fakeApi();
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => interval });
    const task = mkTask();
    cards.started(task);
    await sleep(5);
    interval = 50;
    let i = 0;
    const feeder = setInterval(() => cards.progress(task, `● step ${i++}`), 40);
    // first timer was armed at 1000ms; it is only re-read once it fires.
    await sleep(1100);
    const before = f.edits.length;
    await sleep(300);
    clearInterval(feeder);
    expect(f.edits.length - before).toBeGreaterThanOrEqual(2);
    cards.finished({ ...task, status: "completed" });
  });

  test("failed and cancelled icons", async () => {
    const f = fakeApi();
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 1000 });
    const a = mkTask({ id: "a" });
    const b = mkTask({ id: "b" });
    cards.started(a);
    cards.started(b);
    await sleep(5);
    cards.finished({ ...a, status: "failed" });
    cards.finished({ ...b, status: "cancelled" });
    await sleep(5);
    expect(f.edits.some((e) => e.text.startsWith("❌ Task a failed ·"))).toBe(true);
    expect(f.edits.some((e) => e.text.startsWith("🚫 Task b cancelled ·"))).toBe(true);
  });

  test("multi-line long prompt is flattened and cut to 80 chars", async () => {
    const f = fakeApi();
    const cards = createStatusCards({ api: f.api, getIntervalMs: () => 1000 });
    const prompt = "ab\ncd " + "x".repeat(200);
    const task = mkTask({ prompt });
    cards.started(task);
    await sleep(5);
    const second = f.sends[0].text.split("\n")[1];
    expect(second).toBe(("ab cd " + "x".repeat(200)).slice(0, 80));
    expect(second.length).toBe(80);
    cards.finished({ ...task, status: "completed" });
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTaskStore } from "../tasks/store";
import { getTaskRuntime, initTaskRuntime, stopTaskRuntime } from "../tasks";

let dir: string;
let dbPath: string;
let tasksDir: string;
let sent: Array<[number, string, number | undefined]>;

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function init() {
  return initTaskRuntime({
    dbPath,
    tasksDir,
    getMaxWorkers: () => 5,
    send: async (chatId, text, threadId) => {
      sent.push([chatId, text, threadId]);
    },
    schedulerTickMs: 20,
    notifierTickMs: 20,
  });
}

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "tasks.db");
  tasksDir = join(dir, "tasks");
  sent = [];
});

afterEach(() => {
  stopTaskRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("task runtime", () => {
  test("default executor fails no_executor and notifies thread", async () => {
    init();
    const task = getTaskRuntime()!.store.create({ prompt: "hello", chatId: 1, threadId: 7 });
    getTaskRuntime()!.scheduler.wake();
    await waitFor(() => sent.some((s) => s[1].startsWith("❌")));
    expect(sent).toContainEqual([1, `❌ Task ${task.id} failed (no_executor).`, 7]);
  });

  test("interrupted on start", async () => {
    const pre = openTaskStore(dbPath);
    const task = pre.create({ prompt: "x", chatId: 2 });
    pre.db.query("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
    pre.close();
    init();
    await waitFor(() => sent.length > 0);
    expect(sent[0][1]).toBe(`❌ Task ${task.id} failed (interrupted).`);
    const t = getTaskRuntime()!.store.get(task.id)!;
    expect(t.status).toBe("failed");
    expect(t.failureReason).toBe("interrupted");
  });

  test("stop clears runtime", () => {
    init();
    expect(getTaskRuntime()).not.toBeNull();
    stopTaskRuntime();
    expect(getTaskRuntime()).toBeNull();
    expect(() => stopTaskRuntime()).not.toThrow();
  });
});

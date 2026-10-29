import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTaskStore, type TaskStore } from "../tasks/store";

let dir: string;
let dbPath: string;
let clock: number;
const opened: TaskStore[] = [];

function open(opts: { randomId?: () => string } = {}): TaskStore {
  const store = openTaskStore(dbPath, { now: () => clock, ...opts });
  opened.push(store);
  return store;
}

function pragma(store: TaskStore, name: string): unknown {
  return Object.values(store.db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
}

function ids(...list: string[]): () => string {
  let i = 0;
  return () => list[Math.min(i++, list.length - 1)];
}

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-task-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "tasks.db");
  clock = 1000;
});

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("openTaskStore", () => {
  test("open sets WAL, busy_timeout and user_version 1", () => {
    const store = open();
    expect(pragma(store, "journal_mode")).toBe("wal");
    expect(pragma(store, "busy_timeout")).toBe(5000);
    expect(pragma(store, "user_version")).toBe(1);
  });

  test("reopen keeps data", () => {
    const first = open();
    const task = first.create({ prompt: "do X", chatId: 42 });
    first.close();
    const second = open();
    expect(second.get(task.id)).toEqual(task);
    expect(pragma(second, "user_version")).toBe(1);
  });
});

describe("create", () => {
  test("create returns queued task with t-xxxx id", () => {
    const store = open();
    const task = store.create({ prompt: "do X", chatId: 42 });
    expect(task.id).toMatch(/^t-[0-9a-z]{4}$/);
    expect(task.status).toBe("queued");
    expect(task.prompt).toBe("do X");
    expect(task.chatId).toBe(42);
    expect(task.threadId).toBeNull();
    expect(task.userId).toBeNull();
    expect(task.createdAt).toBe(1000);
    expect(task.startedAt).toBeNull();
  });

  test("create stores threadId and userId when given", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1, threadId: 7, userId: 9 });
    expect(store.get(task.id)?.threadId).toBe(7);
    expect(store.get(task.id)?.userId).toBe(9);
  });

  test("create retries on id collision", () => {
    const store = open({ randomId: ids("t-aaaa", "t-aaaa", "t-bbbb") });
    expect(store.create({ prompt: "1", chatId: 1 }).id).toBe("t-aaaa");
    expect(store.create({ prompt: "2", chatId: 1 }).id).toBe("t-bbbb");
  });

  test("create throws after 5 collisions", () => {
    let calls = 0;
    const store = open({
      randomId: () => {
        calls++;
        return "t-aaaa";
      },
    });
    store.create({ prompt: "1", chatId: 1 });
    expect(() => store.create({ prompt: "2", chatId: 1 })).toThrow();
    expect(calls).toBe(1 + 5);
  });
});

describe("claim", () => {
  test("claim picks oldest queued", () => {
    const store = open();
    const tasks = [1, 2, 3].map((t) => {
      clock = t;
      return store.create({ prompt: `p${t}`, chatId: 1 });
    });
    clock = 50;
    const claimed = store.claim(5);
    expect(claimed?.id).toBe(tasks[0].id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBe(50);
    expect(store.get(tasks[1].id)?.status).toBe("queued");
  });

  test("claim returns null when nothing queued", () => {
    const store = open();
    expect(store.claim(5)).toBeNull();
  });

  test("claim respects max", () => {
    const store = open();
    for (let i = 0; i < 3; i++) store.create({ prompt: `p${i}`, chatId: 1 });
    expect(store.claim(2)).not.toBeNull();
    expect(store.claim(2)).not.toBeNull();
    expect(store.claim(2)).toBeNull();
    expect(store.countRunning()).toBe(2);
  });

  test("claim respects lowered max", () => {
    const store = open();
    for (let i = 0; i < 4; i++) store.create({ prompt: `p${i}`, chatId: 1 });
    for (let i = 0; i < 3; i++) expect(store.claim(3)).not.toBeNull();
    expect(store.claim(2)).toBeNull();
    const running = store.list(10).filter((t) => t.status === "running");
    expect(running.length).toBe(3);
    expect(store.list(10).filter((t) => t.status === "queued").length).toBe(1);
  });

  test("two stores never exceed max", () => {
    const a = open();
    const b = open();
    for (let i = 0; i < 10; i++) a.create({ prompt: `p${i}`, chatId: 1 });
    let aDone = false;
    let bDone = false;
    while (!aDone || !bDone) {
      if (!aDone) aDone = a.claim(3) === null;
      if (!bDone) bDone = b.claim(3) === null;
    }
    expect(a.countRunning()).toBe(3);
    expect(b.countRunning()).toBe(3);
  });
});

describe("session index", () => {
  test("partial unique index on running session", () => {
    const store = open();
    const t1 = store.create({ prompt: "1", chatId: 1 });
    const t2 = store.create({ prompt: "2", chatId: 1 });
    const t3 = store.create({ prompt: "3", chatId: 1 });
    const setRunning = store.db.query("UPDATE tasks SET status = 'running', session_id = 's1' WHERE id = ?");
    setRunning.run(t1.id);
    let err: unknown;
    try {
      setRunning.run(t2.id);
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(() => store.db.query("UPDATE tasks SET session_id = 's1' WHERE id = ?").run(t3.id)).not.toThrow();
  });
});

describe("transition", () => {
  test("first writer wins", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 42, threadId: 5 });
    store.claim(5);
    clock = 2000;
    const done = store.transition(task.id, ["running"], "completed");
    expect(done?.status).toBe("completed");
    expect(done?.finishedAt).toBe(2000);
    expect(store.transition(task.id, ["running"], "cancelled")).toBeNull();
    expect(store.get(task.id)?.status).toBe("completed");
    const outbox = store.pendingOutbox(Infinity);
    expect(outbox.length).toBe(1);
    expect(outbox[0].text).toBe(`✅ Task ${task.id} completed.`);
    expect(outbox[0]).toMatchObject({
      taskId: task.id,
      chatId: 42,
      threadId: 5,
      state: "pending",
      attempts: 0,
      nextAttemptAt: 2000,
      lastError: null,
      createdAt: 2000,
      sentAt: null,
    });
  });

  test("illegal transition throws", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1 });
    expect(() => store.transition(task.id, ["completed"], "running")).toThrow();
    expect(() => store.transition(task.id, ["queued"], "completed")).toThrow();
    expect(store.get(task.id)?.status).toBe("queued");
  });

  test("queued→running sets startedAt", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1 });
    clock = 1500;
    const running = store.transition(task.id, ["queued"], "running");
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBe(1500);
    expect(running?.finishedAt).toBeNull();
  });

  test("queued→cancelled writes no outbox", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1 });
    const cancelled = store.transition(task.id, ["queued", "running"], "cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.finishedAt).toBe(1000);
    expect(store.pendingOutbox(Infinity)).toEqual([]);
  });

  test("running→cancelled writes 🚫 outbox", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1 });
    store.claim(5);
    store.transition(task.id, ["queued", "running"], "cancelled");
    expect(store.pendingOutbox(Infinity).map((r) => r.text)).toEqual([`🚫 Task ${task.id} cancelled.`]);
  });

  test("running→failed writes ❌ outbox with reason", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1 });
    store.claim(5);
    clock = 3000;
    const failed = store.transition(task.id, ["running"], "failed", { exitCode: 2, failureReason: "exit" });
    expect(failed).toMatchObject({ status: "failed", exitCode: 2, failureReason: "exit", finishedAt: 3000 });
    expect(store.pendingOutbox(Infinity).map((r) => r.text)).toEqual([`❌ Task ${task.id} failed (exit).`]);
  });

  test("transition of unknown id returns null", () => {
    const store = open();
    expect(store.transition("t-zzzz", ["running"], "completed")).toBeNull();
  });
});

describe("failInterrupted", () => {
  test("fails running tasks with interrupted and writes outbox", () => {
    const store = open();
    const t1 = store.create({ prompt: "1", chatId: 1 });
    const t2 = store.create({ prompt: "2", chatId: 1 });
    const t3 = store.create({ prompt: "3", chatId: 1 });
    store.claim(5);
    store.claim(5);
    expect(store.failInterrupted()).toBe(2);
    for (const t of [t1, t2]) {
      expect(store.get(t.id)).toMatchObject({ status: "failed", failureReason: "interrupted" });
    }
    expect(store.get(t3.id)?.status).toBe("queued");
    expect(store.pendingOutbox(Infinity).map((r) => r.text)).toEqual([
      `❌ Task ${t1.id} failed (interrupted).`,
      `❌ Task ${t2.id} failed (interrupted).`,
    ]);
  });
});

describe("list and setDir", () => {
  test("list newest first with limit", () => {
    const store = open();
    const tasks = [1, 2, 3].map((t) => {
      clock = t;
      return store.create({ prompt: `p${t}`, chatId: 1 });
    });
    expect(store.list(2).map((t) => t.id)).toEqual([tasks[2].id, tasks[1].id]);
  });

  test("setDir stores dir", () => {
    const store = open();
    const task = store.create({ prompt: "p", chatId: 1 });
    store.setDir(task.id, "/tmp/x");
    expect(store.get(task.id)?.dir).toBe("/tmp/x");
  });
});

describe("outbox", () => {
  function twoRows(store: TaskStore): number[] {
    for (let i = 0; i < 2; i++) {
      const task = store.create({ prompt: `p${i}`, chatId: 1 });
      store.claim(5);
      store.transition(task.id, ["running"], "completed");
    }
    return store.pendingOutbox(Infinity).map((r) => r.id);
  }

  test("pendingOutbox returns due pending rows by id", () => {
    const store = open();
    const [a, b] = twoRows(store);
    expect(a).toBeLessThan(b);
    store.markFailed(a, { attempts: 1, nextAttemptAt: 5000, lastError: "boom", dead: false });
    expect(store.pendingOutbox(4999).map((r) => r.id)).toEqual([b]);
    expect(store.pendingOutbox(5000).map((r) => r.id)).toEqual([a, b]);
  });

  test("markSent sets state and sentAt", () => {
    const store = open();
    const [a, b] = twoRows(store);
    store.markSent(a, 7000);
    const rows = store.db.query("SELECT state, sent_at FROM outbox WHERE id = ?").get(a);
    expect(rows).toEqual({ state: "sent", sent_at: 7000 });
    expect(store.pendingOutbox(Infinity).map((r) => r.id)).toEqual([b]);
  });

  test("markFailed updates attempts, next attempt and error", () => {
    const store = open();
    const [a] = twoRows(store);
    store.markFailed(a, { attempts: 3, nextAttemptAt: 9000, lastError: "net", dead: false });
    expect(store.pendingOutbox(9000).find((r) => r.id === a)).toMatchObject({
      state: "pending",
      attempts: 3,
      nextAttemptAt: 9000,
      lastError: "net",
      sentAt: null,
    });
  });

  test("markFailed with dead removes row from pending", () => {
    const store = open();
    const [a, b] = twoRows(store);
    store.markFailed(a, { attempts: 10, nextAttemptAt: 0, lastError: "gone", dead: true });
    expect(store.pendingOutbox(Infinity).map((r) => r.id)).toEqual([b]);
    const row = store.db.query("SELECT state, attempts, last_error FROM outbox WHERE id = ?").get(a);
    expect(row).toEqual({ state: "dead", attempts: 10, last_error: "gone" });
  });
});

function runningTask(store: TaskStore, chatId = 1) {
  const t = store.create({ prompt: "p", chatId });
  store.claim(10);
  return t;
}

function outboxTexts(store: TaskStore): string[] {
  return (store.db.query("SELECT text FROM outbox ORDER BY id").all() as { text: string }[]).map((r) => r.text);
}

describe("sessions, summaries, chat filter, pruning", () => {
  test("setSessionId stores session", () => {
    const store = open();
    const t = runningTask(store);
    store.setSessionId(t.id, "s-1");
    expect(store.get(t.id)?.sessionId).toBe("s-1");
  });

  test("summary appended for completed and failed", () => {
    const store = open({ randomId: ids("t-aaaa", "t-bbbb", "t-cccc") });
    const a = runningTask(store);
    store.transition(a.id, ["running"], "completed", { summary: "ok" });
    const b = runningTask(store);
    store.transition(b.id, ["running"], "failed", { failureReason: "idle", summary: "log" });
    const c = runningTask(store);
    store.transition(c.id, ["running"], "completed", { summary: "" });
    expect(outboxTexts(store)).toEqual([
      "✅ Task t-aaaa completed.\n\nok",
      "❌ Task t-bbbb failed (idle).\n\nlog",
      "✅ Task t-cccc completed.",
    ]);
  });

  test("summary ignored for cancelled", () => {
    const store = open({ randomId: ids("t-dddd") });
    const t = runningTask(store);
    store.transition(t.id, ["running"], "cancelled", { summary: "x" });
    expect(outboxTexts(store)).toEqual(["🚫 Task t-dddd cancelled."]);
  });

  test("list filters by chat", () => {
    const store = open({ randomId: ids("t-1111", "t-2222") });
    store.create({ prompt: "a", chatId: 1 });
    store.create({ prompt: "b", chatId: 2 });
    expect(store.list(10, 1).map((t) => t.id)).toEqual(["t-1111"]);
    expect(store.list(10).map((t) => t.id).sort()).toEqual(["t-1111", "t-2222"]);
  });

  test("pruneOutbox removes old sent and dead rows only", () => {
    const day = 86_400_000;
    clock = 100 * day;
    const store = open({ randomId: ids("t-p1", "t-p2", "t-p3", "t-p4") });
    const rows: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = runningTask(store);
      store.transition(t.id, ["running"], "completed");
      rows.push((store.db.query("SELECT id FROM outbox WHERE task_id = ?").get(t.id) as { id: number }).id);
    }
    const [oldSent, newSent, oldPending, oldDead] = rows;
    store.markSent(oldSent, clock);
    store.markSent(newSent, clock);
    store.markFailed(oldDead, { attempts: 10, nextAttemptAt: 0, lastError: "x", dead: true });
    const setAge = (id: number, days: number) =>
      store.db.query("UPDATE outbox SET created_at = ? WHERE id = ?").run(clock - days * day, id);
    setAge(oldSent, 8);
    setAge(newSent, 1);
    setAge(oldPending, 8);
    setAge(oldDead, 8);
    expect(store.pruneOutbox(7 * day)).toBe(2);
    const left = (store.db.query("SELECT id FROM outbox ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(left).toEqual([newSent, oldPending]);
  });
});

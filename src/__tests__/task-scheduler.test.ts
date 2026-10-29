import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTaskStore, type Task, type TaskStore } from "../tasks/store";
import { createScheduler, noExecutor, type Scheduler, type TaskExecutor, type TaskObserver } from "../tasks/scheduler";

let dir: string;
let dbPath: string;
let tasksDir: string;
let store: TaskStore;
let scheduler: Scheduler | null;

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function make(executor: TaskExecutor, extra: { max?: number; onOutbox?: () => void; tickMs?: number; isPaused?: () => boolean; observer?: TaskObserver } = {}): Scheduler {
  scheduler = createScheduler({
    store,
    executor,
    getMaxWorkers: () => extra.max ?? 5,
    tasksDir,
    onOutbox: extra.onOutbox,
    tickMs: extra.tickMs ?? 60_000,
    isPaused: extra.isPaused,
    observer: extra.observer,
  });
  return scheduler;
}

function add(prompt = "p"): Task {
  return store.create({ prompt, chatId: 1 });
}

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-task-scheduler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "tasks.db");
  tasksDir = join(dir, "tasks");
  store = openTaskStore(dbPath);
  scheduler = null;
});

afterEach(() => {
  scheduler?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("scheduler", () => {
  test("never exceeds max", async () => {
    const seen: number[] = [];
    const s = make(
      async () => {
        seen.push(store.countRunning());
        await new Promise((r) => setTimeout(r, 50));
        return { exitCode: 0 };
      },
      { max: 5 }
    );
    const created = Array.from({ length: 12 }, () => add());
    s.start();
    await waitFor(() => created.every((t) => store.get(t.id)?.status === "completed"));
    expect(seen.length).toBe(12);
    expect(Math.max(...seen)).toBeLessThanOrEqual(5);
  });

  test("exit code nonzero -> failed exit", async () => {
    const s = make(async () => ({ exitCode: 2 }));
    const t = add();
    s.start();
    await waitFor(() => store.get(t.id)?.status === "failed");
    const got = store.get(t.id)!;
    expect(got.failureReason).toBe("exit");
    expect(got.exitCode).toBe(2);
  });

  test("throw -> spawn_error", async () => {
    const s = make(async () => {
      throw new Error("boom");
    });
    const t = add();
    s.start();
    await waitFor(() => store.get(t.id)?.status === "failed");
    expect(store.get(t.id)!.failureReason).toBe("spawn_error");
  });

  test("noExecutor -> no_executor", async () => {
    const s = make(noExecutor);
    const t = add();
    s.start();
    await waitFor(() => store.get(t.id)?.status === "failed");
    expect(store.get(t.id)!.failureReason).toBe("no_executor");
  });

  test("creates task dir and stores it", async () => {
    let ctxDir = "";
    const s = make(async (_t, ctx) => {
      ctxDir = ctx.dir;
      return { exitCode: 0 };
    });
    const t = add();
    s.start();
    await waitFor(() => store.get(t.id)?.status === "completed");
    const expected = join(tasksDir, t.id);
    expect(existsSync(expected)).toBe(true);
    expect(store.get(t.id)!.dir).toBe(expected);
    expect(ctxDir).toBe(expected);
  });

  test("onOutbox called after finish", async () => {
    let calls = 0;
    const s = make(async () => ({ exitCode: 0 }), { onOutbox: () => void calls++ });
    const a = add();
    const b = add();
    s.start();
    await waitFor(() => store.get(a.id)?.status === "completed" && store.get(b.id)?.status === "completed");
    await waitFor(() => calls >= 2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("wake during pass reruns", async () => {
    let second: Task | null = null;
    let s!: Scheduler;
    s = make(async (task) => {
      if (!second) {
        second = store.create({ prompt: "second", chatId: 1 });
        s.wake();
      }
      return { exitCode: 0 };
    });
    const first = add("first");
    s.start();
    await waitFor(() => second !== null && store.get(second.id)?.status === "completed");
    expect(store.get(first.id)!.status).toBe("completed");
  });

  test("results after stop are discarded", async () => {
    const errors: unknown[] = [];
    const onErr = (e: unknown) => void errors.push(e);
    const realConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    process.on("unhandledRejection", onErr);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started = false;
      let outboxCalls = 0;
      const s = make(
        async () => {
          started = true;
          await gate;
          return { exitCode: 0 };
        },
        { onOutbox: () => void outboxCalls++ }
      );
      const t = add();
      s.start();
      await waitFor(() => started);
      s.stop();
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(store.get(t.id)!.status).toBe("running");
      expect(outboxCalls).toBe(0);
      expect(logged).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      console.error = realConsoleError;
      process.off("unhandledRejection", onErr);
    }
  });

  test("stop prevents further claims", async () => {
    const s = make(async () => ({ exitCode: 0 }));
    s.start();
    s.stop();
    const t = add();
    s.wake();
    await new Promise((r) => setTimeout(r, 100));
    expect(store.get(t.id)!.status).toBe("queued");
  });

  test("paused scheduler claims nothing", async () => {
    let paused = true;
    let calls = 0;
    const s = make(async () => (calls++, { exitCode: 0 }), { isPaused: () => paused });
    const t = add();
    s.start();
    s.wake();
    await new Promise((r) => setTimeout(r, 100));
    expect(store.get(t.id)!.status).toBe("queued");
    expect(calls).toBe(0);
    paused = false;
    s.wake();
    await waitFor(() => store.get(t.id)?.status === "completed");
  });

  const outbox = () => store.pendingOutbox(Date.now() + 1e9).map((r) => r.text);

  test("outcome mapping", async () => {
    const outcomes = [
      { exitCode: 0, summary: "ok" },
      { exitCode: 1, failureReason: "idle" },
      { exitCode: 3 },
      { exitCode: 0, failureReason: "timeout" },
    ];
    let i = 0;
    const s = make(async () => outcomes[i++]);
    const ids: string[] = [];
    for (let k = 0; k < 4; k++) ids.push(add().id);
    s.start();
    await waitFor(() => ids.every((id) => ["completed", "failed"].includes(store.get(id)!.status)));
    const [a, b, c, d] = ids.map((id) => store.get(id)!);
    expect(a.status).toBe("completed");
    expect(outbox()).toContain(`✅ Task ${a.id} completed.\n\nok`);
    expect([b.status, b.failureReason]).toEqual(["failed", "idle"]);
    expect([c.status, c.failureReason, c.exitCode]).toEqual(["failed", "exit", 3]);
    expect([d.status, d.failureReason]).toEqual(["failed", "timeout"]);
  });

  test("cancel aborts running executor", async () => {
    let started = false;
    const finished: Task[] = [];
    const s = make(
      async (_t, ctx) => {
        started = true;
        await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r()));
        return { exitCode: 143, failureReason: "cancelled" };
      },
      { observer: { started() {}, progress() {}, finished: (t) => void finished.push(t) } }
    );
    const t = add();
    s.start();
    await waitFor(() => started);
    store.transition(t.id, ["running"], "cancelled");
    expect(s.cancel(t.id)).toBe(true);
    await waitFor(() => finished.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get(t.id)!.status).toBe("cancelled");
    expect(outbox().filter((x) => x.includes("🚫")).length).toBe(1);
    expect(outbox().length).toBe(1);
    expect(finished.length).toBe(1);
    expect(finished[0].status).toBe("cancelled");
    expect(s.cancel("t-none")).toBe(false);
  });

  test("cancel races completion", async () => {
    const finished: Task[] = [];
    const s = make(async () => ({ exitCode: 0 }), {
      observer: { started() {}, progress() {}, finished: (t) => void finished.push(t) },
    });
    const t = add();
    s.start();
    await waitFor(() => finished.length > 0);
    store.transition(t.id, ["running"], "cancelled");
    s.cancel(t.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(["completed", "cancelled"]).toContain(store.get(t.id)!.status);
    expect(outbox().length).toBe(1);
    expect(finished.length).toBe(1);
  });

  test("setSessionId via ctx", async () => {
    const s = make(async (_t, ctx) => (ctx.setSessionId("u-1"), { exitCode: 0 }));
    const t = add();
    s.start();
    await waitFor(() => store.get(t.id)?.status === "completed");
    expect(store.get(t.id)!.sessionId).toBe("u-1");
  });

  test("observer order and error isolation", async () => {
    const events: string[] = [];
    const s = make(
      async (_t, ctx) => {
        events.push("exec");
        ctx.onProgress("line-1");
        return { exitCode: 0 };
      },
      {
        observer: {
          started() {
            events.push("started");
            throw new Error("observer boom");
          },
          progress: (_t, line) => void events.push(`progress:${line}`),
          finished: (t) => {
            events.push(`finished:${t.status}`);
            throw new Error("observer boom 2");
          },
        },
      }
    );
    const realConsoleError = console.error;
    console.error = () => {};
    try {
      const t = add();
      s.start();
      await waitFor(() => events.includes("finished:completed"));
      expect(events).toEqual(["started", "exec", "progress:line-1", "finished:completed"]);
      expect(store.get(t.id)!.status).toBe("completed");
    } finally {
      console.error = realConsoleError;
    }
  });

  test("stop aborts with shutdown reason", async () => {
    let reason: unknown = null;
    let started = false;
    let finishedCalls = 0;
    const s = make(
      async (_t, ctx) => {
        started = true;
        ctx.signal.addEventListener("abort", () => (reason = ctx.signal.reason));
        await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r()));
        return { exitCode: 137, failureReason: "cancelled" };
      },
      { observer: { started() {}, progress() {}, finished: () => void finishedCalls++ } }
    );
    const t = add();
    s.start();
    await waitFor(() => started);
    s.stop();
    expect(reason).toBe("shutdown");
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get(t.id)!.status).toBe("running");
    expect(finishedCalls).toBe(0);
  });
});

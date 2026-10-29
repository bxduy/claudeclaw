import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTaskStore, type Task, type TaskStore } from "../tasks/store";
import { createScheduler, noExecutor, type Scheduler, type TaskExecutor } from "../tasks/scheduler";

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

function make(executor: TaskExecutor, extra: { max?: number; onOutbox?: () => void; tickMs?: number } = {}): Scheduler {
  scheduler = createScheduler({
    store,
    executor,
    getMaxWorkers: () => extra.max ?? 5,
    tasksDir,
    onOutbox: extra.onOutbox,
    tickMs: extra.tickMs ?? 60_000,
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
});

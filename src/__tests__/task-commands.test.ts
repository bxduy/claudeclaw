import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTaskStore, type TaskStore } from "../tasks/store";
import type { TaskRuntime } from "../tasks/runtime";
import {
  formatAge,
  parseTaskCommandArg,
  taskCommandReply,
  TASK_DISABLED_TEXT,
} from "../tasks/commands";

let dir: string;
let store: TaskStore;
let wakes: number;
let cancels: string[];
let cancelResult: "cancelled" | "not_running";
let runtime: TaskRuntime;
let clock: number;
const ctx = { chatId: 42, threadId: 7, userId: 99 };

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-task-commands-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  clock = 1_000_000;
  store = openTaskStore(join(dir, "tasks.db"), { now: () => clock });
  wakes = 0;
  cancels = [];
  cancelResult = "cancelled";
  runtime = {
    store,
    scheduler: { start() {}, stop() {}, wake: () => void wakes++, cancel: () => false },
    notifier: { start() {}, stop() {}, wake() {} } as unknown as TaskRuntime["notifier"],
    getMaxWorkers: () => 5,
    cancel: (id) => {
      cancels.push(id);
      return cancelResult;
    },
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const reply = (command: string | null, text: string, rt: TaskRuntime | null = runtime, now = clock) =>
  taskCommandReply(command, text, ctx, rt, now);

describe("parseTaskCommandArg", () => {
  test("parseTaskCommandArg strips bot suffix", () => {
    expect(parseTaskCommandArg("/task@MyBot  làm X\ndòng 2")).toBe("làm X\ndòng 2");
    expect(parseTaskCommandArg("/task")).toBe("");
  });
});

describe("formatAge", () => {
  test("rounds down per unit", () => {
    expect(formatAge(5_000)).toBe("5s");
    expect(formatAge(125_000)).toBe("2m");
    expect(formatAge(7_200_000)).toBe("2h");
    expect(formatAge(172_800_000)).toBe("2d");
  });
});

describe("/task", () => {
  test("creates a queued task and wakes the scheduler", () => {
    const out = reply("/task", "/task hello");
    const [task] = store.list(10);
    expect(out).toBe(`Queued task ${task.id} (running 0/5).`);
    expect(task.prompt).toBe("hello");
    expect([task.chatId, task.threadId, task.userId]).toEqual([42, 7, 99]);
    expect(wakes).toBe(1);
  });

  test("empty prompt gives usage", () => {
    expect(reply("/task", "/task   ")).toBe("Usage: /task <prompt>");
    expect(store.list(10)).toHaveLength(0);
    expect(wakes).toBe(0);
  });
});

describe("/tasks", () => {
  test("empty", () => {
    expect(reply("/tasks", "/tasks")).toBe("No tasks yet.");
  });

  test("lists newest first, truncated, newlines flattened, max 10", () => {
    for (let i = 0; i < 12; i++) {
      clock += 1000;
      store.create({ prompt: i === 11 ? `${"a".repeat(30)}\n${"b".repeat(30)}` : `p${i}`, chatId: 42 });
    }
    const lines = reply("/tasks", "/tasks", runtime, clock + 3000)!.split("\n");
    expect(lines).toHaveLength(10);
    const newest = store.list(1)[0];
    expect(lines[0]).toBe(`${newest.id} · queued · 3s · ${"a".repeat(30)} ${"b".repeat(9)}`);
    expect(lines[1]).toMatch(/ · queued · 4s · p10$/);
  });
});

describe("/status", () => {
  test("shows task fields, omits empty ones, case-insensitive id", () => {
    const task = store.create({ prompt: "do it", chatId: 42 });
    const out = reply("/status", `/status ${task.id.toUpperCase()}`)!;
    const lines = out.split("\n");
    expect(lines[0]).toBe(`Task ${task.id}`);
    expect(lines).toContain("Status: queued");
    expect(lines).toContain("Prompt: do it");
    expect(out).not.toContain("Started");
  });

  test("not found", () => {
    expect(reply("/status", "/status t-zzzz")).toBe("Task t-zzzz not found.");
  });

  test("no argument falls through", () => {
    expect(reply("/status", "/status")).toBeNull();
  });
});

describe("/cancel", () => {
  test("queued is cancelled", () => {
    const task = store.create({ prompt: "x", chatId: 42 });
    expect(reply("/cancel", `/cancel ${task.id}`)).toBe(`Cancelled task ${task.id}.`);
    expect(store.get(task.id)!.status).toBe("cancelled");
  });

  test("running is cancelled", () => {
    const task = store.create({ prompt: "x", chatId: 42 });
    store.claim(5);
    expect(reply("/cancel", `/cancel ${task.id}`)).toBe(`Cancelling task ${task.id}.`);
    expect(cancels).toEqual([task.id]);
  });

  test("running but not_running reports status", () => {
    const task = store.create({ prompt: "x", chatId: 42 });
    store.claim(5);
    cancelResult = "not_running";
    expect(reply("/cancel", `/cancel ${task.id}`)).toBe(`Task ${task.id} is already running.`);
    expect(cancels).toEqual([task.id]);
  });

  test("finished reports status", () => {
    const task = store.create({ prompt: "x", chatId: 42 });
    store.claim(5);
    store.transition(task.id, ["running"], "completed", { exitCode: 0 });
    expect(reply("/cancel", `/cancel ${task.id}`)).toBe(`Task ${task.id} is already completed.`);
  });

  test("not found and usage", () => {
    expect(reply("/cancel", "/cancel t-none")).toBe("Task t-none not found.");
    expect(reply("/cancel", "/cancel")).toBe("Usage: /cancel <id>");
  });
});

describe("chat scoping (SC-10)", () => {
  test("other chat's task is invisible", () => {
    const mine = store.create({ prompt: "mine", chatId: 1 });
    const theirs = store.create({ prompt: "theirs", chatId: 2 });
    const c1 = { chatId: 1 };
    const list = taskCommandReply("/tasks", "/tasks", c1, runtime, clock)!;
    expect(list).toContain(mine.id);
    expect(list).not.toContain(theirs.id);
    expect(taskCommandReply("/status", `/status ${theirs.id}`, c1, runtime)).toBe(`Task ${theirs.id} not found.`);
    expect(taskCommandReply("/cancel", `/cancel ${theirs.id}`, c1, runtime)).toBe(`Task ${theirs.id} not found.`);
    expect(store.get(theirs.id)!.status).toBe("queued");
    expect(cancels).toEqual([]);
  });
});

describe("runtime disabled", () => {
  test("task commands answer disabled", () => {
    expect(TASK_DISABLED_TEXT).toBe("Task mode is disabled.");
    expect(reply("/task", "/task x", null)).toBe("Task mode is disabled.");
    expect(reply("/tasks", "/tasks", null)).toBe("Task mode is disabled.");
    expect(reply("/cancel", "/cancel x", null)).toBe("Task mode is disabled.");
    expect(reply("/status", "/status x", null)).toBe("Task mode is disabled.");
  });

  test("bare /status falls through", () => {
    expect(reply("/status", "/status", null)).toBeNull();
  });
});

test("other commands return null", () => {
  expect(reply("/fork", "/fork x")).toBeNull();
  expect(reply(null, "hello")).toBeNull();
});

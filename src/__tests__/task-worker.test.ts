import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClaudeExecutor, progressLine, SUMMARY_LIMIT } from "../tasks/worker";
import { parseTasksSettings } from "../config";
import type { Task } from "../tasks/store";
import type { TaskRunOptions, TaskRunResult } from "../runner";

const tool = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});

describe("progressLine", () => {
  test("tool_use with file_path", () => {
    expect(progressLine(tool("Read", { file_path: "src/a.ts" }))).toBe("● Read src/a.ts");
  });
  test("long command is cut to 80", () => {
    expect(progressLine(tool("Bash", { command: "x".repeat(200) }))).toBe(`● Bash ${"x".repeat(80)}`);
  });
  test("tool without known field", () => {
    expect(progressLine(tool("Foo", { other: 1 }))).toBe("● Foo");
  });
  test("text block", () => {
    expect(progressLine({ type: "assistant", message: { content: [{ type: "text", text: "Xin\nchào" }] } })).toBe("✍ Xin chào");
  });
  test("system event is null", () => {
    expect(progressLine({ type: "system" })).toBeNull();
  });
  test("tool_use wins over text", () => {
    const ev = { type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "b" } }] } };
    expect(progressLine(ev)).toBe("● Read b");
  });
});

let dir: string;
const task = { id: "abc123", prompt: "do it" } as Task;

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(res: Partial<TaskRunResult>, events: Record<string, unknown>[] = []) {
  const seen: TaskRunOptions[] = [];
  const exec = createClaudeExecutor({
    cwd: "/work",
    getTasksConfig: () => parseTasksSettings({}),
    run: async (o) => {
      seen.push(o);
      events.forEach((e) => o.onEvent?.(e));
      return { exitCode: 0, result: "", stderr: "", ...res };
    },
  });
  const sessions: string[] = [];
  const progress: string[] = [];
  const ac = new AbortController();
  const ctx = { dir, signal: ac.signal, setSessionId: (s: string) => sessions.push(s), onProgress: (l: string) => progress.push(l) };
  return { exec, ctx, seen, sessions, progress, ac };
}

describe("createClaudeExecutor", () => {
  test("passes run options and session id", async () => {
    const { exec, ctx, seen, sessions, ac } = setup({ result: "done" });
    await exec(task, ctx);
    expect(seen[0].sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessions).toEqual([seen[0].sessionId]);
    expect(seen[0].timeoutMs).toBe(120 * 60000);
    expect(seen[0].idleTimeoutMs).toBe(20 * 60000);
    expect(seen[0].eventLogPath).toBe(join(dir, "events.ndjson"));
    expect(seen[0].cwd).toBe("/work");
    expect(seen[0].signal).toBe(ac.signal);
    expect(seen[0].prompt).toBe("do it");
  });
  test("forwards progress", async () => {
    const { exec, ctx, progress } = setup({}, [tool("Read", { file_path: "src/a.ts" }), { type: "system" }]);
    await exec(task, ctx);
    expect(progress).toEqual(["● Read src/a.ts"]);
  });
  test("success writes result.md and summary", async () => {
    const { exec, ctx } = setup({ result: "done" });
    const out = await exec(task, ctx);
    expect(readFileSync(join(dir, "result.md"), "utf8")).toContain("done");
    expect(out).toEqual({ exitCode: 0, summary: "done" });
    expect("failureReason" in out).toBe(false);
  });
  test("empty result falls back to stderr", async () => {
    const { exec, ctx } = setup({ result: "", stderr: "boom", exitCode: 1 });
    await exec(task, ctx);
    expect(readFileSync(join(dir, "result.md"), "utf8")).toContain("boom");
  });
  test("long result truncated", async () => {
    const { exec, ctx } = setup({ result: "a".repeat(5000) });
    const out = await exec(task, ctx);
    expect(SUMMARY_LIMIT).toBe(3000);
    expect(out.summary).toBe("a".repeat(3000) + "\n\n(truncated, full result: tasks/abc123/result.md)");
  });
  for (const reason of ["idle", "timeout", "rate_limit", "cancelled"] as const) {
    test(`reason ${reason} maps to failureReason`, async () => {
      const { exec, ctx } = setup({ exitCode: 143, reason });
      const out = await exec(task, ctx);
      expect(out.failureReason).toBe(reason);
      expect(out.exitCode).toBe(143);
    });
  }
  describe("result.md write failure", () => {
    const missing = () => join(dir, "nope", "deeper");
    test("keeps outcome and notes the missing file", async () => {
      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { exec, ctx } = setup({ result: "partial", exitCode: 143, reason: "timeout" });
        const out = await exec(task, { ...ctx, dir: missing() });
        expect(out).toEqual({ exitCode: 143, failureReason: "timeout", summary: "partial\n\n(result.md could not be written)" });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
    test("truncated result uses the unwritten-file suffix", async () => {
      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { exec, ctx } = setup({ result: "a".repeat(5000) });
        const out = await exec(task, { ...ctx, dir: missing() });
        expect(out.summary).toBe("a".repeat(3000) + "\n\n(truncated; result.md could not be written)");
      } finally {
        spy.mockRestore();
      }
    });
  });
});

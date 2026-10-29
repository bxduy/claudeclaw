import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendEventLine,
  isRateLimited,
  runTaskClaude,
  TASK_DISALLOWED_TOOLS,
  TASK_SYSTEM_PROMPT,
  type TaskRunOptions,
} from "../runner";

let dir: string;
let pidsFile: string;

const SETTINGS = {
  security: { level: "unrestricted" as const, allowedTools: [], disallowedTools: [] },
  model: "",
  api: "",
};

function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

const groupAlive = (pgid: number) => alive(-pgid);

function readPids(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

/** Writes a fake `claude` script; it records its own pid (= pgid, spawned detached) first. */
function fakeClaude(body: string): string {
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\necho $$ >> "${pidsFile}"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function opts(executable: string, extra: Partial<TaskRunOptions> = {}): TaskRunOptions {
  return {
    prompt: "do the thing",
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: dir,
    timeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    eventLogPath: join(dir, "events.ndjson"),
    executable,
    settings: SETTINGS,
    ...extra,
  };
}

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-task-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  pidsFile = join(dir, "pids");
});

afterEach(() => {
  for (const pid of [...readPids(pidsFile), ...readPids(join(dir, "child.pid")), ...readPids(join(dir, "setsid.pids"))]) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("TASK_SYSTEM_PROMPT", () => {
  test("matches FR-2.3", () => {
    expect(TASK_SYSTEM_PROMPT).toBe(
      "You are running as a ClaudeClaw background task. No human is watching this session, so do not wait for input. Your final message is sent to the user on Telegram: end with a short summary and any links (for example a PR URL)."
    );
    expect(TASK_DISALLOWED_TOOLS).toEqual(["Bash(gh pr merge:*)"]);
  });
});

describe("appendEventLine", () => {
  test("event log capped", () => {
    const path = join(dir, "capped.ndjson");
    const written = { bytes: 0 };
    appendEventLine(path, "aaaaaaaaaa", written, 20);
    appendEventLine(path, "bbbbbbbbbb", written, 20);
    appendEventLine(path, "cccccccccc", written, 20);
    expect(readFileSync(path, "utf8")).toBe("aaaaaaaaaa\nbbbbbbbbbb\n");
    expect(written.bytes).toBe(22);
  });
});

describe("runTaskClaude", () => {
  test("streams events and result", async () => {
    const exe = fakeClaude([
      `echo '{"type":"system","subtype":"init","session_id":"x"}'`,
      "sleep 0.3",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}'`,
      "sleep 0.3",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"b"}]}}'`,
      "sleep 0.3",
      `echo '{"type":"result","result":"done"}'`,
      "exit 0",
    ].join("\n"));
    const events: Record<string, unknown>[] = [];
    const res = await runTaskClaude(opts(exe, { onEvent: (e) => events.push(e) }));
    expect(res.exitCode).toBe(0);
    expect(res.result).toBe("done");
    expect(res.reason).toBeUndefined();
    const lines = readFileSync(join(dir, "events.ndjson"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "system", subtype: "init", session_id: "x" });
    expect(events).toHaveLength(4);
    expect(events[3]).toEqual({ type: "result", result: "done" });
  });

  test("passes session id and task flags", async () => {
    const argsFile = join(dir, "args");
    const exe = fakeClaude(`printf '%s\\0' "$@" > "${argsFile}"`);
    const res = await runTaskClaude(opts(exe));
    expect(res.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
    expect(args.slice(0, 7)).toEqual([
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
    ]);
    const sp = args.indexOf("--append-system-prompt");
    expect(sp).toBeGreaterThan(6);
    expect(args[sp + 1]).toBe(TASK_SYSTEM_PROMPT);
    const disallowed = args.flatMap((a, i) => (a === "--disallowedTools" ? [args[i + 1]!] : []));
    expect(disallowed).toHaveLength(1);
    expect(disallowed[0]).toContain("Bash(gh pr merge:*)");
    expect(args).not.toContain("--model");
  });

  test("idle kills the whole group", async () => {
    const childPidFile = join(dir, "child.pid");
    const exe = fakeClaude([
      `echo '{"type":"system","subtype":"init"}'`,
      "sleep 300 &",
      `echo $! > "${childPidFile}"`,
      "sleep 300",
    ].join("\n"));
    const start = Date.now();
    const res = await runTaskClaude(opts(exe, { idleTimeoutMs: 1000, timeoutMs: 60_000 }));
    expect(Date.now() - start).toBeLessThan(7000);
    expect(res.reason).toBe("idle");
    const [pid] = readPids(pidsFile);
    const [child] = readPids(childPidFile);
    expect(groupAlive(pid!)).toBe(false);
    expect(alive(child!)).toBe(false);
  }, 15_000);

  test("total timeout", async () => {
    const exe = fakeClaude(`while true; do echo '{"type":"tick"}'; sleep 0.2; done`);
    const start = Date.now();
    const res = await runTaskClaude(opts(exe, { timeoutMs: 1500, idleTimeoutMs: 10_000 }));
    expect(res.reason).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(7000);
    expect(groupAlive(readPids(pidsFile)[0]!)).toBe(false);
  }, 15_000);

  test("abort cancels", async () => {
    const childPidFile = join(dir, "child.pid");
    const exe = fakeClaude([
      `echo '{"type":"system","subtype":"init"}'`,
      "sleep 300 &",
      `echo $! > "${childPidFile}"`,
      "sleep 300",
    ].join("\n"));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await runTaskClaude(opts(exe, { signal: ac.signal }));
    expect(res.reason).toBe("cancelled");
    const [pid] = readPids(pidsFile);
    expect(groupAlive(pid!)).toBe(false);
    const [child] = readPids(childPidFile);
    expect(alive(child!)).toBe(false);
  }, 15_000);

  test("pre-aborted signal", async () => {
    const exe = fakeClaude("sleep 300 &\nsleep 300");
    const res = await runTaskClaude(opts(exe, { signal: AbortSignal.abort() }));
    expect(res.reason).toBe("cancelled");
    // Give a surviving script time to show up, then check nothing from it is alive.
    await Bun.sleep(300);
    for (const pid of readPids(pidsFile)) expect(groupAlive(pid)).toBe(false);
    const procs = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
    const survivors = procs.filter((p) => {
      try {
        return readFileSync(`/proc/${p}/cmdline`, "utf8").includes(dir);
      } catch {
        return false;
      }
    });
    expect(survivors).toEqual([]);
  }, 15_000);

  test("shutdown abort kills immediately", async () => {
    const exe = fakeClaude([
      "trap '' TERM",
      `echo '{"type":"system","subtype":"init"}'`,
      "sleep 300",
    ].join("\n"));
    const ac = new AbortController();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = Date.now();
      ac.abort("shutdown");
    }, 300);
    const res = await runTaskClaude(opts(exe, { signal: ac.signal }));
    const returnedAt = Date.now();
    expect(res.reason).toBe("cancelled");
    const [pid] = readPids(pidsFile);
    expect(groupAlive(pid!)).toBe(false);
    // SIGKILL went out synchronously, so no 5 s SIGTERM grace was waited for.
    expect(returnedAt - abortedAt).toBeLessThan(1000);
  }, 15_000);

  // The setsid child sits outside the group, so the group kill cannot close the stdout it inherited.
  function exitWithStdoutHolder(holdSeconds: number): string {
    return fakeClaude([
      `echo '{"type":"result","result":"done"}'`,
      `setsid sleep ${holdSeconds} &`,
      `echo $! >> "${join(dir, "setsid.pids")}"`,
      "sleep 0.3",
      "exit 0",
    ].join("\n"));
  }

  test("clean exit is not relabelled", async () => {
    const exe = exitWithStdoutHolder(3);
    const start = Date.now();
    const res = await runTaskClaude(opts(exe, { idleTimeoutMs: 1000 }));
    expect(Date.now() - start).toBeLessThan(3000);
    expect(res.reason).toBeUndefined();
    expect(res.result).toBe("done");
    expect(res.exitCode).toBe(0);
  }, 15_000);

  test("unbounded drain is cut", async () => {
    const exe = exitWithStdoutHolder(30);
    const start = Date.now();
    const res = await runTaskClaude(opts(exe));
    expect(Date.now() - start).toBeLessThan(5000);
    expect(res.exitCode).toBe(0);
  }, 15_000);

  // Keep last: rate-limit state is a module-level global that cannot be reset.
  test("rate limit", async () => {
    const exe = fakeClaude([
      "cat <<'EOF'",
      `{"type":"result","result":"You've hit your limit · resets 3pm (UTC)"}`,
      "EOF",
    ].join("\n"));
    const res = await runTaskClaude(opts(exe));
    expect(res.reason).toBe("rate_limit");
    expect(isRateLimited()).toBe(true);
  });
});

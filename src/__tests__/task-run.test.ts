import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendEventLine,
  isRateLimited,
  killTaskProcesses,
  runTaskClaude,
  TASK_DISALLOWED_TOOLS,
  TASK_SYSTEM_PROMPT,
  type TaskRunOptions,
} from "../runner";

let dir: string;
let pidsFile: string;
const spawnedPids: number[] = [];

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
  for (const pid of [...readPids(pidsFile), ...readPids(join(dir, "child.pid")), ...readPids(join(dir, "setsid.pids")), ...spawnedPids.splice(0)]) {
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

  /** Fake claude that records its argv (NUL separated) and its stdin. */
  function recordingClaude(): { exe: string; argsFile: string; stdinFile: string } {
    const argsFile = join(dir, "args");
    const stdinFile = join(dir, "stdin");
    const exe = fakeClaude(`printf '%s\\0' "$@" > "${argsFile}"\ncat > "${stdinFile}"`);
    return { exe, argsFile, stdinFile };
  }
  const readArgs = (file: string) => readFileSync(file, "utf8").split("\0").slice(0, -1);

  test("passes session id and task flags", async () => {
    const { exe, argsFile, stdinFile } = recordingClaude();
    const res = await runTaskClaude(opts(exe));
    expect(res.exitCode).toBe(0);
    const args = readArgs(argsFile);
    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
    ]);
    expect(args).not.toContain("do the thing");
    expect(readFileSync(stdinFile, "utf8")).toBe("do the thing");
    const sp = args.indexOf("--append-system-prompt");
    expect(sp).toBeGreaterThan(5);
    expect(args[sp + 1]).toBe(TASK_SYSTEM_PROMPT);
    const disallowed = args.flatMap((a, i) => (a === "--disallowedTools" ? [args[i + 1]!] : []));
    expect(disallowed).toHaveLength(1);
    expect(disallowed[0]).toContain("Bash(gh pr merge:*)");
    expect(args).not.toContain("--model");
  });

  for (const prompt of ["--version", "- a\n- b", `--settings={"x":1}`]) {
    test(`option-like prompt ${JSON.stringify(prompt)} goes to stdin, not argv`, async () => {
      const { exe, argsFile, stdinFile } = recordingClaude();
      const res = await runTaskClaude(opts(exe, { prompt }));
      expect(res.exitCode).toBe(0);
      expect(readFileSync(stdinFile, "utf8")).toBe(prompt);
      const args = readArgs(argsFile);
      expect(args).not.toContain(prompt);
      expect(args.some((a) => a.startsWith("--settings") || a === "--version" || a === "-")).toBe(false);
    });
  }

  test("tags the child with the task session env", async () => {
    const envFile = join(dir, "env");
    const exe = fakeClaude(`printf '%s' "$CLAUDECLAW_TASK_SESSION" > "${envFile}"`);
    await runTaskClaude(opts(exe));
    expect(readFileSync(envFile, "utf8")).toBe("11111111-2222-3333-4444-555555555555");
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

  // Claude Code runs Bash-tool commands in their own session, out of reach of the group kill.
  const SETSID_PIDS = () => join(dir, "setsid.pids");
  const setsidSleeper = () => [
    "setsid sleep 300 > /dev/null 2>&1 < /dev/null &",
    `echo $! >> "${SETSID_PIDS()}"`,
  ];
  async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await Bun.sleep(10);
    }
    return pred();
  }
  /** Gone or a zombie waiting for its reaper: either way it no longer runs. */
  function running(pid: number): boolean {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !/^\d+ \(.*\) Z/.test(stat);
    } catch {
      return false;
    }
  }

  const linuxOnly = process.platform === "linux" ? test : test.skip;

  linuxOnly("sweeps tool processes in their own session after a clean exit", async () => {
    // The pause lets the background child finish setsid() before the shell exits and the group is killed.
    const exe = fakeClaude([...setsidSleeper(), `echo '{"type":"result","result":"done"}'`, "sleep 0.3", "exit 0"].join("\n"));
    const res = await runTaskClaude(opts(exe));
    expect(res.exitCode).toBe(0);
    const [sleeper] = readPids(SETSID_PIDS());
    expect(sleeper).toBeGreaterThan(0);
    expect(await waitFor(() => !running(sleeper!), 200)).toBe(true);
  }, 15_000);

  linuxOnly("sweeps tool processes after an idle kill", async () => {
    const exe = fakeClaude([...setsidSleeper(), `echo '{"type":"system","subtype":"init"}'`, "sleep 300"].join("\n"));
    const res = await runTaskClaude(opts(exe, { idleTimeoutMs: 1000 }));
    expect(res.reason).toBe("idle");
    const [sleeper] = readPids(SETSID_PIDS());
    expect(await waitFor(() => !running(sleeper!), 200)).toBe(true);
  }, 15_000);

  linuxOnly("sweeps tool processes on shutdown abort", async () => {
    const exe = fakeClaude([...setsidSleeper(), `echo '{"type":"system","subtype":"init"}'`, "sleep 300"].join("\n"));
    const ac = new AbortController();
    let sleeperDeadAfterAbort: boolean | undefined;
    setTimeout(() => {
      ac.abort("shutdown");
      // The daemon exits right after aborting: the sweep must already have run.
      const [sleeper] = readPids(SETSID_PIDS());
      sleeperDeadAfterAbort = sleeper !== undefined && waitForSync(() => !running(sleeper), 200);
    }, 500);
    const res = await runTaskClaude(opts(exe, { signal: ac.signal }));
    expect(res.reason).toBe("cancelled");
    expect(sleeperDeadAfterAbort).toBe(true);
  }, 15_000);

  function waitForSync(pred: () => boolean, ms: number): boolean {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      Bun.sleepSync(10);
    }
    return pred();
  }

  linuxOnly("killTaskProcesses kills every process carrying the session tag", async () => {
    const tag = `test-${Math.random().toString(36).slice(2)}`;
    const tagged = Bun.spawn(["sleep", "300"], { env: { ...process.env, CLAUDECLAW_TASK_SESSION: tag } });
    const other = Bun.spawn(["sleep", "300"], { env: { ...process.env, CLAUDECLAW_TASK_SESSION: `${tag}-other` } });
    spawnedPids.push(tagged.pid, other.pid);
    await Bun.sleep(100);
    expect(killTaskProcesses(tag)).toBe(1);
    await tagged.exited;
    expect(tagged.signalCode).toBe("SIGKILL");
    expect(alive(other.pid)).toBe(true);
    expect(killTaskProcesses(tag)).toBe(0);
  });

  test("result quoting the limit phrase on a clean exit is not a rate limit", async () => {
    expect(isRateLimited()).toBe(false);
    const exe = fakeClaude([
      "cat <<'EOF'",
      `{"type":"result","is_error":false,"result":"The docs say: You've hit your limit · resets 3pm (UTC)"}`,
      "EOF",
      "exit 0",
    ].join("\n"));
    const res = await runTaskClaude(opts(exe));
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(isRateLimited()).toBe(false);
  });

  test("is_error result with the limit phrase is a rate limit", async () => {
    const exe = fakeClaude([
      "cat <<'EOF'",
      `{"type":"result","is_error":true,"result":"You've hit your limit · resets 3pm (UTC)"}`,
      "EOF",
      "exit 0",
    ].join("\n"));
    const res = await runTaskClaude(opts(exe));
    expect(res.reason).toBe("rate_limit");
  });

  // Keep last: rate-limit state is a module-level global that cannot be reset.
  test("rate limit", async () => {
    const exe = fakeClaude([
      "cat <<'EOF'",
      `{"type":"result","result":"You've hit your limit · resets 3pm (UTC)"}`,
      "EOF",
      "exit 1",
    ].join("\n"));
    const res = await runTaskClaude(opts(exe));
    expect(res.reason).toBe("rate_limit");
    expect(isRateLimited()).toBe(true);
  });
});

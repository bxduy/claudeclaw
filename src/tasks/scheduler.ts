import { mkdirSync } from "fs";
import { join } from "path";
import type { Task, TaskStore } from "./store";

export interface TaskExecContext {
  dir: string;
  signal: AbortSignal;
  setSessionId: (sessionId: string) => void;
  onProgress: (line: string) => void;
}
export interface TaskOutcome {
  exitCode: number;
  failureReason?: string;
  summary?: string;
}
export type TaskExecutor = (task: Task, ctx: TaskExecContext) => Promise<TaskOutcome>;
export interface TaskObserver {
  started(task: Task): void;
  progress(task: Task, line: string): void;
  finished(task: Task): void;
}

export const noExecutor: TaskExecutor = async () => {
  throw new Error("no_executor");
};

export interface Scheduler {
  start(): void;
  wake(): void;
  stop(): void;
  cancel(id: string): boolean;
}

export function createScheduler(opts: {
  store: TaskStore;
  executor: TaskExecutor;
  getMaxWorkers: () => number;
  tasksDir: string;
  onOutbox?: () => void;
  tickMs?: number;
  isPaused?: () => boolean;
  observer?: TaskObserver;
}): Scheduler {
  const { store, executor, getMaxWorkers, tasksDir, onOutbox, tickMs = 5000, isPaused, observer } = opts;
  const controllers = new Map<string, AbortController>();

  function notify(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error("[tasks] observer failed:", err);
    }
  }
  let stopped = false;
  let running = false;
  let rerun = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function execute(task: Task): Promise<void> {
    let failureReason: string | null = null;
    let exitCode: number | undefined;
    let summary: string | undefined;
    let cancelled = false;
    let startedNotified = false;
    const controller = new AbortController();
    controllers.set(task.id, controller);
    try {
      try {
        const dir = join(tasksDir, task.id);
        mkdirSync(dir, { recursive: true });
        store.setDir(task.id, dir);
        notify(() => observer?.started(task));
        startedNotified = true;
        const outcome = await executor(task, {
          dir,
          signal: controller.signal,
          setSessionId: (sessionId) => store.setSessionId(task.id, sessionId),
          onProgress: (line) => notify(() => observer?.progress(task, line)),
        });
        summary = outcome.summary;
        if (outcome.failureReason === "cancelled") {
          // The canceller already moved the task to cancelled and owns that state change.
          cancelled = true;
        } else if (outcome.failureReason) {
          failureReason = outcome.failureReason;
          exitCode = outcome.exitCode;
        } else if (outcome.exitCode !== 0) {
          failureReason = "exit";
          exitCode = outcome.exitCode;
        } else {
          exitCode = 0;
        }
      } catch (err) {
        failureReason = err instanceof Error && err.message === "no_executor" ? "no_executor" : "spawn_error";
      }
    } finally {
      controllers.delete(task.id);
    }
    if (stopped) return;
    if (!cancelled) {
      if (failureReason === null) {
        store.transition(task.id, ["running"], "completed", { exitCode, summary });
      } else {
        store.transition(task.id, ["running"], "failed", { exitCode, failureReason, summary });
      }
    }
    const final = store.get(task.id);
    if (final && startedNotified) notify(() => observer?.finished(final));
    onOutbox?.();
    wake();
  }

  function pass(): void {
    if (stopped || isPaused?.()) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        while (!stopped) {
          const task = store.claim(getMaxWorkers());
          if (!task) break;
          execute(task).catch((err) => console.error(`[tasks] finishing ${task.id} failed:`, err));
        }
      } while (rerun && !stopped);
    } finally {
      running = false;
    }
  }

  function wake(): void {
    pass();
  }

  return {
    start() {
      if (stopped || timer) return;
      timer = setInterval(pass, tickMs);
      pass();
    },
    wake,
    stop() {
      stopped = true;
      for (const controller of controllers.values()) controller.abort("shutdown");
      if (timer) clearInterval(timer);
      timer = null;
    },
    cancel(id) {
      const controller = controllers.get(id);
      if (!controller) return false;
      controller.abort("cancelled");
      return true;
    },
  };
}

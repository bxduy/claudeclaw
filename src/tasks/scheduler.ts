import { mkdirSync } from "fs";
import { join } from "path";
import type { Task, TaskStore } from "./store";

export type TaskExecutor = (task: Task, ctx: { dir: string }) => Promise<{ exitCode: number }>;

export const noExecutor: TaskExecutor = async () => {
  throw new Error("no_executor");
};

export interface Scheduler {
  start(): void;
  wake(): void;
  stop(): void;
}

export function createScheduler(opts: {
  store: TaskStore;
  executor: TaskExecutor;
  getMaxWorkers: () => number;
  tasksDir: string;
  onOutbox?: () => void;
  tickMs?: number;
}): Scheduler {
  const { store, executor, getMaxWorkers, tasksDir, onOutbox, tickMs = 5000 } = opts;
  let stopped = false;
  let running = false;
  let rerun = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function execute(task: Task): Promise<void> {
    let failureReason: string | null = null;
    let exitCode = 0;
    try {
      const dir = join(tasksDir, task.id);
      mkdirSync(dir, { recursive: true });
      store.setDir(task.id, dir);
      exitCode = (await executor(task, { dir })).exitCode;
      if (exitCode !== 0) failureReason = "exit";
    } catch (err) {
      failureReason = err instanceof Error && err.message === "no_executor" ? "no_executor" : "spawn_error";
    }
    if (stopped) return;
    if (failureReason === null) {
      store.transition(task.id, ["running"], "completed", { exitCode });
    } else if (failureReason === "exit") {
      store.transition(task.id, ["running"], "failed", { exitCode, failureReason });
    } else {
      store.transition(task.id, ["running"], "failed", { failureReason });
    }
    onOutbox?.();
    wake();
  }

  function pass(): void {
    if (stopped) return;
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
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

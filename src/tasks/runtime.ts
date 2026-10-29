import type { Notifier } from "./notifier";
import type { Scheduler } from "./scheduler";
import type { TaskStore } from "./store";

export interface TaskRuntime {
  store: TaskStore;
  scheduler: Scheduler;
  notifier: Notifier;
  getMaxWorkers: () => number;
}

let current: TaskRuntime | null = null;

export function getTaskRuntime(): TaskRuntime | null {
  return current;
}

export function setTaskRuntime(runtime: TaskRuntime | null): void {
  current = runtime;
}

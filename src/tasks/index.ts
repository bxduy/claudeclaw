import { createNotifier, type NotifySend } from "./notifier";
import { getTaskRuntime, setTaskRuntime, type TaskRuntime } from "./runtime";
import { createScheduler, noExecutor, type TaskExecutor, type TaskObserver } from "./scheduler";
import { openTaskStore } from "./store";

export const OUTBOX_RETENTION_MS = 7 * 86_400_000;

export function initTaskRuntime(opts: {
  dbPath: string;
  tasksDir: string;
  getMaxWorkers: () => number;
  send: NotifySend;
  executor?: TaskExecutor;
  observer?: TaskObserver;
  isPaused?: () => boolean;
  schedulerTickMs?: number;
  notifierTickMs?: number;
}): TaskRuntime {
  const store = openTaskStore(opts.dbPath);
  store.failInterrupted();
  store.pruneOutbox(OUTBOX_RETENTION_MS);
  const notifier = createNotifier({ store, send: opts.send, tickMs: opts.notifierTickMs });
  notifier.start();
  const scheduler = createScheduler({
    store,
    executor: opts.executor ?? noExecutor,
    getMaxWorkers: opts.getMaxWorkers,
    tasksDir: opts.tasksDir,
    onOutbox: () => notifier.wake(),
    observer: opts.observer,
    isPaused: opts.isPaused,
    tickMs: opts.schedulerTickMs,
  });
  scheduler.start();
  const runtime: TaskRuntime = {
    store,
    scheduler,
    notifier,
    getMaxWorkers: opts.getMaxWorkers,
    cancel: (id) => {
      // Move the task out of running first; the scheduler skips its own transition on "cancelled".
      if (!store.transition(id, ["running"], "cancelled")) return "not_running";
      scheduler.cancel(id);
      return "cancelled";
    },
  };
  setTaskRuntime(runtime);
  return runtime;
}

export function stopTaskRuntime(): void {
  const runtime = getTaskRuntime();
  if (!runtime) return;
  runtime.scheduler.stop();
  runtime.notifier.stop();
  runtime.store.close();
  setTaskRuntime(null);
}

export { getTaskRuntime } from "./runtime";

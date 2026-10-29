import { createNotifier, type NotifySend } from "./notifier";
import { getTaskRuntime, setTaskRuntime, type TaskRuntime } from "./runtime";
import { createScheduler, noExecutor, type TaskExecutor } from "./scheduler";
import { openTaskStore } from "./store";

export function initTaskRuntime(opts: {
  dbPath: string;
  tasksDir: string;
  getMaxWorkers: () => number;
  send: NotifySend;
  executor?: TaskExecutor;
  schedulerTickMs?: number;
  notifierTickMs?: number;
}): TaskRuntime {
  const store = openTaskStore(opts.dbPath);
  store.failInterrupted();
  const notifier = createNotifier({ store, send: opts.send, tickMs: opts.notifierTickMs });
  notifier.start();
  const scheduler = createScheduler({
    store,
    executor: opts.executor ?? noExecutor,
    getMaxWorkers: opts.getMaxWorkers,
    tasksDir: opts.tasksDir,
    onOutbox: () => notifier.wake(),
    tickMs: opts.schedulerTickMs,
  });
  scheduler.start();
  const runtime: TaskRuntime = {
    store,
    scheduler,
    notifier,
    getMaxWorkers: opts.getMaxWorkers,
    cancel: (id) => (scheduler.cancel(id) ? "cancelled" : "not_running"),
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

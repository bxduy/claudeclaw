import type { TaskRuntime } from "./runtime";
import type { Task } from "./store";

export const TASK_DISABLED_TEXT = "Task mode is disabled.";

const LIST_LIMIT = 10;
const LIST_PROMPT_CHARS = 40;
const STATUS_PROMPT_CHARS = 200;

/** Text after the first whitespace, trimmed. Drops the whole first token, including any @bot suffix. */
export function parseTaskCommandArg(text: string): string {
  const match = text.match(/\s/);
  return match ? text.slice(match.index!).trim() : "";
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatTaskList(tasks: Task[], now: number): string {
  if (tasks.length === 0) return "No tasks yet.";
  return tasks
    .slice(0, LIST_LIMIT)
    .map((t) => {
      const prompt = t.prompt.replace(/\r?\n/g, " ").slice(0, LIST_PROMPT_CHARS);
      return `${t.id} · ${t.status} · ${formatAge(now - t.createdAt)} · ${prompt}`;
    })
    .join("\n");
}

export function formatTaskStatus(task: Task): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const lines = [`Task ${task.id}`, `Status: ${task.status}`, `Created: ${iso(task.createdAt)}`];
  if (task.startedAt !== null) lines.push(`Started: ${iso(task.startedAt)}`);
  if (task.finishedAt !== null) lines.push(`Finished: ${iso(task.finishedAt)}`);
  if (task.exitCode !== null) lines.push(`Exit code: ${task.exitCode}`);
  if (task.failureReason) lines.push(`Failure: ${task.failureReason}`);
  lines.push(`Prompt: ${task.prompt.slice(0, STATUS_PROMPT_CHARS)}`);
  return lines.join("\n");
}

export function taskCommandReply(
  command: string | null,
  text: string,
  ctx: { chatId: number; threadId?: number; userId?: number },
  runtime: TaskRuntime | null,
  now: number = Date.now()
): string | null {
  if (command !== "/task" && command !== "/tasks" && command !== "/cancel" && command !== "/status") return null;
  const arg = parseTaskCommandArg(text);
  if (command === "/status" && !arg) return null;
  if (!runtime) return TASK_DISABLED_TEXT;
  const { store } = runtime;

  if (command === "/task") {
    if (!arg) return "Usage: /task <prompt>";
    const task = store.create({ prompt: arg, chatId: ctx.chatId, threadId: ctx.threadId, userId: ctx.userId });
    runtime.scheduler.wake();
    return `Queued task ${task.id} (running ${store.countRunning()}/${runtime.getMaxWorkers()}).`;
  }

  if (command === "/tasks") return formatTaskList(store.list(LIST_LIMIT), now);

  if (command === "/cancel" && !arg) return "Usage: /cancel <id>";

  const id = arg.toLowerCase();
  const task = store.get(id);
  if (!task) return `Task ${id} not found.`;

  if (command === "/status") return formatTaskStatus(task);

  if (task.status === "queued") {
    if (store.transition(id, ["queued"], "cancelled")) return `Cancelled task ${id}.`;
  }
  // Re-read: the task may have been claimed between get and transition.
  const current = store.get(id)!;
  if (current.status === "running") {
    return `Task ${id} is running; cancelling a running task is not supported yet.`;
  }
  return `Task ${id} is already ${current.status}.`;
}

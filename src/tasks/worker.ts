import { writeFileSync } from "fs";
import { join } from "path";
import { runTaskClaude, type TaskRunOptions, type TaskRunResult } from "../runner";
import type { TasksConfig } from "../config";
import type { TaskExecutor } from "./scheduler";

export const SUMMARY_LIMIT = 3000;
const LINE_LIMIT = 80;
const INPUT_FIELDS = ["file_path", "command", "pattern", "url", "description"];

export function progressLine(event: Record<string, unknown>): string | null {
  if (event.type !== "assistant") return null;
  const content = (event.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;

  const toolUse = content.find((b) => b?.type === "tool_use");
  if (toolUse) {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const field = INPUT_FIELDS.find((f) => typeof input[f] === "string" && input[f] !== "");
    const summary = field ? String(input[field]).slice(0, LINE_LIMIT) : "";
    return summary ? `● ${toolUse.name} ${summary}` : `● ${toolUse.name}`;
  }
  const text = content.find((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
  if (text) return `✍ ${String(text.text).replace(/\n/g, " ").slice(0, LINE_LIMIT)}`;
  return null;
}

export function createClaudeExecutor(opts: {
  cwd: string;
  getTasksConfig: () => TasksConfig;
  run?: (opts: TaskRunOptions) => Promise<TaskRunResult>;
}): TaskExecutor {
  const run = opts.run ?? runTaskClaude;
  return async (task, ctx) => {
    const cfg = opts.getTasksConfig();
    const sessionId = crypto.randomUUID();
    ctx.setSessionId(sessionId);
    const res = await run({
      prompt: task.prompt,
      sessionId,
      cwd: opts.cwd,
      timeoutMs: cfg.timeoutMinutes * 60000,
      idleTimeoutMs: cfg.idleTimeoutMinutes * 60000,
      eventLogPath: join(ctx.dir, "events.ndjson"),
      signal: ctx.signal,
      onEvent: (event) => {
        const line = progressLine(event);
        if (line) ctx.onProgress(line);
      },
    });
    const body = res.result || res.stderr;
    let written = true;
    try {
      writeFileSync(join(ctx.dir, "result.md"), body);
    } catch (err) {
      written = false;
      console.error(`[tasks] failed to write result.md for ${task.id}:`, err);
    }
    const truncated = body.length > SUMMARY_LIMIT;
    let summary = truncated ? body.slice(0, SUMMARY_LIMIT) : body;
    if (written && truncated) summary += `\n\n(truncated, full result: tasks/${task.id}/result.md)`;
    else if (truncated) summary += "\n\n(truncated; result.md could not be written)";
    else if (!written) summary += "\n\n(result.md could not be written)";
    return { exitCode: res.exitCode, summary, ...(res.reason ? { failureReason: res.reason } : {}) };
  };
}

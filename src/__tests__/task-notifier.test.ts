import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTaskStore, type OutboxRow, type TaskStore } from "../tasks/store";
import { createNotifier, type Notifier, type NotifySend } from "../tasks/notifier";
import { TelegramApiError } from "../commands/telegram";

let dir: string;
let store: TaskStore;
let notifier: Notifier | null;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Creates a running task and finishes it, which writes one outbox row.
function addOutbox(chatId = 1, threadId?: number): void {
  const t = store.create({ prompt: "p", chatId, threadId });
  store.transition(t.id, ["queued"], "running");
  store.transition(t.id, ["running"], "completed", { exitCode: 0 });
}

function rows(): OutboxRow[] {
  return (store.db.query("SELECT id FROM outbox ORDER BY id").all() as { id: number }[]).map(
    (r) => rowById(r.id)
  );
}

function rowById(id: number): OutboxRow {
  const r = store.db.query("SELECT * FROM outbox WHERE id = ?").get(id) as Record<string, any>;
  return {
    id: r.id,
    taskId: r.task_id,
    chatId: r.chat_id,
    threadId: r.thread_id,
    text: r.text,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function make(send: NotifySend, extra: { tickMs?: number; backoffMs?: (n: number) => number } = {}): Notifier {
  notifier = createNotifier({ store, send, tickMs: extra.tickMs ?? 60_000, backoffMs: extra.backoffMs });
  return notifier;
}

beforeEach(() => {
  dir = join(tmpdir(), `claudeclaw-task-notifier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  store = openTaskStore(join(dir, "tasks.db"));
  notifier = null;
});

afterEach(() => {
  notifier?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("notifier", () => {
  test("sends with thread id and marks sent", async () => {
    addOutbox(42, 7);
    const calls: [number, string, number | undefined][] = [];
    make(async (c, t, th) => {
      calls.push([c, t, th]);
    }).start();
    await waitFor(() => rows()[0].state === "sent");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(42);
    expect(calls[0][2]).toBe(7);
    expect(calls[0][1]).toBe(rows()[0].text);
    expect(rows()[0].sentAt).not.toBeNull();
  });

  test("null thread id is passed as undefined", async () => {
    addOutbox(42);
    let seen: unknown = "unset";
    make(async (_c, _t, th) => {
      seen = th;
    }).start();
    await waitFor(() => rows()[0].state === "sent");
    expect(seen).toBeUndefined();
  });

  test("429 waits retry_after", async () => {
    addOutbox();
    const times: number[] = [];
    make(
      async () => {
        times.push(Date.now());
        if (times.length === 1) throw new TelegramApiError("sendMessage", 429, "Too Many Requests", 1);
      },
      { tickMs: 50 }
    ).start();
    await waitFor(() => rows()[0].state === "sent");
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
    expect(rows()[0].attempts).toBe(0);
  });

  test("400 -> dead after one attempt", async () => {
    addOutbox();
    let n = 0;
    make(async () => {
      n++;
      throw new TelegramApiError("sendMessage", 400, "Bad Request: chat not found");
    }).start();
    await waitFor(() => rows()[0].state === "dead");
    expect(rows()[0].attempts).toBe(1);
    expect(rows()[0].lastError).toContain("chat not found");
    expect(n).toBe(1);
  });

  test("network errors -> dead at 10", async () => {
    addOutbox();
    let n = 0;
    make(
      async () => {
        n++;
        throw new Error("ECONNRESET");
      },
      { tickMs: 10, backoffMs: () => 0 }
    ).start();
    await waitFor(() => rows()[0].state === "dead");
    expect(rows()[0].attempts).toBe(10);
    expect(rows()[0].lastError).toContain("ECONNRESET");
    expect(n).toBe(10);
  });

  test("429 stops the pass", async () => {
    addOutbox();
    addOutbox();
    let n = 0;
    make(async () => {
      n++;
      throw new TelegramApiError("sendMessage", 429, "Too Many Requests", 60);
    }).start();
    await waitFor(() => n >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(1);
    const [a, b] = rows();
    expect(a.attempts).toBe(0);
    expect(a.state).toBe("pending");
    expect(a.lastError).toContain("429");
    expect(b.attempts).toBe(0);
    expect(b.lastError).toBeNull();
  });

  test("429 does not count toward dead", async () => {
    addOutbox();
    let n = 0;
    make(
      async () => {
        n++;
        if (n <= 12) throw new TelegramApiError("sendMessage", 429, "Too Many Requests");
      },
      { tickMs: 10, backoffMs: () => 0 }
    ).start();
    await waitFor(() => rows()[0].state === "sent");
    expect(rows()[0].attempts).toBe(0);
    expect(n).toBe(13);
  });

  test("non-429 error does not block later rows", async () => {
    addOutbox(1);
    addOutbox(2);
    make(async (chatId) => {
      if (chatId === 1) throw new TelegramApiError("sendMessage", 400, "Bad Request");
    }).start();
    await waitFor(() => rows()[1].state === "sent");
    expect(rows()[0].state).toBe("dead");
  });

  test("start sends leftover pending", async () => {
    addOutbox();
    const sent: string[] = [];
    make(async (_c, t) => {
      sent.push(t);
    }).start();
    await waitFor(() => sent.length === 1);
  });

  test("wake sends a row inserted after start", async () => {
    const sent: string[] = [];
    const n = make(async (_c, t) => {
      sent.push(t);
    });
    n.start();
    addOutbox();
    n.wake();
    await waitFor(() => sent.length === 1);
  });
});

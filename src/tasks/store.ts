import { Database } from "bun:sqlite";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  chatId: number;
  threadId: number | null;
  userId: number | null;
  sessionId: string | null;
  dir: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  failureReason: string | null;
}

export interface OutboxRow {
  id: number;
  taskId: string;
  chatId: number;
  threadId: number | null;
  text: string;
  state: "pending" | "sent" | "dead";
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
}

export interface TaskStore {
  readonly db: Database;
  create(input: { prompt: string; chatId: number; threadId?: number; userId?: number }): Task;
  get(id: string): Task | null;
  list(limit: number, chatId?: number): Task[];
  countRunning(): number;
  claim(maxWorkers: number): Task | null;
  transition(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    fields?: { exitCode?: number; failureReason?: string; summary?: string }
  ): Task | null;
  setDir(id: string, dir: string): void;
  setSessionId(id: string, sessionId: string): void;
  failInterrupted(): number;
  pendingOutbox(now: number): OutboxRow[];
  markSent(id: number, now: number): void;
  markFailed(id: number, update: { attempts: number; nextAttemptAt: number; lastError: string; dead: boolean }): void;
  pruneOutbox(olderThanMs: number): number;
  close(): void;
}

const SCHEMA_V1 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  user_id INTEGER,
  session_id TEXT,
  dir TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  failure_reason TEXT
);
CREATE UNIQUE INDEX tasks_running_session ON tasks(session_id) WHERE status = 'running';
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
PRAGMA user_version = 1;
`;

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

const MAX_ID_ATTEMPTS = 5;

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

function defaultRandomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let id = "t-";
  for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

interface TaskRow {
  id: string;
  prompt: string;
  status: TaskStatus;
  chat_id: number;
  thread_id: number | null;
  user_id: number | null;
  session_id: string | null;
  dir: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  failure_reason: string | null;
}

interface OutboxDbRow {
  id: number;
  task_id: string;
  chat_id: number;
  thread_id: number | null;
  text: string;
  state: OutboxRow["state"];
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    chatId: row.chat_id,
    threadId: row.thread_id,
    userId: row.user_id,
    sessionId: row.session_id,
    dir: row.dir,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    failureReason: row.failure_reason,
  };
}

function toOutbox(row: OutboxDbRow): OutboxRow {
  return {
    id: row.id,
    taskId: row.task_id,
    chatId: row.chat_id,
    threadId: row.thread_id,
    text: row.text,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function notificationText(task: Task, summary?: string): string {
  const tail = summary ? `\n\n${summary}` : "";
  if (task.status === "completed") return `✅ Task ${task.id} completed.${tail}`;
  if (task.status === "failed") return `❌ Task ${task.id} failed (${task.failureReason}).${tail}`;
  return `🚫 Task ${task.id} cancelled.`;
}

export function openTaskStore(
  dbPath: string,
  opts: { now?: () => number; randomId?: () => string } = {}
): TaskStore {
  const now = opts.now ?? Date.now;
  const randomId = opts.randomId ?? defaultRandomId;

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.transaction(() => {
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
    if (user_version === 0) db.exec(SCHEMA_V1);
  }).immediate();

  const selectTask = db.query("SELECT * FROM tasks WHERE id = ?");
  const insertOutbox = db.query(
    `INSERT INTO outbox (task_id, chat_id, thread_id, text, state, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
  );

  function get(id: string): Task | null {
    const row = selectTask.get(id) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  function create(input: { prompt: string; chatId: number; threadId?: number; userId?: number }): Task {
    const insert = db.query(
      `INSERT INTO tasks (id, prompt, status, chat_id, thread_id, user_id, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?) RETURNING *`
    );
    for (let attempt = 1; ; attempt++) {
      try {
        const row = insert.get(
          randomId(),
          input.prompt,
          input.chatId,
          input.threadId ?? null,
          input.userId ?? null,
          now()
        ) as TaskRow;
        return toTask(row);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "SQLITE_CONSTRAINT_PRIMARYKEY" || attempt >= MAX_ID_ATTEMPTS) throw err;
      }
    }
  }

  function countRunning(): number {
    const row = db.query("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as { n: number };
    return row.n;
  }

  // Runs inside a caller-owned transaction.
  function applyTransition(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    fields: { exitCode?: number; failureReason?: string; summary?: string }
  ): Task | null {
    const previous = get(id);
    const ts = now();
    const placeholders = from.map(() => "?").join(", ");
    const row = db
      .query(
        `UPDATE tasks SET
           status = ?,
           started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
           exit_code = COALESCE(?, exit_code),
           failure_reason = COALESCE(?, failure_reason)
         WHERE id = ? AND status IN (${placeholders})
         RETURNING *`
      )
      .get(
        to,
        to,
        ts,
        TERMINAL.has(to) ? 1 : 0,
        ts,
        fields.exitCode ?? null,
        fields.failureReason ?? null,
        id,
        ...from
      ) as TaskRow | null;
    if (!row) return null;
    const task = toTask(row);
    if (previous?.status === "running" && TERMINAL.has(to)) {
      insertOutbox.run(task.id, task.chatId, task.threadId, notificationText(task, fields.summary), ts, ts);
    }
    return task;
  }

  function transition(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    fields: { exitCode?: number; failureReason?: string; summary?: string } = {}
  ): Task | null {
    if (from.length === 0) throw new Error(`Illegal task transition: [] -> ${to}`);
    for (const f of from) {
      if (!ALLOWED[f].includes(to)) throw new Error(`Illegal task transition: ${f} -> ${to}`);
    }
    return db.transaction(() => applyTransition(id, from, to, fields)).immediate();
  }

  function claim(maxWorkers: number): Task | null {
    return db
      .transaction(() => {
        if (countRunning() >= maxWorkers) return null;
        const next = db
          .query("SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
          .get() as { id: string } | null;
        if (!next) return null;
        return applyTransition(next.id, ["queued"], "running", {});
      })
      .immediate();
  }

  function failInterrupted(): number {
    return db
      .transaction(() => {
        const running = db.query("SELECT id FROM tasks WHERE status = 'running' ORDER BY rowid").all() as {
          id: string;
        }[];
        for (const { id } of running) {
          applyTransition(id, ["running"], "failed", { failureReason: "interrupted" });
        }
        return running.length;
      })
      .immediate();
  }

  return {
    db,
    create,
    get,
    list(limit, chatId) {
      const rows = (
        chatId === undefined
          ? db.query("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit)
          : db
              .query("SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
              .all(chatId, limit)
      ) as TaskRow[];
      return rows.map(toTask);
    },
    countRunning,
    claim,
    transition,
    setDir(id, dir) {
      db.query("UPDATE tasks SET dir = ? WHERE id = ?").run(dir, id);
    },
    setSessionId(id, sessionId) {
      db.query("UPDATE tasks SET session_id = ? WHERE id = ?").run(sessionId, id);
    },
    failInterrupted,
    pendingOutbox(at) {
      const rows = db
        .query("SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id ASC")
        .all(at) as OutboxDbRow[];
      return rows.map(toOutbox);
    },
    markSent(id, at) {
      db.query("UPDATE outbox SET state = 'sent', sent_at = ? WHERE id = ?").run(at, id);
    },
    markFailed(id, update) {
      db.query(
        "UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?"
      ).run(update.dead ? "dead" : "pending", update.attempts, update.nextAttemptAt, update.lastError, id);
    },
    pruneOutbox(olderThanMs) {
      return db
        .query("DELETE FROM outbox WHERE state IN ('sent', 'dead') AND created_at < ?")
        .run(now() - olderThanMs).changes;
    },
    close() {
      db.close();
    },
  };
}

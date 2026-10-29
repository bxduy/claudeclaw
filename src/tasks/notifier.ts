import { TelegramApiError, pollBackoffMs } from "../commands/telegram";
import type { OutboxRow, TaskStore } from "./store";

export type NotifySend = (chatId: number, text: string, threadId?: number) => Promise<void>;

export const MAX_NOTIFY_ATTEMPTS = 10;

export interface Notifier {
  start(): void;
  wake(): void;
  stop(): void;
}

export function createNotifier(opts: {
  store: TaskStore;
  send: NotifySend;
  tickMs?: number;
  backoffMs?: (attempts: number) => number;
  now?: () => number;
}): Notifier {
  const { store, send, tickMs = 2000, backoffMs = pollBackoffMs, now = Date.now } = opts;
  let stopped = false;
  let running = false;
  let rerun = false;
  let pausedUntil = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Returns false when the pass must stop (rate limited).
  async function deliver(row: OutboxRow): Promise<boolean> {
    try {
      await send(row.chatId, row.text, row.threadId ?? undefined);
    } catch (err) {
      if (stopped) return false;
      const lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof TelegramApiError && err.code === 429) {
        const wait = err.retryAfter !== undefined ? err.retryAfter * 1000 : backoffMs(row.attempts + 1);
        pausedUntil = now() + wait;
        store.markFailed(row.id, {
          attempts: row.attempts,
          nextAttemptAt: pausedUntil,
          lastError,
          dead: false,
        });
        return false;
      }
      const attempts = row.attempts + 1;
      const permanent = err instanceof TelegramApiError && err.code >= 400 && err.code < 500;
      store.markFailed(row.id, {
        attempts,
        nextAttemptAt: now() + backoffMs(attempts),
        lastError,
        dead: permanent || attempts >= MAX_NOTIFY_ATTEMPTS,
      });
      return true;
    }
    if (!stopped) store.markSent(row.id, now());
    return true;
  }

  async function pass(): Promise<void> {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        if (now() < pausedUntil) return;
        for (const row of store.pendingOutbox(now())) {
          if (stopped) return;
          if (!(await deliver(row))) return;
        }
      } while (rerun && !stopped);
    } finally {
      running = false;
    }
  }

  function run(): void {
    pass().catch((err) => console.error("[tasks] notifier pass failed:", err));
  }

  return {
    start() {
      if (stopped || timer) return;
      timer = setInterval(run, tickMs);
      run();
    },
    wake: run,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

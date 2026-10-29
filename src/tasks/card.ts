import { formatAge } from "./commands";
import type { TaskObserver } from "./scheduler";
import type { Task } from "./store";

export interface CardApi {
  send(chatId: number, text: string, threadId?: number): Promise<number>;
  edit(chatId: number, messageId: number, text: string): Promise<void>;
}

const PROMPT_CHARS = 80;
const ICONS: Record<string, string> = { completed: "✅", failed: "❌", cancelled: "🚫" };

interface Card {
  chatId: number;
  prompt: string;
  startedAt: number;
  messageId: number | null;
  sent: Promise<void>;
  lastText: string;
  latestLine: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export function createStatusCards(opts: {
  api: CardApi;
  getIntervalMs: () => number;
  now?: () => number;
}): TaskObserver {
  const { api, getIntervalMs } = opts;
  const now = opts.now ?? Date.now;
  const cards = new Map<string, Card>();

  function runningText(id: string, card: Card): string {
    return `⏳ Task ${id} running · ${formatAge(now() - card.startedAt)}\n${card.latestLine ?? card.prompt}`;
  }

  /** Edits are chained on card.sent so they never overlap and the final one always runs last. */
  function edit(card: Card, text: string, final = false): Promise<void> {
    card.sent = card.sent.then(async () => {
      if (card.done && !final) return;
      if (card.messageId === null || text === card.lastText) return;
      card.lastText = text;
      try {
        await api.edit(card.chatId, card.messageId, text);
      } catch (err) {
        console.error("[tasks] card edit failed:", err);
      }
    });
    return card.sent;
  }

  function schedule(id: string, card: Card): void {
    if (card.done) return;
    // The timer must not keep the process alive on its own.
    card.timer = setTimeout(async () => {
      card.timer = null;
      if (card.done) return;
      await edit(card, runningText(id, card));
      schedule(id, card);
    }, getIntervalMs());
    (card.timer as { unref?: () => void }).unref?.();
  }

  return {
    started(task: Task) {
      const card: Card = {
        chatId: task.chatId,
        prompt: task.prompt.replace(/\s*[\r\n]+\s*/g, " ").slice(0, PROMPT_CHARS),
        startedAt: now(),
        messageId: null,
        sent: Promise.resolve(),
        lastText: "",
        latestLine: null,
        timer: null,
        done: false,
      };
      card.lastText = runningText(task.id, card);
      cards.set(task.id, card);
      card.sent = api
        .send(task.chatId, card.lastText, task.threadId ?? undefined)
        .then((messageId) => {
          card.messageId = messageId;
        })
        .catch((err) => {
          console.error("[tasks] card send failed:", err);
        });
      schedule(task.id, card);
    },

    progress(task: Task, line: string) {
      const card = cards.get(task.id);
      if (card && !card.done) card.latestLine = line;
    },

    finished(task: Task) {
      const card = cards.get(task.id);
      if (!card) return;
      card.done = true;
      if (card.timer) clearTimeout(card.timer);
      card.timer = null;
      cards.delete(task.id);
      const icon = ICONS[task.status] ?? "⏳";
      void edit(card, `${icon} Task ${task.id} ${task.status} · ${formatAge(now() - card.startedAt)}`, true);
    },
  };
}

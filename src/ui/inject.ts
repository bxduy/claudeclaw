import type { RunResult } from "../runner";

export interface InjectDeps {
  run: (message: string, sessionKey?: string) => Promise<RunResult>;
  deliver?: (chatId: number, text: string, threadId?: number) => Promise<void>;
  defaultChatId?: number;
}

type InjectResponse = { status: number; body: Record<string, unknown> };

const bad = (error: string): InjectResponse => ({ status: 400, body: { ok: false, error } });

export async function handleInject(body: unknown, deps: InjectDeps): Promise<InjectResponse> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) return bad("message is required");

  const chatId = b.chatId;
  const threadId = b.threadId;
  if (chatId !== undefined && !Number.isSafeInteger(chatId)) return bad("chatId must be an integer");
  if (threadId !== undefined && !(Number.isSafeInteger(threadId) && (threadId as number) > 0)) {
    return bad("threadId must be a positive integer");
  }
  if (threadId !== undefined && chatId === undefined) return bad("threadId requires chatId");

  const sessionKey =
    chatId === undefined ? undefined : `tg:${chatId}${threadId === undefined ? "" : `:${threadId}`}`;
  const result = await deps.run(message, sessionKey);

  const text = result.stdout.trim();
  const target = (chatId as number | undefined) ?? deps.defaultChatId;
  let delivered = false;
  if (text && deps.deliver && target !== undefined) {
    try {
      await deps.deliver(target, text, threadId as number | undefined);
      delivered = true;
    } catch (err) {
      console.error("[inject] deliver failed", err);
    }
  }
  return { status: 200, body: { ok: true, result: result.stdout, exitCode: result.exitCode, delivered } };
}

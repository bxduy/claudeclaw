import { describe, test, expect, spyOn } from "bun:test";
import { handleInject } from "../ui/inject";

function setup(stdout = "ok", deliverImpl?: () => Promise<void>) {
  const runCalls: unknown[][] = [];
  const deliverCalls: unknown[][] = [];
  const deps = {
    run: async (...args: unknown[]) => {
      runCalls.push(args);
      return { stdout, stderr: "", exitCode: 0 };
    },
    deliver: async (...args: unknown[]) => {
      deliverCalls.push(args);
      if (deliverImpl) await deliverImpl();
    },
    defaultChatId: 42,
  };
  return { deps, runCalls, deliverCalls };
}

describe("handleInject", () => {
  test("routes to topic session and chat", async () => {
    const { deps, runCalls, deliverCalls } = setup();
    const res = await handleInject({ message: "x", chatId: -1001, threadId: 7 }, deps);
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);
    expect(runCalls).toEqual([["x", "tg:-1001:7"]]);
    expect(deliverCalls).toEqual([[-1001, "ok", 7]]);
  });

  test("group without topic", async () => {
    const { deps, runCalls } = setup();
    await handleInject({ message: "x", chatId: -1001 }, deps);
    expect(runCalls[0]).toEqual(["x", "tg:-1001"]);
  });

  test("no chatId keeps global session and DM", async () => {
    const { deps, runCalls, deliverCalls } = setup();
    await handleInject({ message: "x" }, deps);
    expect(runCalls[0]).toEqual(["x", undefined]);
    expect(deliverCalls).toEqual([[42, "ok", undefined]]);
  });

  test("rejects bad chatId", async () => {
    const { deps, runCalls } = setup();
    const res = await handleInject({ message: "x", chatId: "abc" }, deps);
    expect(res.status).toBe(400);
    expect(runCalls.length).toBe(0);
  });

  test("rejects threadId without chatId", async () => {
    const { deps, runCalls } = setup();
    const res = await handleInject({ message: "x", threadId: 7 }, deps);
    expect(res.status).toBe(400);
    expect(runCalls.length).toBe(0);
  });

  test("rejects empty message", async () => {
    const { deps } = setup();
    expect((await handleInject({ message: "  " }, deps)).status).toBe(400);
  });

  test("rejects non-positive threadId", async () => {
    const { deps, runCalls } = setup();
    const res = await handleInject({ message: "x", chatId: -1001, threadId: 0 }, deps);
    expect(res.status).toBe(400);
    expect(runCalls.length).toBe(0);
  });

  test("reports delivery failure", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = setup("ok", async () => {
        throw new Error("boom");
      });
      const res = await handleInject({ message: "x" }, deps);
      expect(res.status).toBe(200);
      expect(res.body.delivered).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0]).startsWith("[inject] deliver failed")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("failed run is not delivered", async () => {
    const { deps, deliverCalls } = setup("error text");
    deps.run = async () => ({ stdout: "error text", stderr: "", exitCode: 1 });
    const res = await handleInject({ message: "x", chatId: -1001, threadId: 7 }, deps);
    expect(deliverCalls.length).toBe(0);
    expect(res.body.delivered).toBe(false);
    expect(res.body.exitCode).toBe(1);
  });

  test("deliver failure log masks the bot token", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = setup("ok", async () => {
        throw new Error("fetch https://api.telegram.org/bot123456:AA-b_c/sendMessage failed");
      });
      await handleInject({ message: "x" }, deps);
      const logged = String(spy.mock.calls[0][0]);
      expect(logged).toContain("bot***");
      expect(logged).not.toContain("123456:AA-b_c");
    } finally {
      spy.mockRestore();
    }
  });

  test("empty stdout is not delivered", async () => {
    const { deps, deliverCalls } = setup("  ");
    const res = await handleInject({ message: "x" }, deps);
    expect(deliverCalls.length).toBe(0);
    expect(res.body.delivered).toBe(false);
  });
});

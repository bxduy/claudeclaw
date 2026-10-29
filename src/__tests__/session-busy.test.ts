import { describe, it, expect } from "bun:test";
import { enqueue, isSessionBusy } from "../runner";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

describe("isSessionBusy", () => {
  it("counts queued and running jobs per key", async () => {
    const g1 = gate();
    const g2 = gate();
    const p1 = enqueue(() => g1.promise, "a");
    const p2 = enqueue(() => g2.promise, "a");
    expect(isSessionBusy("a")).toBe(true);
    expect(isSessionBusy("b")).toBe(false);
    expect(isSessionBusy()).toBe(false);
    g1.release();
    g2.release();
    await Promise.all([p1, p2]);
    expect(isSessionBusy("a")).toBe(false);
  });

  it("marks busy synchronously", async () => {
    const g = gate();
    const p = enqueue(() => g.promise, "s");
    expect(isSessionBusy("s")).toBe(true);
    g.release();
    await p;
  });

  it("global queue does not mark other keys busy", async () => {
    const g = gate();
    const p = enqueue(() => g.promise);
    expect(isSessionBusy()).toBe(true);
    expect(isSessionBusy(undefined)).toBe(true);
    expect(isSessionBusy("tg:dm:1")).toBe(false);
    g.release();
    await p;
  });

  it("clears after a rejected job", async () => {
    const p = enqueue(() => Promise.reject(new Error("boom")), "r");
    await expect(p).rejects.toThrow("boom");
    expect(isSessionBusy("r")).toBe(false);
  });
});

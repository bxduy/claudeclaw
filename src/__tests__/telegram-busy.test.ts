import { describe, expect, test } from "bun:test";
import { decideBusyAction } from "../commands/telegram";
import { parseBusyMode } from "../config";

describe("decideBusyAction", () => {
  test("reject mode", () => {
    expect(decideBusyAction("reject", false)).toBe("run");
    expect(decideBusyAction("reject", true)).toBe("reject");
  });
  test("queue mode", () => {
    expect(decideBusyAction("queue", false)).toBe("run");
    expect(decideBusyAction("queue", true)).toBe("queue");
  });
});

describe("parseBusyMode", () => {
  test("only exact 'queue' enables queue mode", () => {
    expect(parseBusyMode("queue")).toBe("queue");
    expect(parseBusyMode("reject")).toBe("reject");
    expect(parseBusyMode("QUEUE")).toBe("reject");
    expect(parseBusyMode(undefined)).toBe("reject");
    expect(parseBusyMode(42)).toBe("reject");
  });
});

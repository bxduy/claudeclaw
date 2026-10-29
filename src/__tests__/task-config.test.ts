import { describe, expect, test } from "bun:test";
import { parseTasksSettings } from "../config";

describe("parseTasksSettings", () => {
  test("defaults when undefined", () => {
    expect(parseTasksSettings(undefined)).toEqual({ enabled: false, maxWorkers: 5 });
  });

  test("accepts valid values", () => {
    expect(parseTasksSettings({ enabled: true, maxWorkers: 3 })).toEqual({ enabled: true, maxWorkers: 3 });
  });

  test("only boolean true enables", () => {
    expect(parseTasksSettings({ enabled: "true" }).enabled).toBe(false);
  });

  test("floors fractional maxWorkers", () => {
    expect(parseTasksSettings({ maxWorkers: 2.9 }).maxWorkers).toBe(2);
  });

  test("invalid maxWorkers falls back to 5", () => {
    for (const v of [-1, 0, 0.5, "4", Infinity]) {
      expect(parseTasksSettings({ maxWorkers: v }).maxWorkers).toBe(5);
    }
  });
});

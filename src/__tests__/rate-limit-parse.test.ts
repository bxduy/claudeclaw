import { describe, expect, test } from "bun:test";
import { parseRateLimitResetTime } from "../runner";

describe("parseRateLimitResetTime", () => {
  // 2026-11-20 07:40 UTC = 14:40 in Asia/Ho_Chi_Minh (UTC+7)
  const now = new Date("2026-11-20T07:40:00Z");

  test("UTC reset later today", () => {
    expect(parseRateLimitResetTime("You've hit your limit · resets 3pm (UTC)", now)).toBe(Date.parse("2026-11-20T15:00:00Z"));
  });

  test("IANA zone reset already passed today rolls to tomorrow", () => {
    const msg = "You've hit your weekly limit · resets 1pm (Asia/Ho_Chi_Minh)";
    expect(parseRateLimitResetTime(msg, now)).toBe(Date.parse("2026-11-21T06:00:00Z"));
  });

  test("IANA zone reset later today, with minutes", () => {
    const msg = "You've hit your limit · resets 9:30pm (Asia/Ho_Chi_Minh)";
    expect(parseRateLimitResetTime(msg, now)).toBe(Date.parse("2026-11-20T14:30:00Z"));
  });

  test("unknown zone gives null (caller falls back to +60 min)", () => {
    expect(parseRateLimitResetTime("resets 1pm (Mars/Olympus_Mons)", now)).toBeNull();
  });

  test("no reset clause gives null", () => {
    expect(parseRateLimitResetTime("You've hit your limit", now)).toBeNull();
  });
});

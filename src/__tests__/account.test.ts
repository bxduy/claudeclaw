import { afterAll, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tokenFile = "";
mock.module("../config", () => ({
  getSettings: () => ({ fallback: { model: "", api: "", oauthTokenFile: tokenFile } }),
}));

const { applyAccountEnv, fallbackAccountAfterLimit, isOnFallbackAccount, primaryAccountResetAt, resetAccountState, switchToFallbackAccount } = await import("../account");

const dir = mkdtempSync(join(tmpdir(), "claudeclaw-account-"));
const validFile = join(dir, "account2.token");
writeFileSync(validFile, "  oat-test-token\n");

afterAll(() => {
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

describe("fallback account", () => {
  beforeEach(() => {
    setSystemTime();
    resetAccountState();
    tokenFile = validFile;
  });

  test("without a token file there is nothing to switch to", () => {
    tokenFile = "";
    expect(switchToFallbackAccount(null)).toBe(false);
    expect(isOnFallbackAccount()).toBe(false);
    expect(applyAccountEnv({ A: "1" })).toEqual({ A: "1" });
  });

  test("an unreadable token file does not switch", () => {
    tokenFile = join(dir, "missing.token");
    expect(switchToFallbackAccount(null)).toBe(false);
    expect(isOnFallbackAccount()).toBe(false);
  });

  test("primary env carries no OAuth token", () => {
    expect(applyAccountEnv({ A: "1" })).toEqual({ A: "1" });
  });

  test("after a switch every spawn env gets the trimmed fallback token", () => {
    expect(switchToFallbackAccount(Date.now() + 3_600_000)).toBe(true);
    expect(isOnFallbackAccount()).toBe(true);
    expect(applyAccountEnv({ A: "1" })).toEqual({ A: "1", CLAUDE_CODE_OAUTH_TOKEN: "oat-test-token" });
  });

  test("a limit hit while already on the fallback account does not switch again", () => {
    expect(switchToFallbackAccount(Date.now() + 3_600_000)).toBe(true);
    expect(switchToFallbackAccount(Date.now() + 7_200_000)).toBe(false);
  });

  test("returns to the primary account once its reset time passes", () => {
    const now = Date.now();
    expect(switchToFallbackAccount(now + 60_000)).toBe(true);
    setSystemTime(new Date(now + 61_000));
    expect(isOnFallbackAccount()).toBe(false);
    expect(applyAccountEnv({})).toEqual({});
  });

  test("unknown reset time stays on the fallback account for 60 minutes", () => {
    const now = Date.now();
    expect(switchToFallbackAccount(null)).toBe(true);
    setSystemTime(new Date(now + 59 * 60_000));
    expect(isOnFallbackAccount()).toBe(true);
    setSystemTime(new Date(now + 61 * 60_000));
    expect(isOnFallbackAccount()).toBe(false);
  });

  test("expands ~ in the token file path", () => {
    tokenFile = "~/definitely-not-a-claudeclaw-token-file";
    expect(switchToFallbackAccount(null)).toBe(false);
  });
});

describe("fallbackAccountAfterLimit", () => {
  beforeEach(() => {
    setSystemTime();
    resetAccountState();
    tokenFile = validFile;
  });

  test("switches when a primary spawn hits the limit", () => {
    expect(fallbackAccountAfterLimit(null, false)).toBe(true);
    expect(isOnFallbackAccount()).toBe(true);
  });

  test("a primary spawn that overlapped another run's switch still goes to the fallback", () => {
    expect(fallbackAccountAfterLimit(null, false)).toBe(true);
    expect(fallbackAccountAfterLimit(null, false)).toBe(true);
  });

  test("a spawn that already ran on the fallback account means both are limited", () => {
    expect(fallbackAccountAfterLimit(null, false)).toBe(true);
    expect(fallbackAccountAfterLimit(null, true)).toBe(false);
  });

  test("primaryAccountResetAt is the primary reset only while on the fallback", () => {
    expect(primaryAccountResetAt()).toBe(0);
    const reset = Date.now() + 60_000;
    fallbackAccountAfterLimit(reset, false);
    expect(primaryAccountResetAt()).toBe(reset);
  });
});

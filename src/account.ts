import { readFileSync } from "fs";
import { homedir } from "os";
import { getSettings } from "./config";

// Fallback Claude account: when the primary account (the CLI's own credential
// store) hits its usage limit, every `claude` spawn switches to the OAuth token
// in `settings.fallback.oauthTokenFile` until the primary account's reset time,
// then returns to the primary account on its own.

let primaryLimitedUntil = 0; // epoch ms; 0 = primary account usable

function tokenFilePath(): string {
  let raw = "";
  try {
    raw = getSettings().fallback?.oauthTokenFile?.trim() ?? "";
  } catch {
    return ""; // settings not loaded (one-off CLI paths, tests): no fallback account
  }
  if (raw === "~") return homedir();
  return raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
}

function readFallbackToken(): string | null {
  const path = tokenFilePath();
  if (!path) return null;
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || null;
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Cannot read fallback.oauthTokenFile ${path}:`, e);
    return null;
  }
}

/** True while spawns run on the fallback account. */
export function isOnFallbackAccount(): boolean {
  if (primaryLimitedUntil === 0) return false;
  if (Date.now() >= primaryLimitedUntil) {
    primaryLimitedUntil = 0;
    console.log(`[${new Date().toLocaleTimeString()}] Primary Claude account reset time passed; switching back to it`);
    return false;
  }
  return true;
}

/**
 * The primary account hit its limit. Switch to the fallback account until
 * `resetAt` (now + 60 min when unknown). Returns false when there is nothing
 * to switch to: no readable token file, or already on the fallback account.
 */
export function switchToFallbackAccount(resetAt: number | null): boolean {
  if (isOnFallbackAccount()) return false;
  if (!readFallbackToken()) return false;
  primaryLimitedUntil = resetAt ?? Date.now() + 60 * 60_000;
  console.warn(
    `[${new Date().toLocaleTimeString()}] Primary Claude account hit its limit; using fallback account until ${new Date(primaryLimitedUntil).toISOString()}`
  );
  return true;
}

/**
 * A spawn hit the usage limit. Returns true when later attempts should run on
 * the fallback account: switches now, or another run already switched while
 * this spawn was still on the primary account. False when the spawn itself ran
 * on the fallback account (both accounts limited) or there is no fallback.
 */
export function fallbackAccountAfterLimit(resetAt: number | null, spawnedOnFallback: boolean): boolean {
  if (spawnedOnFallback) return false;
  if (isOnFallbackAccount()) return true;
  return switchToFallbackAccount(resetAt);
}

/** Primary account reset time while running on the fallback account, else 0. */
export function primaryAccountResetAt(): number {
  return isOnFallbackAccount() ? primaryLimitedUntil : 0;
}

/** Put the active account's credentials into a spawn env (mutates and returns it). */
export function applyAccountEnv(env: Record<string, string>): Record<string, string> {
  if (!isOnFallbackAccount()) return env;
  const token = readFallbackToken();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

/** Test hook. */
export function resetAccountState(): void {
  primaryLimitedUntil = 0;
}

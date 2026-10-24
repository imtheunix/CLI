import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where `tjob` finds the token; readable by this user only. */
const TOKEN_FILE = path.join(os.homedir(), '.cloudcli', 'orchestrator.token');

let cached: string | null = null;

/**
 * Used by the Orchestrator routes. The token local tools (`tjob`, run by the
 * orchestrating session and by each job's agent) authenticate with. Made once
 * and kept in a 0600 file; never sent anywhere else.
 */
export function getOrchestratorToken(): string {
  if (cached) return cached;
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing.length >= 32) {
      cached = existing;
      return existing;
    }
  } catch { /* first start */ }
  const token = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  cached = token;
  return token;
}

/** Used by the Orchestrator routes: whether a presented token is the local one, in constant time. */
export function isOrchestratorToken(candidate: string): boolean {
  const expected = Buffer.from(getOrchestratorToken());
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

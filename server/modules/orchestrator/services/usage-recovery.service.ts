// Usage-limit recovery reimplemented after T3 Code's UsageLimitRecoveryWorker (MIT, github.com/pingdotgg/t3code).
import type { OrchestratorBackend } from '@/modules/database/index.js';

import { detectGlmQuotaReset } from './glm-quota.service.js';

export type TurnFailureClass = 'usage_limit' | 'auth_required' | 'other';

/** Jobs service: what a failed turn tells about its provider, and when the provider said it resets. */
export type TurnFailure = { failureClass: TurnFailureClass; resetAt: Date | null; reason: string };

/**
 * Jobs service: one armed recovery, stored as JSON on the job so a restart finds it.
 * `key` is (job, turn, resetAt) for a stated reset, (job, turn, backoff attempt) without one,
 * (job, turn, auth) for a login wait: arming the same key twice is a no-op.
 */
export type LimitRecovery = {
  key: string;
  kind: 'usage_limit' | 'auth_required';
  /** As the provider stated it; null when it gave no reset (backoff) or for a login wait. */
  resetAt: string | null;
  /** When to act: resume (usage limit) or probe the provider's login (auth). */
  dueAt: string;
  /** Backoff attempts without a stated reset, or auth resumes; caps the loop at MAX_ATTEMPTS. */
  attempt: number;
  /** First failure of this streak; a successful turn ends the streak. */
  since: string;
  /** The continue turn was sent; the recovery waits for that turn's outcome. */
  delivered: boolean;
  /** Recovery refused or ran out; the job waits for the hub. */
  gaveUp: boolean;
  reason: string;
};

const BACKOFF_MINUTES = [15, 30, 60];
const MAX_ATTEMPTS = 3;
const AUTH_PROBE_MS = 10 * 60_000;
const GIVE_UP_MS = 24 * 3_600_000;
const MAX_JITTER_MS = 90_000;

/** Jobs service: the turn a due usage-limit recovery sends to the same session. */
export const LIMIT_CONTINUE_PROMPT = 'Continue where you left off.';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function to24h(hour: number, ampm: string): number {
  const pm = ampm.toLowerCase() === 'pm';
  return (hour % 12) + (pm ? 12 : 0);
}

/** The UTC offset (ms) of `timeZone` at `at`. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Wall-clock fields in `timeZone` (undefined: this machine's zone) to an instant. */
function zonedToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  if (!timeZone) return new Date(year, month, day, hour, minute).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

/** The next occurrence (after `now`) of a wall-clock time in `timeZone`. */
function nextClockTime(now: Date, hour: number, minute: number, timeZone?: string): Date | null {
  try {
    const fields = (at: number) => {
      if (!timeZone) {
        const d = new Date(at);
        return [d.getFullYear(), d.getMonth(), d.getDate()];
      }
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(new Date(at)).map((part) => [part.type, part.value]));
      return [Number(parts.year), Number(parts.month) - 1, Number(parts.day)];
    };
    for (const dayOffset of [0, 1]) {
      const [year, month, day] = fields(now.getTime() + dayOffset * 86_400_000);
      const instant = zonedToInstant(year, month, day, hour, minute, timeZone);
      if (instant > now.getTime()) return new Date(instant);
    }
  } catch {
    // An unknown time zone name: no reset time rather than a wrong one.
  }
  return null;
}

/** Claude Code: "You've hit your session limit · resets 7:30pm (America/Sao_Paulo)". */
function claudeReset(text: string, now: Date): Date | null {
  const match = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text);
  if (!match) return null;
  return nextClockTime(now, to24h(Number(match[1]), match[3]), Number(match[2] ?? 0), match[4]);
}

/** Codex: "try again at 10:47 AM." (next occurrence) or "try again at Nov 4th, 2026 8:22 AM.", in local time. */
function codexReset(text: string, now: Date): Date | null {
  const dated = /try again at ([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    if (month < 0) return null;
    return new Date(zonedToInstant(Number(dated[3]), month, Number(dated[2]), to24h(Number(dated[4]), dated[6]), Number(dated[5])));
  }
  const clock = /try again at (\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  return clock ? nextClockTime(now, to24h(Number(clock[1]), clock[3]), Number(clock[2])) : null;
}

const USAGE_LIMIT: Record<OrchestratorBackend, RegExp> = {
  claude: /hit your (?:session |weekly |usage |opus )?limit|usage limit reached|rate_limit_error/i,
  codex: /hit your usage limit|usage_limit_exceeded|usage_limit_reached/i,
  glm: /Usage limit reached for \d+\s+(?:hour|day|week|month)s?\b|Weekly\/Monthly Limit Exhausted/i,
  zcode: /Usage limit reached for \d+\s+(?:hour|day|week|month)s?\b|Weekly\/Monthly Limit Exhausted/i,
  agy: /RESOURCE_EXHAUSTED|quota exceeded|exhausted your (?:capacity|quota)/i,
};

const AUTH_REQUIRED: Record<OrchestratorBackend, RegExp> = {
  claude: /Login expired|Please run \/login|authentication_failed|OAuth token has expired|Invalid API key|Not logged in/i,
  codex: /not logged in|Please log ?in again|refresh token (?:was|has been|is) (?:already used|expired|revoked|invalid)|401 Unauthorized/i,
  glm: /\b401\b.*(?:Unauthorized|token)|invalid api key|authentication failed/i,
  zcode: /project_token_login_failed/i,
  agy: /not logged into Antigravity|auth timed out|UNAUTHENTICATED/i,
};

/**
 * Jobs service: classifies a failed turn's error text per backend. usage_limit carries the reset
 * time when the provider stated one; auth_required means a login is needed; anything else is other.
 */
export function classifyTurnFailure(backend: OrchestratorBackend, text: string, now: Date): TurnFailure {
  const firstLine = (pattern: RegExp) => text.split('\n').find((line) => pattern.test(line))?.trim().slice(0, 200) ?? '';
  if (USAGE_LIMIT[backend].test(text)) {
    let resetAt: Date | null = null;
    if (backend === 'claude') resetAt = claudeReset(text, now);
    else if (backend === 'codex') resetAt = codexReset(text, now);
    else if ((backend === 'glm' || backend === 'zcode') && /Your limit will reset at/i.test(text)) resetAt = detectGlmQuotaReset(text, now);
    return { failureClass: 'usage_limit', resetAt, reason: firstLine(USAGE_LIMIT[backend]) };
  }
  if (AUTH_REQUIRED[backend].test(text)) return { failureClass: 'auth_required', resetAt: null, reason: firstLine(AUTH_REQUIRED[backend]) };
  return { failureClass: 'other', resetAt: null, reason: '' };
}

/** Jobs service: reads a job's stored recovery (null when absent or unreadable). */
export function readLimitRecovery(json: string | null): LimitRecovery | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as LimitRecovery;
  } catch {
    return null;
  }
}

type ArmResult = {
  /** armed: new recovery; unchanged: this key was already armed; refused: reset already past; gave_up: out of attempts or time. */
  status: 'armed' | 'unchanged' | 'refused' | 'gave_up';
  recovery: LimitRecovery;
};

/**
 * Jobs service: arms a recovery for a usage_limit or auth_required failure, idempotent by its key.
 * A stated reset already in the past is refused (no retry loop); a streak longer than 24 h gives up;
 * without a reset the job backs off 15, 30, 60 min, then waits for the hub; a login wait probes every
 * 10 min and resumes at most three times.
 */
export function armLimitRecovery(input: {
  jobId: string;
  turnId: string;
  failure: TurnFailure & { failureClass: 'usage_limit' | 'auth_required' };
  previous: LimitRecovery | null;
  now: Date;
  random?: () => number;
}): ArmResult {
  const { jobId, turnId, failure, previous, now } = input;
  const random = input.random ?? Math.random;
  const nowMs = now.getTime();
  const sameStreak = previous && !previous.gaveUp && previous.kind === failure.failureClass ? previous : null;
  const since = sameStreak?.since ?? now.toISOString();
  const base = { kind: failure.failureClass, since, delivered: false, gaveUp: false, reason: failure.reason };

  let key: string;
  let dueMs: number;
  let attempt: number;
  if (failure.failureClass === 'auth_required') {
    key = `${jobId}:${turnId}:auth`;
    attempt = (sameStreak?.attempt ?? 0) + 1;
    dueMs = nowMs + AUTH_PROBE_MS;
  } else if (failure.resetAt) {
    key = `${jobId}:${turnId}:${failure.resetAt.toISOString()}`;
    attempt = 0;
    dueMs = failure.resetAt.getTime() + Math.floor(random() * MAX_JITTER_MS);
  } else {
    attempt = (sameStreak && sameStreak.resetAt === null ? sameStreak.attempt : 0) + 1;
    key = `${jobId}:${turnId}:backoff${attempt}`;
    dueMs = nowMs + (BACKOFF_MINUTES[attempt - 1] ?? 0) * 60_000;
  }
  if (previous?.key === key) return { status: 'unchanged', recovery: previous };

  const recovery: LimitRecovery = {
    ...base, key, attempt, resetAt: failure.resetAt?.toISOString() ?? null, dueAt: new Date(dueMs).toISOString(),
  };
  if (failure.resetAt && failure.resetAt.getTime() <= nowMs) return { status: 'refused', recovery: { ...recovery, gaveUp: true } };
  if (attempt > MAX_ATTEMPTS || dueMs - Date.parse(since) > GIVE_UP_MS) return { status: 'gave_up', recovery: { ...recovery, gaveUp: true } };
  return { status: 'armed', recovery };
}

/**
 * Jobs service tick: what a stored recovery asks for now. resume: send the continue turn; probe: check
 * the provider's login (then resume when it passes); expire: due more than 24 h ago (the server was
 * down), so the job waits for the hub instead.
 */
export function dueLimitAction(recovery: LimitRecovery | null, now: Date): 'none' | 'resume' | 'probe' | 'expire' {
  if (!recovery || recovery.delivered || recovery.gaveUp) return 'none';
  const dueMs = Date.parse(recovery.dueAt);
  if (!Number.isFinite(dueMs) || now.getTime() < dueMs) return 'none';
  if (recovery.kind === 'auth_required') return 'probe';
  return now.getTime() - dueMs > GIVE_UP_MS ? 'expire' : 'resume';
}

/** Jobs service: the next login probe after a failed one. */
export function nextAuthProbe(recovery: LimitRecovery, now: Date): LimitRecovery {
  return { ...recovery, dueAt: new Date(now.getTime() + AUTH_PROBE_MS).toISOString() };
}

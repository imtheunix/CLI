// Usage-limit recovery reimplemented after T3 Code's UsageLimitRecoveryWorker (MIT, github.com/pingdotgg/t3code).
import type { OrchestratorBackend } from '@/modules/database/index.js';

import { detectGlmQuotaReset } from './glm-quota.service.js';

export type TurnFailureClass = 'usage_limit' | 'auth_required' | 'other';

/** Jobs service: what a failed turn tells about its provider, and when the provider said it resets. */
export type TurnFailure = { failureClass: TurnFailureClass; resetAt: Date | null; reason: string };

/**
 * Jobs service: one armed recovery, stored as JSON on the job so a restart finds it.
 * `key` is (job, turn, resetAt) for a stated reset, (job, turn, backoff) without one, (job, turn, auth)
 * for a login wait: handling the same failed turn twice returns the armed recovery unchanged, so only a
 * new turn failing again advances the backoff.
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
  /** First failure of this chain; a turn that ends without a limit or login failure ends the chain. */
  firstFailedAt: string;
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

/**
 * A provider's own failure report for a turn: the message of its error event or error object, and its
 * structured error code when it has one (Claude's SDK `error`: rate_limit, authentication_failed...).
 * Never assistant prose or tool output: a test that prints "You've hit your usage limit" is not a limit.
 */
export type ProviderFailureSignal = { message: string; code?: string | null };

const CODE_CLASS: Partial<Record<OrchestratorBackend, Record<string, 'usage_limit' | 'auth_required'>>> = {
  claude: { rate_limit: 'usage_limit', authentication_failed: 'auth_required', oauth_org_not_allowed: 'auth_required' },
};

// Patterns are anchored to the start of the provider's error message, or to a field of its JSON error
// object, so a provider error that merely quotes such text further in does not match.
const MESSAGE_START = String.raw`(?:^|"message"\s*:\s*")`;
const GO_WRAPPED = String.raw`^(?:[A-Za-z][\w .-]*: )*`; // agy: "failed to ...: error getting token source: <cause>"
const ZAI_LIMIT = String.raw`${MESSAGE_START}(?:Usage limit reached for \d+\s+(?:hour|day|week|month)s?\b|Weekly\/Monthly Limit Exhausted)|"code"\s*:\s*"?13(?:08|10)\b`;

const USAGE_LIMIT: Record<OrchestratorBackend, RegExp> = {
  claude: new RegExp(String.raw`${MESSAGE_START}You(?:'|’| ha)ve hit your (?:session |weekly |usage |opus )?limit|"type"\s*:\s*"rate_limit_error"`, 'i'),
  codex: new RegExp(String.raw`${MESSAGE_START}You(?:'|’| ha)ve hit your usage limit|"(?:type|code)"\s*:\s*"usage_limit_(?:exceeded|reached)"`, 'i'),
  glm: new RegExp(ZAI_LIMIT, 'i'),
  zcode: new RegExp(ZAI_LIMIT, 'i'),
  agy: new RegExp(String.raw`${GO_WRAPPED}(?:RESOURCE_EXHAUSTED|You have exhausted your (?:capacity|quota))|"status"\s*:\s*"RESOURCE_EXHAUSTED"`, 'i'),
};

const AUTH_REQUIRED: Record<OrchestratorBackend, RegExp> = {
  claude: new RegExp(String.raw`${MESSAGE_START}(?:Login expired|Invalid API key|Not logged in|OAuth token has expired)|"type"\s*:\s*"authentication_error"`, 'i'),
  codex: new RegExp(String.raw`${MESSAGE_START}(?:You are not logged in|Not logged in|Your refresh token (?:was|has been|is) (?:already used|expired|revoked|invalid)|unexpected status 401 Unauthorized)`, 'i'),
  glm: new RegExp(String.raw`${MESSAGE_START}(?:Invalid API key|Authentication failed|401 Unauthorized)|"code"\s*:\s*"?1000\b`, 'i'),
  zcode: /^(?:\[project-access-token\] \{.*\bcode: '|)project_token_login_failed\b/i,
  agy: new RegExp(String.raw`${GO_WRAPPED}(?:You are not logged into Antigravity|auth timed out)|"status"\s*:\s*"UNAUTHENTICATED"`, 'i'),
};

/**
 * Jobs service: classifies a failed turn from its provider's failure signals (error events with their
 * codes; a bare string is one error message without a code). usage_limit carries the reset time when the
 * provider stated one; auth_required means a login is needed; anything else is other.
 */
export function classifyTurnFailure(backend: OrchestratorBackend, signals: ProviderFailureSignal[] | string, now: Date): TurnFailure {
  const list = typeof signals === 'string' ? [{ message: signals }] : signals;
  const classOf = (signal: ProviderFailureSignal): TurnFailureClass => {
    const byCode = signal.code ? CODE_CLASS[backend]?.[signal.code] : undefined;
    if (byCode) return byCode;
    const lines = signal.message.split('\n').map((line) => line.trim());
    if (lines.some((line) => USAGE_LIMIT[backend].test(line))) return 'usage_limit';
    if (lines.some((line) => AUTH_REQUIRED[backend].test(line))) return 'auth_required';
    return 'other';
  };
  const classified = list.map((signal) => ({ signal, failureClass: classOf(signal) }));
  const hit = classified.find((entry) => entry.failureClass === 'usage_limit') ?? classified.find((entry) => entry.failureClass === 'auth_required');
  if (!hit) return { failureClass: 'other', resetAt: null, reason: '' };
  const text = hit.signal.message;
  const reason = text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? '';
  if (hit.failureClass === 'auth_required') return { failureClass: 'auth_required', resetAt: null, reason };
  let resetAt: Date | null = null;
  if (backend === 'claude') resetAt = claudeReset(text, now);
  else if (backend === 'codex') resetAt = codexReset(text, now);
  else if ((backend === 'glm' || backend === 'zcode') && /Your limit will reset at/i.test(text)) resetAt = detectGlmQuotaReset(text, now);
  return { failureClass: 'usage_limit', resetAt, reason };
}

/** Jobs service: reads a job's stored recovery (null when absent or unreadable). */
export function readLimitRecovery(json: string | null): LimitRecovery | null {
  if (!json) return null;
  try {
    const recovery = JSON.parse(json) as LimitRecovery & { since?: string };
    // Recoveries stored before the field was renamed.
    if (!recovery.firstFailedAt && recovery.since) recovery.firstFailedAt = recovery.since;
    return recovery;
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
 * A stated reset already in the past is refused (no retry loop); a resume more than 24 h after the chain's first failure gives up;
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
  const turnKey = `${jobId}:${turnId}`;
  let key: string;
  if (failure.failureClass === 'auth_required') key = `${turnKey}:auth`;
  else if (failure.resetAt) key = `${turnKey}:${failure.resetAt.toISOString()}`;
  else key = `${turnKey}:backoff`;
  // The same failed turn handled again (a repeated completion, a restart): nothing advances.
  if (previous?.key === key) return { status: 'unchanged', recovery: previous };

  const sameChain = previous && !previous.gaveUp && previous.kind === failure.failureClass ? previous : null;
  const firstFailedAt = sameChain?.firstFailedAt ?? now.toISOString();
  let dueMs: number;
  let attempt: number;
  if (failure.failureClass === 'auth_required') {
    attempt = (sameChain?.attempt ?? 0) + 1;
    dueMs = nowMs + AUTH_PROBE_MS;
  } else if (failure.resetAt) {
    attempt = 0;
    dueMs = failure.resetAt.getTime() + Math.floor(random() * MAX_JITTER_MS);
  } else {
    attempt = (sameChain && sameChain.resetAt === null ? sameChain.attempt : 0) + 1;
    dueMs = nowMs + (BACKOFF_MINUTES[attempt - 1] ?? 0) * 60_000;
  }

  const recovery: LimitRecovery = {
    key, kind: failure.failureClass, resetAt: failure.resetAt?.toISOString() ?? null, dueAt: new Date(dueMs).toISOString(),
    attempt, firstFailedAt, delivered: false, gaveUp: false, reason: failure.reason,
  };
  if (failure.resetAt && failure.resetAt.getTime() <= nowMs) return { status: 'refused', recovery: { ...recovery, gaveUp: true } };
  if (attempt > MAX_ATTEMPTS || dueMs - Date.parse(firstFailedAt) > GIVE_UP_MS) return { status: 'gave_up', recovery: { ...recovery, gaveUp: true } };
  return { status: 'armed', recovery };
}

/**
 * Jobs service tick: what a stored recovery asks for now. resume: send the continue turn; probe: check
 * the provider's login (then resume when it passes); expire: more than 24 h since the chain's first
 * failure (a late restart, a long login wait), so the job waits for the hub instead.
 */
export function dueLimitAction(recovery: LimitRecovery | null, now: Date): 'none' | 'resume' | 'probe' | 'expire' {
  if (!recovery || recovery.delivered || recovery.gaveUp) return 'none';
  const dueMs = Date.parse(recovery.dueAt);
  if (!Number.isFinite(dueMs) || now.getTime() < dueMs) return 'none';
  const firstFailedMs = Date.parse(recovery.firstFailedAt);
  if (!Number.isFinite(firstFailedMs) || now.getTime() - firstFailedMs > GIVE_UP_MS) return 'expire';
  return recovery.kind === 'auth_required' ? 'probe' : 'resume';
}

/** Jobs service: the next login probe after a failed one. */
export function nextAuthProbe(recovery: LimitRecovery, now: Date): LimitRecovery {
  return { ...recovery, dueAt: new Date(now.getTime() + AUTH_PROBE_MS).toISOString() };
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { armLimitRecovery, classifyTurnFailure, dueLimitAction } from '../services/usage-recovery.service.js';
import type { LimitRecovery, TurnFailure } from '../services/usage-recovery.service.js';

// Fixtures are verbatim provider texts recorded on the workstation (2026-10/11): Codex rollouts
// (~/.codex/sessions), Claude transcripts (~/.claude/projects), Zcode runs (~/.cloudcli/zcode/*.jsonl)
// and agy logs (~/.gemini/antigravity-cli/log). The Codex apostrophe is U+2019.
const CODEX_CLOCK = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 10:47 AM.';
const CODEX_DATED = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 4th, 2026 8:22 AM.';
const CODEX_OVERLOADED = 'Selected model is at capacity. Please try a different model.';
const CLAUDE_SESSION = "You've hit your session limit · resets 7:30pm (America/Sao_Paulo)";
const CLAUDE_WEEKLY = "You've hit your weekly limit · resets 3am (America/Sao_Paulo)";
const CLAUDE_LOGIN = 'Login expired · Please run /login';
const ZCODE_LOGIN = "[project-access-token] { family: 'zai', stage: 'resolve', code: 'project_token_login_failed' }\n";
const ZCODE_LOGIN_TURN = 'project_token_login_failed';
const GLM_WEEKLY = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-07 12:28:03';
const AGY_LOGIN = 'failed to get load code assist response: error getting token source: You are not logged into Antigravity.';

test('codex: usage limit with a bare clock time resets at its next local occurrence', () => {
  const now = new Date(2026, 9, 23, 9, 50);
  const failure = classifyTurnFailure('codex', CODEX_CLOCK, now);
  assert.equal(failure.failureClass, 'usage_limit');
  assert.equal(failure.resetAt?.getTime(), new Date(2026, 9, 23, 10, 47).getTime());
  // After 10:47 the same text means tomorrow.
  assert.equal(classifyTurnFailure('codex', CODEX_CLOCK, new Date(2026, 9, 23, 11, 0)).resetAt?.getTime(), new Date(2026, 9, 24, 10, 47).getTime());
});

test('codex: usage limit with a date resets at that local time; capacity errors are other', () => {
  const failure = classifyTurnFailure('codex', CODEX_DATED, new Date(2026, 9, 31, 16, 16));
  assert.equal(failure.failureClass, 'usage_limit');
  assert.equal(failure.resetAt?.getTime(), new Date(2026, 10, 4, 8, 22).getTime());
  assert.match(failure.reason, /hit your usage limit/);
  assert.equal(classifyTurnFailure('codex', CODEX_OVERLOADED, new Date()).failureClass, 'other');
  assert.equal(classifyTurnFailure('codex', 'The last turn ended with exit code 1', new Date()).failureClass, 'other');
});

test('claude: session and weekly limits reset at the stated wall time in the stated zone', () => {
  // 2026-11-03T19:02:58Z is 16:02 in São Paulo (UTC-3): 7:30pm is 22:30Z the same day.
  const session = classifyTurnFailure('claude', CLAUDE_SESSION, new Date('2026-11-03T19:02:58Z'));
  assert.equal(session.failureClass, 'usage_limit');
  assert.equal(session.resetAt?.toISOString(), '2026-11-03T22:30:00.000Z');
  // 2026-11-03T00:34Z is 21:34 the day before in São Paulo: 3am is 06:00Z.
  const weekly = classifyTurnFailure('claude', CLAUDE_WEEKLY, new Date('2026-11-03T00:34:36Z'));
  assert.equal(weekly.resetAt?.toISOString(), '2026-11-03T06:00:00.000Z');
});

test('claude, zcode, agy: login failures are auth_required, never usage limits', () => {
  for (const [backend, text] of [['claude', CLAUDE_LOGIN], ['zcode', ZCODE_LOGIN], ['zcode', ZCODE_LOGIN_TURN], ['agy', AGY_LOGIN]] as const) {
    const failure = classifyTurnFailure(backend, text, new Date());
    assert.equal(failure.failureClass, 'auth_required', text);
    assert.equal(failure.resetAt, null);
  }
});

test('glm/zcode: Z.ai limits carry their UTC+8 reset', () => {
  const failure = classifyTurnFailure('zcode', GLM_WEEKLY, new Date('2026-11-03T10:37:05Z'));
  assert.equal(failure.failureClass, 'usage_limit');
  assert.equal(failure.resetAt?.toISOString(), new Date('2026-11-07T12:28:03+08:00').toISOString());
});

const usage = (resetAt: Date | null): TurnFailure & { failureClass: 'usage_limit' } => ({ failureClass: 'usage_limit', resetAt, reason: 'limit' });
const NOW = new Date('2026-11-07T12:00:00Z');

// Regression cases from the hub's refute (2026-11-07, keep/probe.ts).
test('only provider failure signals classify: a failing test that quotes the limit text is other', () => {
  const failingTest = 'FAIL test: expected "You have hit your usage limit" to equal "ok"';
  assert.equal(classifyTurnFailure('codex', failingTest, NOW).failureClass, 'other');
  for (const backend of ['claude', 'codex', 'glm', 'zcode', 'agy'] as const) {
    assert.equal(classifyTurnFailure(backend, [{ message: failingTest }, { message: `AssertionError: ${CLAUDE_SESSION}` }], NOW).failureClass, 'other', backend);
  }
  // Claude: the SDK's structured error code decides; its message only supplies the reset.
  const coded = classifyTurnFailure('claude', [{ message: 'Claude Code process exited with code 1' }, { message: CLAUDE_SESSION, code: 'rate_limit' }], new Date('2026-11-03T19:02:58Z'));
  assert.equal(coded.failureClass, 'usage_limit');
  assert.equal(coded.resetAt?.toISOString(), '2026-11-03T22:30:00.000Z');
  assert.equal(classifyTurnFailure('claude', [{ message: 'Your session needs attention', code: 'authentication_failed' }], NOW).failureClass, 'auth_required');
  assert.equal(classifyTurnFailure('claude', [{ message: 'Overloaded', code: 'overloaded' }], NOW).failureClass, 'other');
  // A provider's JSON error object counts by its message field.
  assert.equal(classifyTurnFailure('glm', '{"name":"APIError","data":{"message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-07 12:28:03"}}', NOW).failureClass, 'usage_limit');
});

test('handling the same failed turn twice without a reset neither advances the backoff nor moves dueAt', () => {
  const first = armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(null), previous: null, now: NOW });
  const repeat = armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(null), previous: first.recovery, now: new Date(NOW.getTime() + 5 * 60_000) });
  assert.equal(first.status, 'armed');
  assert.equal(repeat.status, 'unchanged');
  assert.deepEqual(repeat.recovery, first.recovery);
  assert.equal(repeat.recovery.attempt, 1);
  // Also after the continue turn was delivered, until a new turn fails.
  const delivered = { ...first.recovery, delivered: true };
  assert.equal(armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(null), previous: delivered, now: NOW }).status, 'unchanged');
  assert.equal(armLimitRecovery({ jobId: 'j', turnId: 't2', failure: usage(null), previous: delivered, now: NOW }).recovery.attempt, 2);
});

test('the 24 h give-up counts from the chain\'s first failure, at delivery as well as at arming', () => {
  const first = armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(null), previous: null, now: NOW });
  assert.equal(first.recovery.firstFailedAt, NOW.toISOString());
  assert.equal(dueLimitAction(first.recovery, new Date(NOW.getTime() + 24 * 3_600_000 + 60_000)), 'expire');
  assert.equal(dueLimitAction(first.recovery, new Date(NOW.getTime() + 20 * 60_000)), 'resume');
  // A later turn of the same chain keeps the first failure's time.
  const later = new Date(NOW.getTime() + 23.75 * 3_600_000);
  const second = armLimitRecovery({ jobId: 'j', turnId: 't2', failure: usage(null), previous: { ...first.recovery, delivered: true }, now: later });
  assert.equal(second.status, 'gave_up'); // its 30 min backoff would land past 24 h
  const withReset = armLimitRecovery({ jobId: 'j', turnId: 't2', failure: usage(new Date(later.getTime() + 10 * 60_000)), previous: { ...first.recovery, delivered: true }, now: later, random: () => 0 });
  assert.equal(withReset.recovery.firstFailedAt, NOW.toISOString());
  assert.equal(withReset.status, 'armed');
  assert.equal(dueLimitAction(withReset.recovery, new Date(NOW.getTime() + 24 * 3_600_000 + 1)), 'expire');
  // A login wait expires the same way.
  const auth = armLimitRecovery({ jobId: 'j', turnId: 't', failure: { failureClass: 'auth_required', resetAt: null, reason: 'login' }, previous: null, now: NOW }).recovery;
  assert.equal(dueLimitAction(auth, new Date(NOW.getTime() + 25 * 3_600_000)), 'expire');
});

test('arming is idempotent per (job, turn, resetAt)', () => {
  const resetAt = new Date('2026-11-07T14:05:00Z');
  const first = armLimitRecovery({ jobId: 'j', turnId: 't1', failure: usage(resetAt), previous: null, now: NOW, random: () => 0.5 });
  assert.equal(first.status, 'armed');
  assert.equal(first.recovery.key, 'j:t1:2026-11-07T14:05:00.000Z');
  assert.equal(first.recovery.dueAt, '2026-11-07T14:05:45.000Z'); // 45 s of jitter
  const again = armLimitRecovery({ jobId: 'j', turnId: 't1', failure: usage(resetAt), previous: first.recovery, now: new Date(NOW.getTime() + 60_000), random: () => 0.9 });
  assert.equal(again.status, 'unchanged');
  assert.deepEqual(again.recovery, first.recovery);
  // A new turn failing on the same window is a new recovery.
  assert.equal(armLimitRecovery({ jobId: 'j', turnId: 't2', failure: usage(resetAt), previous: first.recovery, now: NOW }).status, 'armed');
});

test('a stated reset already in the past is refused, so a stale limit never loops', () => {
  const result = armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(new Date(NOW.getTime() - 1)), previous: null, now: NOW });
  assert.equal(result.status, 'refused');
  assert.equal(result.recovery.gaveUp, true);
  assert.equal(dueLimitAction(result.recovery, new Date(NOW.getTime() + 3_600_000)), 'none');
});

test('a resume more than 24 h after the first failure gives up; a recovery 24 h overdue expires', () => {
  assert.equal(armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(new Date(NOW.getTime() + 25 * 3_600_000)), previous: null, now: NOW }).status, 'gave_up');
  const armed = armLimitRecovery({ jobId: 'j', turnId: 't', failure: usage(new Date(NOW.getTime() + 3_600_000)), previous: null, now: NOW, random: () => 0 }).recovery;
  assert.equal(dueLimitAction(armed, NOW), 'none');
  assert.equal(dueLimitAction(armed, new Date(NOW.getTime() + 3_600_000)), 'resume');
  assert.equal(dueLimitAction(armed, new Date(NOW.getTime() + 26 * 3_600_000)), 'expire');
  assert.equal(dueLimitAction({ ...armed, delivered: true }, new Date(NOW.getTime() + 3_600_000)), 'none');
});

test('without a reset time the job backs off 15, 30, 60 min, then waits for the hub', () => {
  let previous: LimitRecovery | null = null;
  let at = NOW.getTime();
  for (const [turn, minutes] of [[1, 15], [2, 30], [3, 60]] as const) {
    const result = armLimitRecovery({ jobId: 'j', turnId: `t${turn}`, failure: usage(null), previous, now: new Date(at) });
    assert.equal(result.status, 'armed');
    assert.equal(Date.parse(result.recovery.dueAt) - at, minutes * 60_000);
    previous = { ...result.recovery, delivered: true };
    at = Date.parse(result.recovery.dueAt) + 60_000;
  }
  const fourth = armLimitRecovery({ jobId: 'j', turnId: 't4', failure: usage(null), previous, now: new Date(at) });
  assert.equal(fourth.status, 'gave_up');
  assert.equal(fourth.recovery.firstFailedAt, NOW.toISOString());
});

test('a login wait probes every 10 min and gives up after three resumes', () => {
  const auth: TurnFailure & { failureClass: 'auth_required' } = { failureClass: 'auth_required', resetAt: null, reason: 'login' };
  const first = armLimitRecovery({ jobId: 'j', turnId: 't1', failure: auth, previous: null, now: NOW });
  assert.equal(first.status, 'armed');
  assert.equal(dueLimitAction(first.recovery, new Date(NOW.getTime() + 9 * 60_000)), 'none');
  assert.equal(dueLimitAction(first.recovery, new Date(NOW.getTime() + 10 * 60_000)), 'probe');
  let previous: LimitRecovery = first.recovery;
  for (const turn of [2, 3]) previous = armLimitRecovery({ jobId: 'j', turnId: `t${turn}`, failure: auth, previous: { ...previous, delivered: true }, now: NOW }).recovery;
  assert.equal(armLimitRecovery({ jobId: 'j', turnId: 't4', failure: auth, previous: { ...previous, delivered: true }, now: NOW }).status, 'gave_up');
});

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import {
  mapClaudeRateLimitEvent,
  rememberClaudeRateLimit,
  writeClaudePlanUsageSnapshot,
} from '@/modules/providers/services/claude-plan-usage.service.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The plan-usage snapshot writer folds the SDK's `rate_limit_event` messages
 * into the status line's snapshot file: the 5-hour and weekly windows of a
 * Claude plan, merged across events, written atomically with the file modes
 * the status line script uses, percent scale 0..100. The utilization the SDK
 * reports is a 0..1 fraction (the CLI's status line itself stores
 * Math.round(utilization * 100)), so that is the conversion pinned here.
 */

const RESETS_AT = 1_792_852_800;

function rateLimitEvent(rateLimitType: string | undefined, utilization: unknown, resetsAt?: number) {
  const rateLimitInfo: Record<string, unknown> = { status: 'allowed', rateLimitType, utilization };
  if (resetsAt !== undefined) {
    rateLimitInfo.resetsAt = resetsAt;
  }
  return { type: 'rate_limit_event', rate_limit_info: rateLimitInfo };
}

const SETTLE_MS = 25;

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
  }
  assert.ok(condition(), 'condition never became true');
}

test('maps a five_hour event to a percent-scale window update', () => {
  assert.deepEqual(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', 0.35, RESETS_AT)), {
    window: 'five_hour',
    usedPercentage: 35,
    resetsAt: 1_792_852_800,
  });
});

test('maps a seven_day event and rounds utilization like the status line', () => {
  assert.deepEqual(mapClaudeRateLimitEvent(rateLimitEvent('seven_day', 0.587, RESETS_AT)), {
    window: 'seven_day',
    usedPercentage: 59,
    resetsAt: 1_792_852_800,
  });
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('seven_day', 0.584, RESETS_AT))?.usedPercentage, 58);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('seven_day', 0, RESETS_AT))?.usedPercentage, 0);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('seven_day', 1, RESETS_AT))?.usedPercentage, 100);
});

test('clamps an over-limit utilization fraction to 100 percent', () => {
  // utilization above 1 occurs while a limit is exceeded; the stored
  // percentage never leaves 0..100.
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', 1.4, RESETS_AT))?.usedPercentage, 100);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', -0.5, RESETS_AT))?.usedPercentage, 0);
});

test('maps an event without resetsAt to a null reset time', () => {
  assert.deepEqual(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', 0.4)), {
    window: 'five_hour',
    usedPercentage: 40,
    resetsAt: null,
  });
});

test('ignores messages that report no usable window', () => {
  assert.equal(mapClaudeRateLimitEvent(null), null);
  assert.equal(mapClaudeRateLimitEvent({ type: 'assistant' }), null);
  assert.equal(mapClaudeRateLimitEvent({ type: 'rate_limit_event' }), null);
  assert.equal(mapClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: null }), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('seven_day_opus', 0.5)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('seven_day_sonnet', 0.5)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('overage', 0.5)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent(undefined, 0.5)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', undefined)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', '35')), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', Number.NaN)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', Number.POSITIVE_INFINITY)), null);
  assert.equal(mapClaudeRateLimitEvent(rateLimitEvent('five_hour', true)), null);
});

test('writes the snapshot in the status line format with mode 600 in a 0700 directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-write-'));
  const filePath = path.join(directory, 'nested', 'claude-statusline.json');

  try {
    await writeClaudePlanUsageSnapshot(
      { window: 'five_hour', usedPercentage: 35, resetsAt: 1_792_852_800 },
      { filePath },
    );

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(saved.rate_limits, {
      five_hour: { used_percentage: 35, resets_at: 1_792_852_800 },
    });
    assert.ok(new Date(saved.at).toISOString(), 'at is an ISO timestamp');

    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);

    // Atomic write: nothing temporary is left next to the snapshot.
    assert.deepEqual(await readdir(path.dirname(filePath)), ['claude-statusline.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('merges the other window already in the file and keeps only the two keys', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-merge-'));
  const filePath = path.join(directory, 'claude-statusline.json');

  try {
    await writeFile(filePath, JSON.stringify({
      at: '2026-10-23T20:46:00.000Z',
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1_792_800_000 },
        seven_day: { used_percentage: 58, resets_at: 1_793_253_600 },
        seven_day_opus: { used_percentage: 90, resets_at: 1_793_253_600 },
        overage: { used_percentage: 10, resets_at: 1_793_253_600 },
      },
      something_else: true,
    }));

    await writeClaudePlanUsageSnapshot(
      { window: 'five_hour', usedPercentage: 42, resetsAt: 1_792_852_800 },
      { filePath },
    );

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(saved.rate_limits, {
      five_hour: { used_percentage: 42, resets_at: 1_792_852_800 },
      seven_day: { used_percentage: 58, resets_at: 1_793_253_600 },
    });
    assert.ok(!('something_else' in saved));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reuses the stored reset time when the event states none', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-reset-'));
  const filePath = path.join(directory, 'claude-statusline.json');

  try {
    await writeClaudePlanUsageSnapshot(
      { window: 'seven_day', usedPercentage: 58, resetsAt: 1_793_253_600 },
      { filePath },
    );
    await writeClaudePlanUsageSnapshot(
      { window: 'seven_day', usedPercentage: 61, resetsAt: null },
      { filePath },
    );

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(saved.rate_limits, {
      seven_day: { used_percentage: 61, resets_at: 1_793_253_600 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('skips the write when no reset time is known for the window at all', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-no-reset-'));
  const filePath = path.join(directory, 'claude-statusline.json');

  try {
    await writeClaudePlanUsageSnapshot(
      { window: 'five_hour', usedPercentage: 40, resetsAt: null },
      { filePath },
    );

    await assert.rejects(() => readFile(filePath, 'utf8'), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovers from an unreadable snapshot and clamps stored out-of-range values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-corrupt-'));
  const filePath = path.join(directory, 'claude-statusline.json');

  try {
    await writeFile(filePath, '{not json');

    await writeClaudePlanUsageSnapshot(
      { window: 'five_hour', usedPercentage: 35, resetsAt: 1_792_852_800 },
      { filePath },
    );

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(saved.rate_limits, {
      five_hour: { used_percentage: 35, resets_at: 1_792_852_800 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('leaves a failed write behind only as a logged, non-breaking miss', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-fail-'));
  // A directory with no write permission plays the unwritable snapshot path.
  await chmod(directory, 0o500);
  process.env.PLAN_USAGE_CLAUDE_STATUSLINE = path.join(directory, 'claude-statusline.json');
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };

  try {
    rememberClaudeRateLimit(rateLimitEvent('five_hour', 0.35, RESETS_AT));
    // A second event arrives before the first write failed; both are folded
    // silently after the one log line.
    rememberClaudeRateLimit(rateLimitEvent('seven_day', 0.58, RESETS_AT));
    await waitFor(() => errors.length > 0);
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS * 2); });

    assert.equal(errors.length, 1, 'the failure is logged exactly once');
  } finally {
    console.error = originalError;
    delete process.env.PLAN_USAGE_CLAUDE_STATUSLINE;
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test('honors the PLAN_USAGE_CLAUDE_STATUSLINE path override', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-env-'));
  const filePath = path.join(directory, 'claude-statusline.json');
  process.env.PLAN_USAGE_CLAUDE_STATUSLINE = filePath;

  try {
    rememberClaudeRateLimit(rateLimitEvent('five_hour', 0.35, RESETS_AT));
    await waitFor(() => {
      try {
        readFileSync(filePath, 'utf8');
        return true;
      } catch {
        return false;
      }
    });

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(saved.rate_limits, {
      five_hour: { used_percentage: 35, resets_at: 1_792_852_800 },
    });
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    delete process.env.PLAN_USAGE_CLAUDE_STATUSLINE;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a run folds the rate_limit_event messages from its SDK stream', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-run-'));
  const filePath = path.join(directory, 'claude-statusline.json');
  process.env.PLAN_USAGE_CLAUDE_STATUSLINE = filePath;

  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  const emit = (message: Record<string, unknown> | null): void => {
    queue.push(message);
    wake?.();
  };
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => { for await (const _message of prompt) { /* drain stdin */ } })();
    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };

  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  const cwd = await mkdtemp(path.join(tmpdir(), 'claude-plan-usage-cwd-'));
  try {
    const done = queryClaudeSDK('hello', { sessionId: 'plan-usage-run', cwd }, writer as never, context);
    emit({ session_id: 'native-plan-usage', type: 'user', message: { role: 'user', content: 'hi' } });
    emit(rateLimitEvent('five_hour', 0.35, RESETS_AT));
    emit(rateLimitEvent('seven_day', 0.58, RESETS_AT));
    emit({ type: 'result', subtype: 'success', result: 'done', is_error: false, session_id: 'native-plan-usage' });

    let saved: { rate_limits?: Record<string, { used_percentage: number; resets_at: number }> } | null = null;
    await waitFor(() => {
      try {
        saved = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        saved = null;
      }
      return Boolean(saved?.rate_limits?.seven_day);
    });
    emit(null);
    await done;

    assert.deepEqual(saved!.rate_limits, {
      five_hour: { used_percentage: 35, resets_at: 1_792_852_800 },
      seven_day: { used_percentage: 58, resets_at: 1_792_852_800 },
    });
  } finally {
    delete process.env.PLAN_USAGE_CLAUDE_STATUSLINE;
    emit(null);
    await rm(cwd, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

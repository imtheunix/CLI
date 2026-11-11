import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import {
  MORPH_CHAT_COMPLETIONS_URL,
  offlineTransport,
  runProbe,
  type LiveUsageFetcher,
  type ProbeTransport,
  type ProbeTransportRequest,
  type ProbeTransportResponse,
} from '../src/probe.js';

function liveUsage(uncachedIn = 0, out = 0, model = 'morph-test'): LiveUsageFetcher {
  return async () => ({
    groups: {
      test: { models: [model], window: { uncached_in: uncachedIn, out } },
    },
  });
}

function scriptedTransport(
  responses: Array<ProbeTransportResponse | Error>,
): { transport: ProbeTransport; calls: ProbeTransportRequest[] } {
  const calls: ProbeTransportRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function ok(promptTokens: number, completionTokens: number, cachedTokens = 0): ProbeTransportResponse {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
    }),
  };
}

function rateLimited(retryAfter?: string): ProbeTransportResponse {
  return {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    body: '{}',
  };
}

async function drive<T>(promise: Promise<T>, clock: FakeClock, stepMs = 1_000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown;
  promise.then(
    (result) => {
      settled = true;
      value = result;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );
  while (!settled) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (settled) break;
    await clock.advance(stepMs);
  }
  if (failure) throw failure;
  return value as T;
}

test('dry run makes zero provider calls and never looks up live usage or the key', async () => {
  const clock = new FakeClock();
  let transportCalls = 0;
  let usageCalls = 0;
  const result = await runProbe({
    model: 'morph-test',
    clock,
    transport: async () => {
      transportCalls += 1;
      return ok(1, 1);
    },
    liveUsage: async () => {
      usageCalls += 1;
      return { groups: {} };
    },
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(transportCalls, 0);
  assert.equal(usageCalls, 0);
  assert.equal(result.conclusion.kind, 'dry_run');
  assert.equal(result.conclusion.tested, false);
  assert.equal(result.calls.length, 0);
});

test('the default transport refuses to reach the network', async () => {
  await assert.rejects(
    () =>
      offlineTransport({
        url: MORPH_CHAT_COMPLETIONS_URL,
        method: 'POST',
        headers: {},
        body: '{}',
        timeoutMs: 1,
      }),
    /disabled/,
  );
});

test('records the exact provider usage and uncached occupancy', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(1_234, 56, 34)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ input: 1_000, output: 100 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MORPH_CHAT_COMPLETIONS_URL);
  assert.equal(result.mode, 'live');
  assert.equal(result.calls[0].usage?.prompt_tokens, 1_234);
  assert.equal(result.calls[0].usage?.completion_tokens, 56);
  assert.equal(result.calls[0].uncachedIn, 1_200);
  assert.equal(result.calls[0].out, 56);
  assert.deepEqual(result.observed.probeWindow, { uncachedIn: 1_200, out: 56 });
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.tested, true);
});

test('combines live and probe occupancy and refuses admission when over the assumed cap', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(200, 50)]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ input: 100, output: 10 }],
      limits: { successesPerLevel: 2, maxTotalMs: 5_000, pollMs: 1_000 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(900, 100),
    }),
    clock,
  );

  assert.equal(calls.length, 1, 'the second call is refused, not piled onto live work');
  assert.equal(result.calls.length, 1);
  assert.equal(result.conclusion.kind, 'deadline');
  assert.equal(result.observed.liveWindow?.uncachedIn, 900);
  assert.deepEqual(result.observed.combined, { uncachedIn: 1_100, out: 150 });
});

test('requires three successes per level and progresses through every level', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [
      { input: 100, output: 10 },
      { input: 200, output: 20 },
    ],
    limits: { successesPerLevel: 3 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 6);
  assert.deepEqual(result.calls.map((call) => call.level), [0, 0, 0, 1, 1, 1]);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulInput, 200);
  assert.equal(result.conclusion.maxSuccessfulOutput, 20);
});

test('a second consecutive 429 stops and keeps prior below-threshold successes', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    ok(100, 10),
    ok(100, 10),
    ok(100, 10),
    rateLimited('1'),
    rateLimited('1'),
  ]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [
        { input: 100, output: 10 },
        { input: 200, output: 20 },
      ],
      limits: { successesPerLevel: 3, defaultRetryAfterMs: 1_000 },
      caps: { uncachedIn: 1_000_000, out: 1_000_000 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 5);
  assert.equal(result.conclusion.kind, 'repeatable_limit');
  assert.equal(result.conclusion.tested, true);
  assert.equal(result.conclusion.level, 1);
  assert.equal(result.conclusion.belowThresholdSuccesses, true);
  assert.equal(result.conclusion.maxSuccessfulInput, 100);
  assert.equal(result.conclusion.maxSuccessfulOutput, 10);
  assert.deepEqual(
    result.calls.map((call) => call.outcome),
    ['success', 'success', 'success', 'rate_limited', 'rate_limited'],
  );
});

test('a non-repeatable 429 below the cap is retained with both planned token classes', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    rateLimited('1'),
    ok(100, 10),
    ok(100, 10),
    ok(100, 10),
  ]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ input: 100, output: 10 }],
      limits: { successesPerLevel: 3 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 4);
  assert.equal(result.calls[0].status, 429);
  assert.deepEqual(result.calls[0].planned, { input: 100, output: 10 });
  assert.equal(result.calls[0].usage, null);
  assert.equal(result.calls[0].uncachedIn, null);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.belowLimit429, true);
  assert.match(result.conclusion.note, /not a ceiling claim/);
});

test('a successful response without usage halts without inventing numbers', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([{ status: 200, headers: {}, body: '{}' }]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ input: 100, output: 10 }],
    limits: { successesPerLevel: 3 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].outcome, 'missing_usage');
  assert.deepEqual(result.observed.probeWindow, { uncachedIn: 0, out: 0 });
  assert.equal(result.conclusion.kind, 'missing_usage');
  assert.equal(result.conclusion.tested, false);
});

test('an absent Retry-After uses the bounded default and a deadline stops the retry', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([rateLimited()]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ input: 100, output: 10 }],
      limits: {
        successesPerLevel: 3,
        maxTotalMs: 500,
        defaultRetryAfterMs: 1_000,
      },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 1);
  assert.equal(result.calls[0].retryAfterMs, null);
  assert.equal(result.conclusion.kind, 'deadline');
  assert.equal(result.conclusion.tested, false);
});

test('an absent Retry-After under the deadline continues after the default wait', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    rateLimited(),
    ok(100, 10),
    ok(100, 10),
    ok(100, 10),
  ]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ input: 100, output: 10 }],
      limits: { successesPerLevel: 3, defaultRetryAfterMs: 1_000 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 4);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.belowLimit429, true);
});

test('a capacity error stops without retrying and is not a ceiling claim', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([{ status: 503, headers: {}, body: 'busy' }]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ input: 100, output: 10 }],
    limits: { successesPerLevel: 3 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.calls[0].outcome, 'capacity_error');
  assert.equal(result.conclusion.kind, 'capacity_error');
  assert.equal(result.conclusion.tested, false);
});

test('an unavailable live-admission state stops before any provider request', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ input: 100, output: 10 }],
    transport,
    liveUsage: async () => {
      throw new Error('connection refused');
    },
  });

  assert.equal(calls.length, 0);
  assert.equal(result.calls.length, 0);
  assert.equal(result.conclusion.kind, 'live_usage_unavailable');
  assert.equal(result.conclusion.tested, false);
});

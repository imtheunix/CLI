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

function ok(
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): ProbeTransportResponse {
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

function calibration(): ProbeTransportResponse {
  return ok(1_000, 8);
}

test('dry run makes zero provider calls and never looks up live usage or the key', async () => {
  const clock = new FakeClock();
  let transportCalls = 0;
  let usageCalls = 0;
  const result = await runProbe({
    model: 'morph-test',
    clock,
    apiKeyFile: '/definitely/not/a/key',
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
  assert.equal(result.calibration, null);
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
  const { transport, calls } = scriptedTransport([calibration(), ok(1_234, 56, 34)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, MORPH_CHAT_COMPLETIONS_URL);
  assert.equal(result.mode, 'live');
  assert.equal(result.calls[1].usage?.prompt_tokens, 1_234);
  assert.equal(result.calls[1].usage?.completion_tokens, 56);
  assert.equal(result.calls[1].uncachedIn, 1_200);
  assert.equal(result.calls[1].out, 56);
  assert.deepEqual(result.observed.probeWindow, { uncachedIn: 2_200, out: 64 });
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.tested, true);
  assert.equal(result.conclusion.maxSuccessfulInput, 1_200);
  assert.equal(result.conclusion.maxSuccessfulOutput, 56);
});

test('combines live and probe occupancy and refuses admission when over the assumed cap', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration(), ok(100, 10)]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ mode: 'input', target: 100, companion: 10 }],
      limits: { successesPerLevel: 2, maxTotalMs: 5_000, pollMs: 1_000 },
      caps: { uncachedIn: 2_000, out: 200 },
      transport,
      liveUsage: liveUsage(900, 100),
    }),
    clock,
  );

  assert.equal(calls.length, 2, 'calibration plus one admitted call; the next is refused');
  assert.equal(result.calls.length, 2);
  assert.equal(result.conclusion.kind, 'deadline');
  assert.equal(result.observed.liveWindow?.uncachedIn, 900);
  assert.deepEqual(result.observed.combined, { uncachedIn: 2_000, out: 118 });
});

test('requires three measured successes per level and progresses through every level', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    calibration(),
    ok(100, 10),
    ok(100, 10),
    ok(100, 10),
    ok(200, 10),
    ok(200, 10),
    ok(200, 10),
  ]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [
      { mode: 'input', target: 100, companion: 10 },
      { mode: 'input', target: 200, companion: 10 },
    ],
    limits: { successesPerLevel: 3 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 7);
  assert.deepEqual(
    result.calls.map((call) => call.level),
    [-1, 0, 0, 0, 1, 1, 1],
  );
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulInput, 200);
  assert.equal(result.conclusion.maxSuccessfulOutput, 10);
});

test('a second consecutive 429 stops and keeps prior measured successes', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    calibration(),
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
        { mode: 'input', target: 100, companion: 10 },
        { mode: 'input', target: 200, companion: 10 },
      ],
      limits: { successesPerLevel: 3, defaultRetryAfterMs: 1_000 },
      caps: { uncachedIn: 1_000_000, out: 1_000_000 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 6);
  assert.equal(result.conclusion.kind, 'repeatable_limit');
  assert.equal(result.conclusion.tested, true);
  assert.equal(result.conclusion.level, 1);
  assert.equal(result.conclusion.belowThresholdSuccesses, true);
  assert.equal(result.conclusion.maxSuccessfulInput, 100);
  assert.equal(result.conclusion.maxSuccessfulOutput, 10);
  assert.deepEqual(
    result.calls.map((call) => call.outcome),
    ['success', 'success', 'success', 'success', 'rate_limited', 'rate_limited'],
  );
});

test('a non-repeatable 429 below the cap is retained and is not a ceiling claim', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    calibration(),
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
      levels: [{ mode: 'input', target: 100, companion: 10 }],
      limits: { successesPerLevel: 3 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 5);
  assert.equal(result.calls[1].status, 429);
  assert.deepEqual(result.calls[1].planned, { mode: 'input', target: 100, companion: 10 });
  assert.equal(result.calls[1].usage, null);
  assert.equal(result.calls[1].uncachedIn, null);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.belowLimit429, true);
  assert.match(result.conclusion.note, /not a ceiling claim/);
});

test('a successful response without usage halts without inventing numbers', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([
    calibration(),
    { status: 200, headers: {}, body: '{}' },
  ]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 3 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1].outcome, 'missing_usage');
  assert.deepEqual(result.observed.probeWindow, { uncachedIn: 1_000, out: 8 });
  assert.equal(result.conclusion.kind, 'missing_usage');
  assert.equal(result.conclusion.tested, false);
});

test('an absent Retry-After uses the bounded default and a deadline stops the retry', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration(), rateLimited()]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ mode: 'input', target: 100, companion: 10 }],
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

  assert.equal(calls.length, 2);
  assert.equal(result.calls[1].retryAfterMs, null);
  assert.equal(result.conclusion.kind, 'deadline');
  assert.equal(result.conclusion.tested, false);
});

test('an absent Retry-After under the deadline continues after the default wait', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    calibration(),
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
      levels: [{ mode: 'input', target: 100, companion: 10 }],
      limits: { successesPerLevel: 3, defaultRetryAfterMs: 1_000 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 5);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.belowLimit429, true);
});

test('a capacity error stops without retrying and is not a ceiling claim', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    calibration(),
    { status: 503, headers: {}, body: 'busy' },
  ]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 3 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.calls[1].outcome, 'capacity_error');
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
    levels: [{ mode: 'input', target: 100, companion: 10 }],
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

test('calibrates from real usage and generates wholly unique bodies', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    ok(500, 8),
    ok(100, 10),
    ok(100, 10),
  ]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 2 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 3);
  const bodies = calls.map((call) => call.body);
  assert.equal(new Set(bodies).size, 3, 'every request body is unique');
  assert.notEqual(bodies[1].slice(0, 50), bodies[2].slice(0, 50));
  assert.ok(result.calibration);
  assert.ok(Math.abs(result.calibration.charsPerToken - bodies[0].length / 500) < 0.01);
  assert.ok(result.calibration.charsPerToken > 6, 'calibration is measured, not the 4 chars/token guess');
  assert.ok(bodies[1].length > 500, 'the level body is sized from the measured ratio');
  assert.equal(result.conclusion.kind, 'completed');
});

test('output sweeps request deterministic long-form output and require actual completion tokens', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration(), ok(150, 100)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'output', target: 100, companion: 200 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  const body = JSON.parse(calls[1].body) as {
    max_tokens: number;
    messages: Array<{ content: string }>;
  };
  assert.equal(body.max_tokens, 132);
  assert.match(body.messages[0].content, /Write the integers/);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulOutput, 100);
  assert.equal(result.conclusion.maxSuccessfulInput, 150);
});

test('input sweeps keep a fixed actual output and require actual uncached input', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration(), ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  const body = JSON.parse(calls[1].body) as {
    max_tokens: number;
    messages: Array<{ content: string }>;
  };
  assert.equal(body.max_tokens, 42);
  assert.match(body.messages[0].content, /Write the integers/);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulInput, 100);
  assert.equal(result.conclusion.maxSuccessfulOutput, 10);
});

test('a cached response below the input target is inconclusive, never capacity', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([calibration(), ok(100, 10, 90)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1, attemptsPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.calls[1].outcome, 'inconclusive');
  assert.match(result.calls[1].inconclusiveReason ?? '', /actual uncached input 10 < target 100/);
  assert.equal(result.conclusion.kind, 'inconclusive');
  assert.equal(result.conclusion.tested, false);
  assert.equal(result.conclusion.maxSuccessfulInput, 0);
});

test('a short-finished output response is inconclusive, never capacity', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([calibration(), ok(50, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'output', target: 100, companion: 200 }],
    limits: { successesPerLevel: 1, attemptsPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.calls[1].outcome, 'inconclusive');
  assert.match(result.calls[1].inconclusiveReason ?? '', /actual output 10 < target 100/);
  assert.equal(result.conclusion.kind, 'inconclusive');
  assert.equal(result.conclusion.tested, false);
});

test('a below-threshold response is rejected rather than counted as a planned success', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([calibration(), ok(50, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1, attemptsPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.conclusion.kind, 'inconclusive');
  assert.equal(result.conclusion.maxSuccessfulInput, 0);
  assert.equal(result.conclusion.maxSuccessfulOutput, 0);
  assert.equal(result.calls[1].outcome, 'inconclusive');
});

test('reports actual observed maxima, not planned levels', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([
    calibration(),
    ok(100, 10),
    ok(200, 10),
  ]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [
      { mode: 'input', target: 100, companion: 10 },
      { mode: 'input', target: 200, companion: 10 },
    ],
    limits: { successesPerLevel: 1 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulInput, 200);
  assert.equal(result.conclusion.maxSuccessfulOutput, 10);
  assert.equal(result.conclusion.observedMaxInput, 200);
  assert.equal(result.conclusion.observedMaxOutput, 10);
});

test('keeps one request in flight at a time', async () => {
  const clock = new FakeClock();
  let active = 0;
  let maxActive = 0;
  const responses = [calibration(), ok(100, 10), ok(100, 10)];
  let index = 0;
  const transport: ProbeTransport = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    active -= 1;
    return response;
  };
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 2 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(maxActive, 1);
  assert.equal(result.conclusion.kind, 'completed');
});

test('stops at the call cap', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration(), ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1, maxCalls: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.conclusion.kind, 'call_cap');
  assert.equal(result.conclusion.tested, false);
});

test('stops at the input token cap before sending', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration(), ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1, maxInputTokens: 1_050 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.conclusion.kind, 'token_cap');
  assert.equal(result.conclusion.tested, false);
});

test('stops at the deadline before the first request', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([calibration()]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1, maxTotalMs: 0 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 0);
  assert.equal(result.conclusion.kind, 'deadline');
  assert.equal(result.conclusion.tested, false);
});

test('never includes the API key in the result', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([calibration(), ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'super-secret-key',
    levels: [{ mode: 'input', target: 100, companion: 10 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret-key'), false);
  assert.equal(serialized.includes('authorization'), false);
});

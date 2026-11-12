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

function contentOf(request: ProbeTransportRequest): string {
  const parsed = JSON.parse(request.body) as { messages: Array<{ content: string }> };
  return parsed.messages[0].content;
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
    apiKeyFile: '/definitely/not/read/in/dry-run',
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

test('records exact provider usage and derives uncached occupancy from it', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(1_234, 156, 34)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 2_000, output: 100 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MORPH_CHAT_COMPLETIONS_URL);
  assert.equal(result.mode, 'live');
  assert.equal(result.calls[0].usage?.prompt_tokens, 1_234);
  assert.equal(result.calls[0].usage?.completion_tokens, 156);
  assert.equal(result.calls[0].uncachedIn, 1_200);
  assert.equal(result.calls[0].out, 156);
  assert.deepEqual(result.observed.probeWindow, { uncachedIn: 1_200, out: 156 });
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.tested, true);
  assert.equal(result.conclusion.maxSuccessfulUncachedIn, 1_200);
  assert.equal(result.conclusion.maxSuccessfulOutput, 156);
});

test('unique bodies and calibration from measured usage replace guessed chars/token', async () => {
  const clock = new FakeClock();
  const calls: ProbeTransportRequest[] = [];
  const transport: ProbeTransport = async (request) => {
    calls.push(request);
    const content = contentOf(request);
    const promptTokens = Math.round(content.length / 3);
    return ok(promptTokens, 20);
  };
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'input', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 2 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.conclusion.kind, 'completed');
  const first = contentOf(calls[0]);
  const second = contentOf(calls[1]);
  assert.notEqual(first, second, 'each request body is wholly unique');
  assert.notEqual(first.slice(0, 100), second.slice(0, 100));
  assert.ok(!second.includes(first.slice(0, 100)), 'not a repeated body with a nonce prefix');
  assert.ok(
    second.length < first.length,
    'the second body is calibrated from the first actual usage, not the guessed ratio',
  );
  assert.equal(result.calls[0].outcome, 'success');
  assert.equal(result.calls[1].outcome, 'success');
  assert.ok((result.calls[0].uncachedIn ?? 0) >= 1_000);
});

test('a response below the actual-token threshold is inconclusive, never a capacity claim', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    ok(2_000, 10, 1_900),
    ok(1_500, 10),
  ]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'input', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 1 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    result.calls.map((call) => call.outcome),
    ['below_threshold', 'success'],
  );
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.tested, true);
});

test('a short completion on an output level is retried instead of counted as a limit', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(1_000, 50), ok(1_000, 600)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 2_000, output: 500 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    result.calls.map((call) => call.outcome),
    ['below_threshold', 'success'],
  );
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulOutput, 600);
});

test('observed maxima retain actual tokens even when a call misses its threshold', async () => {
  const clock = new FakeClock();
  const { transport } = scriptedTransport([ok(5_000, 5), ok(1_200, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'input', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 1 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.conclusion.maxObservedUncachedIn, 5_000);
  assert.equal(result.conclusion.maxObservedOutput, 20);
  assert.equal(result.conclusion.maxSuccessfulUncachedIn, 1_200);
  assert.equal(result.conclusion.maxSuccessfulOutput, 20);
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
      levels: [{ sweep: 'output', input: 300, output: 10 }],
      limits: { successesPerLevel: 2, maxTotalMs: 5_000, pollMs: 1_000 },
      caps: { uncachedIn: 1_300, out: 200 },
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

test('keeps one request in flight at a time', async () => {
  const clock = new FakeClock();
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: ProbeTransport = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return ok(100, 20);
  };
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 2_000, output: 10 }],
    limits: { successesPerLevel: 3 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(maxInFlight, 1);
});

test('requires the configured successes per level and progresses through every level', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(100, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [
      { sweep: 'output', input: 1_000, output: 10 },
      { sweep: 'output', input: 1_000, output: 20 },
    ],
    limits: { successesPerLevel: 3 },
    caps: { uncachedIn: 1_000_000, out: 1_000_000 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 6);
  assert.deepEqual(result.calls.map((call) => call.level), [0, 0, 0, 1, 1, 1]);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.maxSuccessfulUncachedIn, 100);
  assert.equal(result.conclusion.maxSuccessfulOutput, 20);
});

test('a second consecutive 429 stops and keeps prior actual-token successes', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    ok(100, 20),
    ok(100, 20),
    ok(100, 20),
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
        { sweep: 'output', input: 1_000, output: 10 },
        { sweep: 'output', input: 1_000, output: 20 },
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
  assert.equal(result.conclusion.maxSuccessfulUncachedIn, 100);
  assert.equal(result.conclusion.maxSuccessfulOutput, 20);
  assert.deepEqual(
    result.calls.map((call) => call.outcome),
    ['success', 'success', 'success', 'rate_limited', 'rate_limited'],
  );
});

test('a successful response resets the consecutive-429 chain', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    rateLimited('1'),
    ok(100, 20),
    rateLimited('1'),
    ok(100, 20),
  ]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ sweep: 'output', input: 1_000, output: 10 }],
      limits: { successesPerLevel: 2 },
      caps: { uncachedIn: 1_000_000, out: 1_000_000 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 4);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.belowLimit429, true);
});

test('a non-repeatable 429 below the cap is retained without inventing usage', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([
    rateLimited('1'),
    ok(100, 20),
  ]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ sweep: 'output', input: 1_000, output: 10 }],
      limits: { successesPerLevel: 1 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.calls[0].status, 429);
  assert.deepEqual(result.calls[0].planned, { sweep: 'output', input: 1_000, output: 10 });
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
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
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

test('a transport error stops without retrying and is reported honestly', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([new Error('socket reset')]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.calls[0].outcome, 'transport_error');
  assert.equal(result.conclusion.kind, 'transport_error');
  assert.equal(result.conclusion.tested, false);
});

test('a capacity error stops without retrying and is not a ceiling claim', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([{ status: 503, headers: {}, body: 'busy' }]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 3 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.calls[0].outcome, 'capacity_error');
  assert.equal(result.conclusion.kind, 'capacity_error');
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
      levels: [{ sweep: 'output', input: 1_000, output: 10 }],
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
    ok(100, 20),
  ]);
  const result = await drive(
    runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ sweep: 'output', input: 1_000, output: 10 }],
      limits: { successesPerLevel: 1, defaultRetryAfterMs: 1_000 },
      caps: { uncachedIn: 1_000, out: 200 },
      transport,
      liveUsage: liveUsage(),
    }),
    clock,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.belowLimit429, true);
});

test('stops at the call cap before starting another provider request', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(100, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 3, maxCalls: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.conclusion.kind, 'budget');
  assert.equal(result.conclusion.tested, false);
});

test('stops at the token cap using actual, not planned, token use', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(100, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 3, maxTokens: 50 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.conclusion.kind, 'budget');
  assert.equal(result.calls[0].outcome, 'success');
});

test('an exhausted attempt budget ends inconclusive with observed maxima', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(1_000, 5)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 2_000, output: 100 }],
    limits: { successesPerLevel: 1, maxAttemptsPerLevel: 2 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.conclusion.kind, 'inconclusive');
  assert.equal(result.conclusion.tested, false);
  assert.equal(result.conclusion.maxObservedOutput, 5);
  assert.equal(result.conclusion.maxSuccessfulOutput, 0);
});

test('an unavailable live-admission state stops before any provider request', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(100, 10)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
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

test('the result never contains the API key or authorization header', async () => {
  const clock = new FakeClock();
  const secret = 'sk-test-super-secret-value';
  const { transport, calls } = scriptedTransport([ok(100, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: secret,
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 1 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls[0].headers.authorization, `Bearer ${secret}`);
  const output = JSON.stringify(result);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('authorization'));
});

test('a malformed live-usage window refuses admission before any provider request', async () => {
  const malformedWindows: unknown[] = [
    undefined,
    null,
    { uncached_in: null, out: 0 },
    { uncached_in: '12', out: 0 },
    { uncached_in: 0, out: Number.NaN },
  ];
  for (const window of malformedWindows) {
    const clock = new FakeClock();
    const { transport, calls } = scriptedTransport([ok(100, 20)]);
    const result = await runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ sweep: 'output', input: 1_000, output: 10 }],
      transport,
      liveUsage: async () =>
        ({ groups: { test: { models: ['morph-test'], window } } }) as never,
    });

    assert.equal(calls.length, 0, `no transport for window ${JSON.stringify(window)}`);
    assert.equal(result.calls.length, 0);
    assert.equal(result.conclusion.kind, 'live_usage_unavailable');
    assert.equal(result.conclusion.tested, false);
  }
});

test('negative usage is malformed and stops as missing_usage without eroding the window', async () => {
  const responses = [ok(-1, 20), ok(100, -5), ok(100, 20, -3)];
  for (const response of responses) {
    const clock = new FakeClock();
    const { transport, calls } = scriptedTransport([response]);
    const result = await runProbe({
      model: 'morph-test',
      clock,
      live: true,
      apiKey: 'test-key',
      levels: [{ sweep: 'input', input: 1_000, output: 10 }],
      limits: { successesPerLevel: 1 },
      caps: { uncachedIn: 1_000_000, out: 1_000_000 },
      transport,
      liveUsage: liveUsage(),
    });

    assert.equal(calls.length, 1);
    assert.equal(result.calls[0].outcome, 'missing_usage');
    assert.equal(result.calls[0].uncachedIn, null);
    assert.equal(result.calls[0].out, null);
    assert.deepEqual(result.observed.probeWindow, { uncachedIn: 0, out: 0 });
    assert.equal(result.conclusion.kind, 'missing_usage');
    assert.equal(result.conclusion.tested, false);
  }
});

test('an exact-token final success completes instead of reporting budget', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(30, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 1, maxTokens: 50 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.calls[0].outcome, 'success');
  assert.equal(result.conclusion.kind, 'completed');
  assert.equal(result.conclusion.tested, true);
});

test('an exact-token success still stops as budget when another call is needed', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(30, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [
      { sweep: 'output', input: 1_000, output: 10 },
      { sweep: 'output', input: 1_000, output: 20 },
    ],
    limits: { successesPerLevel: 1, maxTokens: 50 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.conclusion.kind, 'budget');
  assert.equal(result.conclusion.tested, false);
});

test('an exact-token success on the final level still stops as budget when more successes are needed', async () => {
  const clock = new FakeClock();
  const { transport, calls } = scriptedTransport([ok(30, 20)]);
  const result = await runProbe({
    model: 'morph-test',
    clock,
    live: true,
    apiKey: 'test-key',
    levels: [{ sweep: 'output', input: 1_000, output: 10 }],
    limits: { successesPerLevel: 2, maxTokens: 50 },
    transport,
    liveUsage: liveUsage(),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.conclusion.kind, 'budget');
  assert.equal(result.conclusion.tested, false);
});

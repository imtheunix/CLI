import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import {
  DEFAULT_PROBE_CONFIG,
  PROBE_SCHEMA,
  buildSyntheticPrompt,
  runProbe,
  type LiveOccupancy,
  type ProbeConfig,
  type ProbeDeps,
} from '../src/ceiling-probe.js';

function config(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    ...DEFAULT_PROBE_CONFIG,
    enabled: true,
    model: 'morph-test',
    providerUrl: 'https://provider.test/v1/chat/completions',
    apiKeyFile: '/tmp/probe-key',
    pacerUsageUrl: 'http://127.0.0.1:8198/pacer/usage',
    pacerTimeoutMs: 100,
    requestTimeoutMs: 1_000,
    liveGuardFraction: 1,
    maxWaitMs: 1_000,
    pollMs: 1,
    successesBeforeEscalation: 3,
    maxConsecutive429: 2,
    inputSteps: [100],
    outputSteps: [10],
    inputPhaseOutputTokens: 16,
    outputPhaseInputTokens: 50,
    caps: {
      maxCalls: 100,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      deadlineMs: 1_000_000,
    },
    proposedCeiling: { uncachedIn: 1_000_000, out: 1_000_000 },
    ...overrides,
  };
}

function deps(
  clock: FakeClock,
  fetchFn: typeof fetch,
  live: LiveOccupancy = { uncachedIn: 0, out: 0 },
  key = 'test-key',
): ProbeDeps {
  return {
    clock,
    fetch: fetchFn,
    readApiKey: () => key,
    readLiveUsage: async () => live,
  };
}

function successFetch(clock: FakeClock): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: string }>;
      max_tokens: number;
    };
    const promptTokens = Math.ceil(body.messages[0].content.length / 4);
    await clock.advance(100);
    return new Response(
      JSON.stringify({
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: body.max_tokens,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

test('default config is disabled and makes no key, usage or provider call', async () => {
  const clock = new FakeClock();
  let touched = false;
  const report = await runProbe(DEFAULT_PROBE_CONFIG, {
    clock,
    fetch: (async () => {
      touched = true;
      throw new Error('fetch must not run');
    }) as typeof fetch,
    readApiKey: () => {
      touched = true;
      return 'secret';
    },
    readLiveUsage: async () => {
      touched = true;
      return { uncachedIn: 0, out: 0 };
    },
  });

  assert.equal(touched, false);
  assert.equal(report.stopReason, 'disabled');
  assert.deepEqual(report.calls, []);
  assert.equal(
    JSON.stringify(report),
    JSON.stringify({
      schema: PROBE_SCHEMA,
      enabled: false,
      model: DEFAULT_PROBE_CONFIG.model,
      startedAt: '1970-01-01T00:00:00.000Z',
      finishedAt: '1970-01-01T00:00:00.000Z',
      durationMs: 0,
      stopReason: 'disabled',
      stopDetail: null,
      caps: DEFAULT_PROBE_CONFIG.caps,
      proposedCeiling: { uncachedIn: 2_103_237, out: 76_559 },
      liveGuard: { uncachedIn: 1_051_618, out: 38_279 },
      calls: [],
      summary: {
        callCount: 0,
        successCount: 0,
        provider429Count: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalUncachedIn: 0,
        totalOut: 0,
        pacerWaitMsTotal: 0,
        providerLatencyMsTotal: 0,
        input: { maxSuccessTokens: 0, successes: 0 },
        output: { maxSuccessTokens: 0, successes: 0 },
        threshold: null,
      },
    }),
  );
});

test('escalates only after three successes at each input then output step', async () => {
  const clock = new FakeClock();
  const report = await runProbe(
    config({ inputSteps: [100, 200], outputSteps: [10, 20] }),
    deps(clock, successFetch(clock)),
  );

  assert.equal(report.stopReason, 'completed');
  assert.deepEqual(
    report.calls.map((call) => [call.phase, call.step, call.attempt]),
    [
      ['input', 100, 1],
      ['input', 100, 2],
      ['input', 100, 3],
      ['input', 200, 1],
      ['input', 200, 2],
      ['input', 200, 3],
      ['output', 10, 1],
      ['output', 10, 2],
      ['output', 10, 3],
      ['output', 20, 1],
      ['output', 20, 2],
      ['output', 20, 3],
    ],
  );
  assert.equal(report.summary.callCount, 12);
  assert.equal(report.summary.successCount, 12);
  assert.deepEqual(report.summary.input, { maxSuccessTokens: 200, successes: 6 });
  assert.deepEqual(report.summary.output, { maxSuccessTokens: 20, successes: 6 });
  assert.equal(report.summary.totalPromptTokens, 3 * 100 + 3 * 200 + 3 * 50 + 3 * 50);
  assert.equal(report.summary.totalCompletionTokens, 3 * 16 + 3 * 16 + 3 * 10 + 3 * 20);
});

test('records exact usage, live occupancy and combined rolling occupancy', async () => {
  const clock = new FakeClock();
  const fetchFn = (async () => {
    await clock.advance(100);
    return new Response(
      JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [10], successesBeforeEscalation: 1 }),
    deps(clock, fetchFn, { uncachedIn: 7, out: 3 }),
  );

  assert.equal(report.calls.length, 2);
  const first = report.calls[0];
  assert.deepEqual(first.usage, {
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 40,
    uncachedIn: 60,
  });
  assert.deepEqual(first.liveOccupancy, { uncachedIn: 7, out: 3 });
  assert.deepEqual(first.combinedOccupancy, { uncachedIn: 67, out: 23 });
  assert.equal(first.pacerWaitMs, 0);
  assert.equal(first.providerLatencyMs, 100);
  assert.equal(report.summary.totalUncachedIn, 120);
  assert.equal(report.summary.totalOut, 40);
});

test('fails closed when live occupancy is over the configured guard', async () => {
  const clock = new FakeClock();
  let fetched = false;
  const report = await runProbe(
    config({
      liveGuardFraction: 0.5,
      proposedCeiling: { uncachedIn: 100, out: 100 },
    }),
    deps(
      clock,
      (async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as typeof fetch,
      { uncachedIn: 51, out: 0 },
    ),
  );

  assert.equal(fetched, false);
  assert.equal(report.stopReason, 'live-load-guard');
  assert.equal(report.stopDetail, 'live occupancy over guard');
  assert.deepEqual(report.liveGuard, { uncachedIn: 50, out: 50 });
  assert.equal(report.calls.length, 0);
});

test('fails closed when pacer usage is unavailable', async () => {
  const clock = new FakeClock();
  const report = await runProbe(config(), {
    clock,
    fetch: (async () => {
      throw new Error('must not fetch');
    }) as typeof fetch,
    readApiKey: () => 'test-key',
    readLiveUsage: async () => {
      throw new Error('pacer down');
    },
  });

  assert.equal(report.stopReason, 'live-load-guard');
  assert.equal(report.stopDetail, 'pacer usage unavailable');
  assert.equal(report.calls.length, 0);
});

test('accounts probe reservations against live occupancy and stops at the proposed ceiling', async () => {
  const clock = new FakeClock();
  const report = await runProbe(
    config({
      inputSteps: [100],
      proposedCeiling: { uncachedIn: 100, out: 1_000 },
      maxWaitMs: 1,
    }),
    {
      clock,
      fetch: (async () => {
        throw new Error('must not fetch');
      }) as typeof fetch,
      readApiKey: () => 'test-key',
      readLiveUsage: async () => {
        await clock.advance(2);
        return { uncachedIn: 40, out: 0 };
      },
    },
  );

  assert.equal(report.stopReason, 'proposed-ceiling-reached');
  assert.equal(report.calls.length, 0);
});

test('stops on the second consecutive 429 and captures Retry-After', async () => {
  const clock = new FakeClock();
  const report = await runProbe(
    config({ inputSteps: [100], proposedCeiling: { uncachedIn: 1_000, out: 1_000 } }),
    deps(
      clock,
      (async () => {
        await clock.advance(50);
        return new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
      }) as typeof fetch,
    ),
  );

  assert.equal(report.stopReason, 'two-consecutive-429');
  assert.equal(report.calls.length, 2);
  assert.equal(report.summary.provider429Count, 2);
  assert.equal(report.calls[0].retryAfterMs, 7_000);
  assert.equal(report.calls[0].provider429, true);
  assert.equal(report.calls[0].classification, 'ceiling-not-explanatory');
  assert.deepEqual(report.summary.threshold, {
    phase: 'input',
    step: 100,
    evidence: 'two-consecutive-429',
    classification: 'ceiling-not-explanatory',
  });
});

test('stops when a successful response has no usage', async () => {
  const clock = new FakeClock();
  const report = await runProbe(
    config(),
    deps(
      clock,
      (async () => {
        await clock.advance(10);
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    ),
  );

  assert.equal(report.stopReason, 'missing-usage');
  assert.equal(report.calls.length, 1);
  assert.equal(report.calls[0].classification, 'missing-usage');
  assert.equal(report.calls[0].usage, null);
});

test('stops on transport uncertainty without retrying', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const report = await runProbe(
    config(),
    deps(
      clock,
      (async () => {
        calls += 1;
        await clock.advance(10);
        throw new Error('socket hang up');
      }) as typeof fetch,
    ),
  );

  assert.equal(calls, 1);
  assert.equal(report.stopReason, 'transport-uncertainty');
  assert.equal(report.calls.length, 1);
  assert.equal(report.calls[0].status, null);
  assert.equal(report.calls[0].classification, 'transport-uncertainty');
});

test('stops at the call cap', async () => {
  const clock = new FakeClock();
  const report = await runProbe(
    config({ caps: { ...config().caps, maxCalls: 1 } }),
    deps(clock, successFetch(clock)),
  );

  assert.equal(report.stopReason, 'call-cap');
  assert.equal(report.calls.length, 1);
});

test('sends the key only in the authorization header and never in the report', async () => {
  const clock = new FakeClock();
  const key = 'super-secret-probe-key';
  let authorization: string | null = null;
  const report = await runProbe(
    config({ successesBeforeEscalation: 1 }),
    deps(
      clock,
      (async (_url: string, init: RequestInit) => {
        authorization = new Headers(init.headers).get('authorization');
        await clock.advance(10);
        return new Response(
          JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }),
          { status: 200 },
        );
      }) as typeof fetch,
      { uncachedIn: 0, out: 0 },
      key,
    ),
  );

  assert.equal(authorization, `Bearer ${key}`);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(key), false);
  assert.equal(serialized.includes('authorization'), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('synthetic prompts are deterministic and contain no workspace data', () => {
  const first = buildSyntheticPrompt(100);
  const second = buildSyntheticPrompt(100);
  assert.equal(first, second);
  assert.equal(first.length, 400);
  assert.match(first, /^Synthetic probe payload with no workspace or customer data\./);
});

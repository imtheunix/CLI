import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import { estimateInput } from '../src/pacer.js';
import {
  DEFAULT_PROBE_CONFIG,
  buildInputPrompt,
  runProbe,
  type ProbeConfig,
  type ProbeDeps,
  type ProbeFetch,
  type ProbeHttpResponse,
} from '../src/probe.js';

function config(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    ...DEFAULT_PROBE_CONFIG,
    enabled: true,
    inputSteps: [100],
    outputSteps: [50],
    successesBeforeEscalation: 3,
    proposedCeiling: { input: 1_000, output: 1_000 },
    caps: {
      maxCalls: 100,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      deadlineMs: 1_000_000,
    },
    guard: {
      maxLiveUncachedIn: 1_000_000,
      maxLiveOut: 1_000_000,
      maxCombinedUncachedIn: 1_000_000,
      maxCombinedOut: 1_000_000,
    },
    ...overrides,
  };
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ProbeHttpResponse {
  return {
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(body),
  };
}

interface FetchHarness {
  fetch: ProbeFetch;
  calls: Array<{ url: string; init: Parameters<ProbeFetch>[1] }>;
}

function fakeFetch(
  handler: (url: string, init: Parameters<ProbeFetch>[1]) => Promise<ProbeHttpResponse> | ProbeHttpResponse,
): FetchHarness {
  const calls: FetchHarness['calls'] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function deps(
  clock: FakeClock,
  fetch: ProbeFetch,
  live: () => Promise<{ uncachedIn: number; out: number } | null> = async () => ({
    uncachedIn: 0,
    out: 0,
  }),
  apiKey = 'secret-key',
): Partial<ProbeDeps> {
  return {
    clock,
    fetch,
    readApiKey: () => apiKey,
    readLiveUsage: live,
  };
}

test('does not fetch until explicitly enabled', async () => {
  let touched = false;
  const report = await runProbe(config({ enabled: false }), {
    clock: new FakeClock(),
    fetch: async () => {
      touched = true;
      throw new Error('must not fetch');
    },
    readApiKey: () => {
      touched = true;
      return 'secret-key';
    },
    readLiveUsage: async () => {
      touched = true;
      return { uncachedIn: 0, out: 0 };
    },
  });

  assert.equal(report.status, 'disabled');
  assert.equal(report.stopReason, 'disabled');
  assert.equal(report.calls.length, 0);
  assert.equal(touched, false);
});

test('escalates only after three successes per step', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => {
    await clock.advance(10);
    return response(200, { usage: { prompt_tokens: 100, completion_tokens: 10 } });
  });

  const report = await runProbe(
    config({ inputSteps: [100, 200], outputSteps: [50] }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.status, 'completed');
  assert.equal(report.stopReason, 'completed');
  assert.deepEqual(
    report.calls.map((call) => [call.phase, call.targetInputTokens, call.targetOutputTokens]),
    [
      ['input', 100, 16],
      ['input', 100, 16],
      ['input', 100, 16],
      ['input', 200, 16],
      ['input', 200, 16],
      ['input', 200, 16],
      ['output', 64, 50],
      ['output', 64, 50],
      ['output', 64, 50],
    ],
  );
  assert.equal(report.summary.input.successes, 6);
  assert.equal(report.summary.output.successes, 3);
});

test('combines probe rolling usage with live occupancy and fails closed over the guard', async () => {
  const clock = new FakeClock();
  let liveReads = 0;
  const harness = fakeFetch(async () => {
    await clock.advance(5);
    return response(200, { usage: { prompt_tokens: 500, completion_tokens: 10 } });
  });

  const report = await runProbe(
    config({
      inputSteps: [100],
      outputSteps: [],
      guard: {
        maxLiveUncachedIn: 1_000,
        maxLiveOut: 1_000,
        maxCombinedUncachedIn: 1_000,
        maxCombinedOut: 1_000,
      },
    }),
    deps(clock, harness.fetch, async () => {
      liveReads += 1;
      return liveReads === 1 ? { uncachedIn: 0, out: 0 } : { uncachedIn: 400, out: 0 };
    }),
  );

  assert.equal(report.status, 'stopped');
  assert.equal(report.stopReason, 'live_load_guard');
  assert.equal(report.calls.length, 1);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(report.calls[0].liveOccupancy, { uncachedIn: 0, out: 0 });
  assert.deepEqual(report.calls[0].probeOccupancy, { uncachedIn: 0, out: 0 });
  assert.deepEqual(report.calls[0].combinedOccupancy, {
    uncachedIn: report.calls[0].reservation.uncachedIn,
    out: 16,
  });
});

test('fails closed when live occupancy is unavailable', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => response(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } }));

  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [] }),
    deps(clock, harness.fetch, async () => null),
  );

  assert.equal(report.stopReason, 'live_usage_unavailable');
  assert.equal(report.calls.length, 0);
  assert.equal(harness.calls.length, 0);
});

test('stops on the second consecutive 429 and captures Retry-After', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => {
    await clock.advance(7);
    return response(429, { error: 'rate limited' }, { 'retry-after': '7' });
  });

  const report = await runProbe(
    config({ inputSteps: [100, 200, 300], outputSteps: [] }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.status, 'stopped');
  assert.equal(report.stopReason, 'two_consecutive_429');
  assert.equal(report.calls.length, 2);
  assert.equal(harness.calls.length, 2);
  assert.equal(report.calls[0].status, 429);
  assert.equal(report.calls[0].retryAfterMs, 7_000);
  assert.equal(report.calls[0].provider429, true);
  assert.equal(report.calls[0].ceilingNotExplanatory, true);
  assert.equal(report.calls[1].ceilingNotExplanatory, true);
  assert.equal(report.summary.input.ceilingExplanatory, false);
  assert.equal(report.summary.provider429Count, 2);
});

test('stops when a successful response has no usage', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => response(200, { id: 'no-usage' }));

  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [] }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.stopReason, 'missing_usage');
  assert.equal(report.calls.length, 1);
  assert.equal(report.calls[0].usage, null);
  assert.equal(report.calls[0].outcome, 'missing_usage');
});

test('records exact input/output accounting and updates the probe window', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => {
    await clock.advance(3);
    return response(200, {
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        prompt_tokens_details: { cached_tokens: 23 },
      },
    });
  });

  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [], successesBeforeEscalation: 1 }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.calls[0].usage?.inputTokens, 123);
  assert.equal(report.calls[0].usage?.outputTokens, 45);
  assert.equal(report.calls[0].usage?.cachedTokens, 23);
  assert.equal(report.calls[0].usage?.uncachedInputTokens, 100);
  assert.equal(report.summary.totalInputTokens, 123);
  assert.equal(report.summary.totalOutputTokens, 45);
  assert.equal(report.summary.totalUncachedInputTokens, 100);
});

test('sends the key only in the Authorization header and never in the report', async () => {
  const clock = new FakeClock();
  const secret = 'sk-test-secret-123';
  const harness = fakeFetch(async () =>
    response(200, { usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  );

  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [], successesBeforeEscalation: 1 }),
    deps(clock, harness.fetch, async () => ({ uncachedIn: 0, out: 0 }), secret),
  );

  assert.equal(harness.calls[0].init.headers.authorization, `Bearer ${secret}`);
  assert.equal(harness.calls[0].init.body?.includes(secret), false);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('stops at the call cap', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () =>
    response(200, { usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  );

  const report = await runProbe(
    config({
      inputSteps: [100],
      outputSteps: [],
      caps: {
        maxCalls: 1,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        deadlineMs: 1_000_000,
      },
    }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.stopReason, 'call_cap');
  assert.equal(report.calls.length, 1);
});

test('stops at the deadline', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => {
    await clock.advance(2_000);
    return response(200, { usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });

  const report = await runProbe(
    config({
      inputSteps: [100],
      outputSteps: [],
      caps: {
        maxCalls: 100,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        deadlineMs: 1_000,
      },
    }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.stopReason, 'deadline');
  assert.equal(report.calls.length, 1);
});

test('produces a byte-deterministic report for a fixed scenario', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => {
    await clock.advance(10);
    return response(200, { usage: { prompt_tokens: 100, completion_tokens: 10 } });
  });

  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [], successesBeforeEscalation: 1 }),
    deps(clock, harness.fetch),
  );

  const promptBytes = Buffer.byteLength(
    JSON.stringify({
      model: DEFAULT_PROBE_CONFIG.model,
      messages: [{ role: 'user', content: buildInputPrompt(100) }],
      max_tokens: 16,
      temperature: 0,
      stream: false,
    }),
    'utf8',
  );
  const reservation = { uncachedIn: estimateInput(promptBytes), out: 16 };

  assert.equal(
    JSON.stringify(report),
    JSON.stringify({
      schema: 'morph-ceiling-probe/v1',
      model: DEFAULT_PROBE_CONFIG.model,
      group: DEFAULT_PROBE_CONFIG.group,
      startedAt: '1970-01-01T00:00:00.000Z',
      caps: config().caps,
      guard: config().guard,
      proposedCeiling: { input: 1_000, output: 1_000 },
      status: 'completed',
      stopReason: 'completed',
      endedAt: '1970-01-01T00:00:00.010Z',
      calls: [
        {
          index: 1,
          phase: 'input',
          step: 1,
          targetInputTokens: 100,
          targetOutputTokens: 16,
          maxTokens: 16,
          promptBytes,
          status: 200,
          retryAfterMs: null,
          provider429: false,
          ceilingNotExplanatory: false,
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cachedTokens: 0,
            uncachedInputTokens: 100,
          },
          liveOccupancy: { uncachedIn: 0, out: 0 },
          probeOccupancy: { uncachedIn: 0, out: 0 },
          reservation,
          combinedOccupancy: { uncachedIn: reservation.uncachedIn, out: 16 },
          pacerWaitMs: 0,
          providerWaitMs: 10,
          outcome: 'success',
          error: null,
        },
      ],
      summary: {
        totalCalls: 1,
        totalInputTokens: 100,
        totalOutputTokens: 10,
        totalUncachedInputTokens: 100,
        provider429Count: 0,
        input: {
          successes: 1,
          maxSuccessTarget: 100,
          maxSuccessActualInput: 100,
          maxSuccessActualOutput: 10,
          rateLimits: 0,
          ceilingExplanatory: null,
        },
        output: {
          successes: 0,
          maxSuccessTarget: null,
          maxSuccessActualInput: null,
          maxSuccessActualOutput: null,
          rateLimits: 0,
          ceilingExplanatory: null,
        },
        pacerWaitMsTotal: 0,
        providerWaitMsTotal: 10,
      },
    }),
  );
});

test('marks a threshold explanatory only with two 429s at or above the proposed ceiling', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () =>
    response(429, { error: 'rate limited' }, { 'retry-after': '1' }),
  );

  const report = await runProbe(
    config({
      inputSteps: [1_000, 2_000],
      outputSteps: [],
      proposedCeiling: { input: 1_000, output: 1_000 },
    }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.stopReason, 'two_consecutive_429');
  assert.equal(report.calls[0].ceilingNotExplanatory, false);
  assert.equal(report.calls[1].ceilingNotExplanatory, false);
  assert.equal(report.summary.input.ceilingExplanatory, true);
});

test('stops on transport uncertainty without retrying', async () => {
  const clock = new FakeClock();
  const harness = fakeFetch(async () => {
    throw new Error('socket hang up');
  });

  const report = await runProbe(
    config({ inputSteps: [100], outputSteps: [] }),
    deps(clock, harness.fetch),
  );

  assert.equal(report.stopReason, 'transport_uncertainty');
  assert.equal(report.calls.length, 1);
  assert.equal(harness.calls.length, 1);
  assert.equal(report.calls[0].outcome, 'transport_error');
});

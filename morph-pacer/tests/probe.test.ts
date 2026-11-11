import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import {
  runProbe,
  syntheticPrompt,
  type PacerUsageSnapshot,
  type ProbeHttpResponse,
  type ProbeLevel,
  type ProbeModel,
  type ProbeTransport,
} from '../src/probe.js';
import { runProbeCli } from '../src/probe-cli.js';

const MODEL: ProbeModel = { model: 'morph-test', group: 'test' };
const LEVELS: ProbeLevel[] = [
  { inputTokens: 1_000, outputTokens: 100 },
  { inputTokens: 2_000, outputTokens: 100 },
];

function snapshot(
  window = { uncached_in: 0, out: 0 },
  caps = { uncached_in: 1_000_000, out: 1_000_000 },
): PacerUsageSnapshot {
  return {
    now: new Date(0).toISOString(),
    groups: { test: { window, caps, headroom: 1 } },
  };
}

function ok(promptTokens: number, completionTokens: number): ProbeHttpResponse {
  return {
    status: 200,
    headers: {},
    latencyMs: 5,
    body: JSON.stringify({
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }),
  };
}

function rateLimited(retryAfter?: string): ProbeHttpResponse {
  return {
    status: 429,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
    latencyMs: 3,
    body: '{}',
  };
}

class FakeTransport implements ProbeTransport {
  readonly calls: Array<{ model: string; prompt: string; maxOutputTokens: number }> = [];
  private readonly responses: Array<ProbeHttpResponse | Error>;
  private readonly usage: PacerUsageSnapshot | (() => PacerUsageSnapshot);

  constructor(
    responses: Array<ProbeHttpResponse | Error>,
    usage: PacerUsageSnapshot | (() => PacerUsageSnapshot) = snapshot(),
  ) {
    this.responses = [...responses];
    this.usage = usage;
  }

  async getUsage(): Promise<PacerUsageSnapshot> {
    return typeof this.usage === 'function' ? this.usage() : this.usage;
  }

  async postChat(input: {
    model: string;
    prompt: string;
    maxOutputTokens: number;
  }): Promise<ProbeHttpResponse> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error('fake transport ran out of responses');
    if (next instanceof Error) throw next;
    return next;
  }
}

function options(
  transport: ProbeTransport,
  overrides: Partial<Parameters<typeof runProbe>[0]> = {},
): Parameters<typeof runProbe>[0] {
  return {
    models: [MODEL],
    levels: LEVELS,
    clock: new FakeClock(),
    transport,
    deadlineMs: 60_000,
    maxRequestInputTokens: 240_000,
    maxRequestOutputTokens: 32_000,
    ...overrides,
  };
}

test('synthetic prompt is deterministic and roughly four characters per planned token', () => {
  const prompt = syntheticPrompt(1_000);
  assert.equal(prompt, syntheticPrompt(1_000));
  assert.ok(prompt.length >= 4_000);
});

test('pre-dispatch combined-window math includes live and earlier probe traffic', async () => {
  const transport = new FakeTransport(
    [ok(50, 5), ok(50, 5)],
    snapshot({ uncached_in: 100, out: 10 }),
  );
  const report = await runProbe(
    options(transport, {
      levels: [{ inputTokens: 1_000, outputTokens: 100 }],
      successesPerLevel: 2,
    }),
  );

  assert.equal(report.totals.requests, 2);
  const [first, second] = report.models[0].levels[0].attempts;
  assert.deepEqual(first.combinedBefore, { uncachedIn: 1_100, out: 110 });
  assert.deepEqual(second.combinedBefore, { uncachedIn: 1_150, out: 115 });
  assert.deepEqual(second.probeWindow, { uncachedIn: 50, out: 5 });
  assert.equal(transport.calls.length, 2);
});

test('three successes at a level escalate to the next level', async () => {
  const transport = new FakeTransport([
    ok(1_000, 10),
    ok(1_000, 10),
    ok(1_000, 10),
    ok(2_000, 10),
    ok(2_000, 10),
    ok(2_000, 10),
  ]);
  const report = await runProbe(options(transport));

  const [first, second] = report.models[0].levels;
  assert.equal(first.successes, 3);
  assert.equal(first.escalated, true);
  assert.equal(second.successes, 3);
  assert.equal(report.stop?.reason, 'completed');
  assert.equal(report.models[0].ceiling.proven, false);
});

test('a second consecutive 429 halts the whole run', async () => {
  const transport = new FakeTransport([rateLimited(), rateLimited()]);
  const report = await runProbe(
    options(transport, {
      models: [MODEL, { model: 'morph-other', group: 'test' }],
    }),
  );

  assert.equal(report.stop?.reason, 'second-429');
  assert.equal(report.totals.rateLimits, 2);
});

test('a 200 without usage aborts immediately', async () => {
  const transport = new FakeTransport([
    { status: 200, headers: {}, latencyMs: 1, body: '{}' },
  ]);
  const report = await runProbe(options(transport));

  assert.equal(report.stop?.reason, 'missing-usage');
  assert.equal(report.models[0].levels[0].attempts[0].classification, 'missing-usage');
});

test('unreadable pacer usage aborts before dispatch', async () => {
  const transport = new FakeTransport([ok(1_000, 10)], {
    now: new Date(0).toISOString(),
    groups: {},
  });
  const report = await runProbe(options(transport));

  assert.equal(report.stop?.reason, 'missing-usage');
  assert.equal(transport.calls.length, 0);
});

test('Retry-After is recorded on a 429', async () => {
  const transport = new FakeTransport([rateLimited('21')]);
  const report = await runProbe(options(transport));

  assert.equal(report.models[0].levels[0].attempts[0].retryAfterMs, 21_000);
});

test('a planned load over the probe cap stops before dispatch', async () => {
  const transport = new FakeTransport([ok(1_000, 10)]);
  const report = await runProbe(
    options(transport, {
      levels: [{ inputTokens: 300_000, outputTokens: 100 }],
    }),
  );

  assert.equal(report.stop?.reason, 'request-cap');
  assert.equal(transport.calls.length, 0);
});

test('a live window already at the live cap stops before dispatch', async () => {
  const transport = new FakeTransport(
    [ok(1_000, 10)],
    snapshot({ uncached_in: 1_000_000, out: 0 }),
  );
  const report = await runProbe(options(transport));

  assert.equal(report.stop?.reason, 'live-load-guard');
  assert.equal(transport.calls.length, 0);
});

test('the deadline stops the run before the next dispatch', async () => {
  const transport = new FakeTransport([ok(1_000, 10)]);
  const report = await runProbe(options(transport, { deadlineMs: 0 }));

  assert.equal(report.stop?.reason, 'deadline');
  assert.equal(transport.calls.length, 0);
});

test('two low-token passes then a below-cap 429 keeps occupancy and is not a ceiling', async () => {
  const transport = new FakeTransport([
    ok(500, 50),
    ok(500, 50),
    rateLimited('7'),
  ]);
  const report = await runProbe(
    options(transport, {
      levels: [{ inputTokens: 1_000, outputTokens: 100 }],
      successesPerLevel: 3,
    }),
  );

  const level = report.models[0].levels[0];
  assert.equal(level.successes, 2);
  const last = level.attempts[2];
  assert.equal(last.classification, 'cap-not-explanatory');
  assert.equal(last.belowLiveCap, true);
  assert.deepEqual(last.probeWindow, { uncachedIn: 1_000, out: 100 });
  assert.equal(report.models[0].ceiling.proven, false);
  assert.match(report.models[0].ceiling.reason, /not a proven ceiling/);
});

test('a cap-explanatory 429 after three successes proves a threshold', async () => {
  const transport = new FakeTransport(
    [ok(500, 50), ok(500, 50), ok(500, 50), rateLimited('9')],
    snapshot({ uncached_in: 0, out: 0 }, { uncached_in: 1_000, out: 1_000 }),
  );
  const report = await runProbe(
    options(transport, {
      levels: LEVELS,
      successesPerLevel: 3,
    }),
  );

  assert.equal(transport.calls.length, 4);
  const ceiling = report.models[0].ceiling;
  assert.equal(ceiling.proven, true);
  assert.deepEqual(ceiling.lastSuccessLevel, LEVELS[0]);
  assert.deepEqual(ceiling.threshold, LEVELS[1]);
  assert.equal(ceiling.belowThresholdSuccess, true);
  assert.equal(ceiling.reproducibleThreshold, true);
});

test('a transport error stops the run', async () => {
  const transport = new FakeTransport([new Error('socket closed')]);
  const report = await runProbe(options(transport));

  assert.equal(report.stop?.reason, 'transport-error');
});

test('dry run prints a plan and never constructs a transport', async () => {
  let liveCalls = 0;
  let testCalls = 0;
  const output: string[] = [];
  const code = await runProbeCli([], {
    createLiveTransport: () => {
      liveCalls += 1;
      throw new Error('live transport must not be constructed');
    },
    createTestTransport: () => {
      testCalls += 1;
      throw new Error('test transport must not be constructed');
    },
    stdout: (text) => output.push(text),
  });

  assert.equal(code, 0);
  assert.equal(liveCalls, 0);
  assert.equal(testCalls, 0);
  assert.match(output.join('\n'), /dry run, no network/);
});

test('--test runs offline and never constructs the live transport', async () => {
  let liveCalls = 0;
  const output: string[] = [];
  const code = await runProbeCli(['--test'], {
    createLiveTransport: () => {
      liveCalls += 1;
      throw new Error('live transport must not be constructed');
    },
    stdout: (text) => output.push(text),
  });

  assert.equal(code, 0);
  assert.equal(liveCalls, 0);
  assert.match(output.join('\n'), /"live": false/);
});

test('--live is required to construct the real transport', async () => {
  let liveCalls = 0;
  const output: string[] = [];
  const alwaysOk: ProbeTransport = {
    async getUsage() {
      return {
        now: new Date(0).toISOString(),
        groups: {
          deepseek: {
            window: { uncached_in: 0, out: 0 },
            caps: { uncached_in: 1_000_000, out: 1_000_000 },
            headroom: 1,
          },
          kimik31: {
            window: { uncached_in: 0, out: 0 },
            caps: { uncached_in: 1_000_000, out: 1_000_000 },
            headroom: 1,
          },
        },
      };
    },
    async postChat() {
      return ok(0, 0);
    },
  };
  const code = await runProbeCli(['--live'], {
    createLiveTransport: () => {
      liveCalls += 1;
      return alwaysOk;
    },
    stdout: (text) => output.push(text),
  });

  assert.equal(code, 0);
  assert.equal(liveCalls, 1);
  assert.match(output.join('\n'), /"live": true/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import {
  DEFAULT_PROBE_BOUNDS,
  runProbe,
  type PacerUsageSnapshot,
  type ProbeBounds,
  type ProbeHttpResponse,
  type ProbeRequest,
  type ProbeTransport,
} from '../src/probe.js';
import { main } from '../src/probe-cli.js';

class AutoClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await this.advance(ms);
  }
}

class FakeTransport implements ProbeTransport {
  readonly posts: ProbeRequest[] = [];
  usageCalls = 0;

  constructor(
    private readonly responses: Array<ProbeHttpResponse | (() => ProbeHttpResponse)>,
    private readonly snapshot: PacerUsageSnapshot | (() => PacerUsageSnapshot),
  ) {}

  async postChatCompletion(request: ProbeRequest): Promise<ProbeHttpResponse> {
    this.posts.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('fake transport ran out of responses');
    return typeof response === 'function' ? response() : response;
  }

  async getPacerUsage(): Promise<PacerUsageSnapshot> {
    this.usageCalls += 1;
    return typeof this.snapshot === 'function' ? this.snapshot() : this.snapshot;
  }
}

function snapshot(
  options: {
    model?: string;
    caps?: { uncachedIn: number; out: number };
    window?: { uncached_in: number; out: number };
  } = {},
): PacerUsageSnapshot {
  const model = options.model ?? 'morph-test';
  return {
    now: new Date(0).toISOString(),
    groups: {
      test: {
        models: [model],
        window: options.window ?? { uncached_in: 0, out: 0 },
        caps: options.caps ?? { uncached_in: 10_000, out: 1_000 },
        headroom: 0.95,
        reservations: 0,
        queue: 0,
        rate_limits_last_hour: 0,
      },
    },
  };
}

function ok(promptTokens = 100, completionTokens = 10): ProbeHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    }),
  };
}

function rateLimit(retryAfter?: string): ProbeHttpResponse {
  return {
    status: 429,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
    body: JSON.stringify({ error: { message: 'synthetic rate limit' } }),
  };
}

function bounds(overrides: Partial<ProbeBounds> = {}): ProbeBounds {
  return {
    ...DEFAULT_PROBE_BOUNDS,
    deadlineMs: 60_000,
    maxCalls: 20,
    maxInputSteps: 10,
    maxOutputSteps: 10,
    inputBudget: 1_000_000,
    outputBudget: 100_000,
    ...overrides,
  };
}

test('computes the combined live+probe window before each sequential call', async () => {
  const transport = new FakeTransport(
    [ok(50, 5), ok(50, 5)],
    snapshot({ window: { uncached_in: 100, out: 10 } }),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds({ maxCalls: 2 }),
    clock: new AutoClock(),
    transport,
    initialInputTarget: 50,
    initialOutputTarget: 5,
  });

  assert.equal(transport.usageCalls, 2);
  assert.equal(transport.posts.length, 2);
  assert.deepEqual(report.records[0].windows, {
    live: { uncachedIn: 100, out: 10 },
    probe: { uncachedIn: 0, out: 0 },
    combined: { uncachedIn: 100, out: 10 },
  });
  assert.deepEqual(report.records[1].windows, {
    live: { uncachedIn: 100, out: 10 },
    probe: { uncachedIn: 50, out: 5 },
    combined: { uncachedIn: 150, out: 15 },
  });
  assert.equal(report.stop.reason, 'call-cap');
  assert.equal(report.judgment, 'inconclusive');
});

test('escalates after three successes using provider-observed token units', async () => {
  const transport = new FakeTransport(
    [ok(100, 10), ok(100, 10), ok(100, 10), ok(100, 10)],
    snapshot(),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds({ maxCalls: 4 }),
    clock: new AutoClock(),
    transport,
    initialInputTarget: 100,
    initialOutputTarget: 10,
  });

  assert.equal(report.inputSteps, 1);
  assert.equal(report.outputSteps, 1);
  assert.equal(transport.posts[3].maxTokens, 15);
  assert.ok(transport.posts[3].prompt.length > transport.posts[0].prompt.length);
  assert.equal(report.records[3].requested.inputTarget, 150);
  assert.equal(report.records[3].requested.outputTarget, 15);
});

test('halts on the second consecutive 429', async () => {
  const transport = new FakeTransport([rateLimit(), rateLimit()], snapshot());
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds(),
    clock: new AutoClock(),
    transport,
    initialInputTarget: 100,
    initialOutputTarget: 10,
  });

  assert.equal(report.calls, 2);
  assert.equal(report.stop.reason, 'second-429');
  assert.equal(report.stop.guard, false);
  assert.equal(report.judgment, 'cap-not-explanatory');
  assert.equal(report.records[0].judgment, 'cap-not-explanatory');
  assert.equal(report.records[1].judgment, 'cap-not-explanatory');
});

test('aborts immediately when a successful response has no usable usage', async () => {
  const transport = new FakeTransport(
    [{ status: 200, headers: {}, body: JSON.stringify({ id: 'no-usage' }) }],
    snapshot(),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds(),
    clock: new AutoClock(),
    transport,
  });

  assert.equal(report.calls, 1);
  assert.equal(report.stop.reason, 'missing-usage');
  assert.equal(report.stop.guard, true);
  assert.equal(report.judgment, 'inconclusive');
});

test('honors Retry-After within the deadline', async () => {
  const clock = new AutoClock();
  const transport = new FakeTransport([rateLimit('5'), ok(100, 10)], snapshot());
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds({ maxCalls: 2 }),
    clock,
    transport,
    initialInputTarget: 100,
    initialOutputTarget: 10,
  });

  assert.equal(transport.posts.length, 2);
  assert.equal(report.records[0].retryAfterMs, 5_000);
  assert.ok(clock.now() >= 5_000);
  assert.equal(report.stop.reason, 'call-cap');
});

test('stops when Retry-After would cross the deadline', async () => {
  const transport = new FakeTransport([rateLimit('5')], snapshot());
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds({ deadlineMs: 1_000 }),
    clock: new AutoClock(),
    transport,
  });

  assert.equal(transport.posts.length, 1);
  assert.equal(report.calls, 1);
  assert.equal(report.stop.reason, 'deadline');
  assert.equal(report.stop.guard, true);
  assert.equal(report.judgment, 'inconclusive');
});

test('refuses to start when live load is already at the admission guard', async () => {
  const transport = new FakeTransport(
    [ok()],
    snapshot({ caps: { uncachedIn: 10_000, out: 1_000 }, window: { uncached_in: 9_500, out: 0 } }),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds(),
    clock: new AutoClock(),
    transport,
  });

  assert.equal(transport.posts.length, 0);
  assert.equal(report.calls, 0);
  assert.equal(report.stop.reason, 'live-load');
  assert.equal(report.stop.guard, true);
  assert.equal(report.judgment, 'inconclusive');
});

test('stops at the deadline before dispatching', async () => {
  const transport = new FakeTransport([ok()], snapshot());
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds({ deadlineMs: 0 }),
    clock: new AutoClock(),
    transport,
  });

  assert.equal(transport.posts.length, 0);
  assert.equal(report.stop.reason, 'deadline');
  assert.equal(report.judgment, 'inconclusive');
});

test('a below-cap 429 preserves both windows and is not a ceiling', async () => {
  const transport = new FakeTransport(
    [ok(100, 10), ok(100, 10), rateLimit(), rateLimit()],
    snapshot({ caps: { uncachedIn: 10_000, out: 1_000 } }),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds(),
    clock: new AutoClock(),
    transport,
    initialInputTarget: 100,
    initialOutputTarget: 10,
  });

  assert.equal(report.calls, 4);
  assert.equal(report.records[2].judgment, 'cap-not-explanatory');
  assert.deepEqual(report.records[2].windows.probe, { uncachedIn: 200, out: 20 });
  assert.deepEqual(report.records[3].windows.probe, { uncachedIn: 200, out: 20 });
  assert.equal(report.judgment, 'cap-not-explanatory');
  assert.notEqual(report.judgment, 'ceiling');
});

test('classifies a repeatable at-cap threshold with lower-level successes as a ceiling', async () => {
  const transport = new FakeTransport(
    [ok(50, 5), ok(50, 5), ok(50, 5), rateLimit(), rateLimit()],
    snapshot({ caps: { uncachedIn: 100, out: 10 } }),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds(),
    clock: new AutoClock(),
    transport,
    initialInputTarget: 50,
    initialOutputTarget: 5,
  });

  assert.equal(report.calls, 5);
  assert.equal(report.records[3].judgment, 'at-or-above-cap');
  assert.equal(report.records[4].judgment, 'at-or-above-cap');
  assert.equal(report.stop.reason, 'second-429');
  assert.equal(report.judgment, 'ceiling');
});

test('enforces call, step and budget caps', async () => {
  const callCapped = await runProbe({
    model: 'morph-test',
    bounds: bounds({ maxCalls: 1 }),
    clock: new AutoClock(),
    transport: new FakeTransport([ok()], snapshot()),
  });
  assert.equal(callCapped.calls, 1);
  assert.equal(callCapped.stop.reason, 'call-cap');

  const stepCapped = await runProbe({
    model: 'morph-test',
    bounds: bounds({ maxInputSteps: 0 }),
    clock: new AutoClock(),
    transport: new FakeTransport([ok()], snapshot()),
  });
  assert.equal(stepCapped.calls, 0);
  assert.equal(stepCapped.stop.reason, 'input-step-cap');

  const budgetCapped = await runProbe({
    model: 'morph-test',
    bounds: bounds({ inputBudget: 0 }),
    clock: new AutoClock(),
    transport: new FakeTransport([ok()], snapshot()),
  });
  assert.equal(budgetCapped.calls, 0);
  assert.equal(budgetCapped.stop.reason, 'input-budget');
});

test('the report never contains the key, prompt or provider body', async () => {
  const transport = new FakeTransport(
    [
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          marker: 'SECRET_BODY_MARKER',
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      },
    ],
    snapshot(),
  );
  const report = await runProbe({
    model: 'morph-test',
    bounds: bounds({ maxCalls: 1 }),
    clock: new AutoClock(),
    transport,
    promptFactory: () => 'PROMPT_MARKER',
  });
  const serialized = JSON.stringify(report);

  assert.ok(!serialized.includes('SECRET_BODY_MARKER'));
  assert.ok(!serialized.includes('PROMPT_MARKER'));
  assert.ok(!serialized.includes('authorization'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('"body"'));
  assert.ok(!serialized.includes('"prompt"'));
});

test('the CLI never creates a real transport without --live', async () => {
  let created = 0;
  const deps = {
    createTransport: () => {
      created += 1;
      return new FakeTransport([ok()], snapshot());
    },
    readApiKey: () => 'SECRET_KEY',
    stdout: () => undefined,
    stderr: () => undefined,
  };

  assert.equal(await main([], deps), 0);
  assert.equal(await main(['--dry-run'], deps), 0);
  assert.equal(await main(['--test'], deps), 0);
  assert.equal(created, 0);

  assert.equal(await main(['--live', '--model', 'morph-test'], deps), 2);
  assert.equal(created, 0);
});

test('the live CLI path requires explicit budgets and redacts the key', async () => {
  let created = 0;
  let output = '';
  const deps = {
    createTransport: () => {
      created += 1;
      return new FakeTransport([ok()], snapshot());
    },
    readApiKey: () => 'SECRET_KEY',
    stdout: (text: string) => {
      output += text;
    },
    stderr: () => undefined,
  };

  const code = await main(
    [
      '--live',
      '--model',
      'morph-test',
      '--input-budget',
      '1000',
      '--output-budget',
      '100',
      '--max-calls',
      '1',
    ],
    deps,
  );

  assert.equal(code, 0);
  assert.equal(created, 1);
  assert.ok(!output.includes('SECRET_KEY'));
  const report = JSON.parse(output) as { calls: number; judgment: string };
  assert.equal(report.calls, 1);
  assert.equal(report.judgment, 'inconclusive');
});

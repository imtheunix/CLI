import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import { parseProbeArgs, runCli } from '../src/probe-cli.js';
import {
  runProbe,
  sanitizeResult,
  type LiveUsage,
  type ProbeModelConfig,
  type ProbeRequest,
  type ProbeResponse,
  type ProbeResult,
  type ProbeTransport,
} from '../src/probe.js';

const MODEL: ProbeModelConfig = {
  model: 'morph-test',
  group: 'test',
  inputBudget: 1_000_000,
  outputBudget: 1_000_000,
};

const CAPS = { uncachedIn: 1_000_000, out: 1_000_000 };

function success(promptTokens: number, completionTokens: number, cachedTokens = 0): ProbeResponse {
  return {
    status: 200,
    retryAfterMs: null,
    usage: { promptTokens, completionTokens, cachedTokens, reasoningTokens: 0 },
  };
}

function limited(retryAfterMs: number | null = 0): ProbeResponse {
  return { status: 429, retryAfterMs, usage: null };
}

class FakeTransport implements ProbeTransport {
  readonly calls: ProbeRequest[] = [];
  private liveIndex = 0;
  private readonly responses: Array<{ response: ProbeResponse; advanceMs?: number }>;

  constructor(
    private readonly clock: FakeClock,
    responses: Array<{ response: ProbeResponse; advanceMs?: number }>,
    private readonly live: LiveUsage[] = [{ uncachedIn: 0, out: 0 }],
  ) {
    this.responses = [...responses];
  }

  async getLiveUsage(): Promise<LiveUsage> {
    const value = this.live[Math.min(this.liveIndex, this.live.length - 1)] ?? { uncachedIn: 0, out: 0 };
    this.liveIndex += 1;
    return value;
  }

  async postChat(request: ProbeRequest): Promise<ProbeResponse> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error('fake transport ran out of responses');
    if (next.advanceMs) await this.clock.advance(next.advanceMs);
    return next.response;
  }
}

function run(
  clock: FakeClock,
  transport: ProbeTransport,
  overrides: Partial<Parameters<typeof runProbe>[0]> = {},
): Promise<ProbeResult> {
  return runProbe({
    model: MODEL,
    transport,
    clock,
    caps: CAPS,
    headroom: 1,
    ...overrides,
  });
}

test('three successful calls at one level escalate using provider-observed token units', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: success(100, 10) },
    { response: success(100, 10) },
    { response: success(100, 10) },
    { response: success(100, 10) },
  ]);

  const result = await run(clock, transport, {
    maxCalls: 4,
    startInputTokens: 100,
    startOutputTokens: 10,
  });

  assert.equal(result.calls, 4);
  assert.equal(result.haltReason, 'call-cap');
  assert.deepEqual(result.records[0].step, { input: 0, output: 0 });
  assert.deepEqual(result.records[3].step, { input: 1, output: 1 });
  assert.equal(result.records[3].target.inputTokens, 200, 'next input target is twice the observed prompt');
  assert.equal(result.records[3].target.outputTokens, 20, 'next output target is twice the observed completion');
});

test('a second consecutive 429 halts the probe', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: limited(0) },
    { response: limited(0) },
  ]);

  const result = await run(clock, transport, { maxCalls: 10 });

  assert.equal(result.calls, 2);
  assert.equal(result.haltReason, 'second-429');
  assert.equal(result.judgment, 'cap-not-explanatory');
  assert.equal(result.ceiling.proven, false);
});

test('missing usage aborts immediately and is never treated as a ceiling', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: { status: 200, retryAfterMs: null, usage: null } },
  ]);

  const result = await run(clock, transport);

  assert.equal(result.calls, 1);
  assert.equal(result.haltReason, 'missing-usage');
  assert.equal(result.judgment, 'inconclusive');
  assert.equal(result.ceiling.proven, false);
});

test('Retry-After beyond the deadline stops before another call', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: limited(5_000) },
    { response: success(100, 10) },
  ]);

  const result = await run(clock, transport, { deadlineMs: 1_000 });

  assert.equal(result.calls, 1);
  assert.equal(result.haltReason, 'deadline');
  assert.equal(result.judgment, 'inconclusive');
});

test('a live window at the cap trips the live-load guard before dispatch', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(
    clock,
    [{ response: success(100, 10) }],
    [{ uncachedIn: CAPS.uncachedIn, out: 0 }],
  );

  const result = await run(clock, transport);

  assert.equal(result.calls, 0);
  assert.equal(result.haltReason, 'live-load-guard');
  assert.equal(result.judgment, 'inconclusive');
});

test('the deadline guard stops a run whose call crosses the deadline', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: success(100, 10), advanceMs: 200 },
  ]);

  const result = await run(clock, transport, { deadlineMs: 100 });

  assert.equal(result.calls, 1);
  assert.equal(result.haltReason, 'deadline');
});

test('two low-token passes then a below-cap 429 preserve occupancy and are not a ceiling', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: success(100, 10) },
    { response: success(100, 10) },
    { response: limited(0) },
    { response: limited(0) },
  ]);

  const result = await run(clock, transport, { maxCalls: 10 });

  assert.equal(result.haltReason, 'second-429');
  assert.equal(result.judgment, 'cap-not-explanatory');
  assert.equal(result.ceiling.proven, false);
  assert.deepEqual(result.windows.probe, { uncachedIn: 200, out: 20 });
  assert.deepEqual(result.records[2].windows.probe, { uncachedIn: 200, out: 20 });
  assert.deepEqual(result.records[2].windows.combined, { uncachedIn: 200, out: 20 });
});

test('the combined live+probe window is recomputed between sequential calls', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(
    clock,
    [
      { response: success(100, 10) },
      { response: success(100, 10) },
      { response: success(100, 10) },
    ],
    [
      { uncachedIn: 0, out: 0 },
      { uncachedIn: 50, out: 0 },
      { uncachedIn: 100, out: 0 },
    ],
  );

  const result = await run(clock, transport, { maxCalls: 3 });

  assert.deepEqual(result.records[0].windows.combined, { uncachedIn: 0, out: 0 });
  assert.deepEqual(result.records[1].windows.combined, { uncachedIn: 150, out: 10 });
  assert.deepEqual(result.records[2].windows.combined, { uncachedIn: 300, out: 20 });
});

test('the call cap stops the probe and the result is inconclusive', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: success(100, 10) },
    { response: success(100, 10) },
    { response: success(100, 10) },
  ]);

  const result = await run(clock, transport, { maxCalls: 2 });

  assert.equal(result.calls, 2);
  assert.equal(result.haltReason, 'call-cap');
  assert.equal(result.judgment, 'inconclusive');
});

test('the input step cap stops the probe', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [
    { response: success(100, 10) },
    { response: success(100, 10) },
  ]);

  const result = await run(clock, transport, { maxInputSteps: 1, successesPerLevel: 1 });

  assert.equal(result.calls, 1);
  assert.equal(result.haltReason, 'step-cap');
});

test('sanitizeResult drops request payloads and credentials', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, [{ response: success(100, 10) }]);
  const result = await run(clock, transport, { maxCalls: 1 });

  const dirty = {
    ...result,
    prompt: 'SECRET-PROMPT',
    apiKey: 'SECRET-KEY',
    records: [{ ...result.records[0], body: 'SECRET-BODY', messages: ['SECRET-MESSAGE'] }],
  } as unknown as ProbeResult;
  const clean = sanitizeResult(dirty);
  const serialized = JSON.stringify(clean);

  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes('Synthetic Morph rate probe'), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('the CLI is offline by default and only --live selects the real transport', async () => {
  assert.equal(parseProbeArgs([]).live, false);
  assert.equal(parseProbeArgs(['--dry-run']).live, false);
  assert.equal(parseProbeArgs(['--test']).live, false);
  assert.equal(parseProbeArgs(['--live']).live, true);

  const dry = await runCli(['--dry-run'], { print: () => {} });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.result, undefined);

  const offline = await runCli(['--test'], { print: () => {} });
  assert.equal(offline.mode, 'test');
  assert.equal(offline.result?.calls, 5);
  assert.equal(offline.result?.judgment, 'cap-not-explanatory');
});

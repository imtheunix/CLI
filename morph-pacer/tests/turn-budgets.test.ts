import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TURN_BUDGETS, type TurnBudget } from '../src/config.js';
import { request, startFakeUpstream, startProxy } from './helpers.js';

const BUDGET: TurnBudget = { uncachedIn: 600, out: 8 };

function messagesBody(targetBytes: number): string {
  const base = { model: 'morph-kimik31', max_tokens: 8, messages: [] as unknown[] };
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, pad: '' }));
  assert.ok(targetBytes >= overhead, 'target must fit the base body');
  return JSON.stringify({ ...base, pad: 'x'.repeat(targetBytes - overhead) });
}

function ok(usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 4 }) {
  return (_request: unknown, _body: string, response: import('node:http').ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage }));
  };
}

test('Kimi defaults carry the agreed per-call budgets', () => {
  assert.deepEqual(DEFAULT_TURN_BUDGETS.kimik31, { uncachedIn: 5_000, out: 800 });
});

test('an estimated uncached input AT the budget is forwarded', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream(ok());
  const proxy = await startProxy({ upstream: upstream.url, turnBudgets: { kimik31: BUDGET } });
  try {
    const body = messagesBody(2_400);
    assert.equal(Math.ceil(Buffer.byteLength(body) / 4), BUDGET.uncachedIn);
    const response = await request(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 1);
    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].status, 200);
    assert.equal((ledger[0].budget as Record<string, unknown>).input_rejected, false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('an estimated uncached input ABOVE the budget is refused without reaching upstream', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream(ok());
  const proxy = await startProxy({ upstream: upstream.url, turnBudgets: { kimik31: BUDGET } });
  try {
    const body = messagesBody(2_404);
    assert.ok(Math.ceil(Buffer.byteLength(body) / 4) > BUDGET.uncachedIn);
    const response = await request(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 413);
    assert.match(response.body, /exceeds the Kimi turn budget 600/);
    assert.equal(upstream.requests.length, 0);
    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].status, 413);
    const budget = ledger[0].budget as Record<string, unknown>;
    assert.equal(budget.input_rejected, true);
    assert.equal(budget.over_in, true);
    assert.ok(Number(budget.estimated_uncached_in) > BUDGET.uncachedIn);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('output AT the budget is left alone and output ABOVE is capped', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream(ok());
  const proxy = await startProxy({ upstream: upstream.url, turnBudgets: { kimik31: BUDGET } });
  try {
    await request(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-kimik31', max_tokens: 8, messages: [] }),
    });
    assert.equal(JSON.parse(upstream.requests[0].body).max_tokens, 8);
    assert.equal((await proxy.readLedger())[0].budget && (await proxy.readLedger())[0].budget.output_capped, false);

    await request(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-kimik31', max_tokens: 9, messages: [] }),
    });
    assert.equal(JSON.parse(upstream.requests[1].body).max_tokens, 8);
    assert.equal((await proxy.readLedger())[1].budget.output_capped, true);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('ordinary DeepSeek calls are neither capped nor flagged', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream(ok({ prompt_tokens: 100_000, completion_tokens: 5_000 }));
  const proxy = await startProxy({ upstream: upstream.url, turnBudgets: { kimik31: BUDGET } });
  try {
    const response = await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-dsv41flash', max_tokens: 5_000, messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(upstream.requests[0].body).max_tokens, 5_000);
    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].budget, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('actual usage over either limit is recorded even when the request was admitted', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream(ok({ prompt_tokens: 1_000, completion_tokens: 9 }));
  const proxy = await startProxy({ upstream: upstream.url, turnBudgets: { kimik31: BUDGET } });
  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-kimik31', max_tokens: 8, messages: [] }),
    });
    const budget = (await proxy.readLedger())[0].budget as Record<string, unknown>;
    assert.equal(budget.over_out, true);
    assert.equal(budget.over_in, true);
    assert.equal(budget.input_rejected, false);
    assert.equal(budget.output_capped, false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

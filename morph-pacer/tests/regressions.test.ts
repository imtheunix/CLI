import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import { request, startFakeUpstream, startProxy, waitFor } from './helpers.js';

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('waitForAsync timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function post(proxyUrl: string, body: string): Promise<{ status: number; body: string }> {
  return request(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

test('reserves uncached input at admission so a parallel burst cannot exceed the cap', { timeout: 10_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 900, completion_tokens: 10 } }));
  });
  const proxy = await startProxy({
    admission: 'strict',
    upstream: upstream.url,
    headroom: 1,
    groups: {
      test: { models: ['morph-test'], caps: { uncachedIn: 1_000, out: 1_000_000 } },
    },
  });
  const body = JSON.stringify({
    model: 'morph-test',
    messages: [{ role: 'user', content: 'x'.repeat(3_600) }],
  });

  try {
    const pending = [1, 2, 3].map(() => post(proxy.url, body));

    await waitForAsync(async () => (await proxy.readLedger()).length === 1);
    await waitFor(() => proxy.clock.pending > 0);
    assert.equal(upstream.requests.length, 1, 'only one request forwarded at a time');

    await proxy.clock.advance(60_001);
    await waitForAsync(async () => (await proxy.readLedger()).length === 2);
    assert.equal(upstream.requests.length, 2);

    await proxy.clock.advance(60_001);
    const responses = await Promise.all(pending);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(upstream.requests.length, 3);

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.test.window.uncached_in, 900);
    assert.equal(snapshot.groups.test.reservations, 0);

    const ledger = await proxy.readLedger();
    assert.ok(Number(ledger[1].wait_ms) >= 60_000);
    assert.ok(Number(ledger[2].wait_ms) >= 60_000);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('does not leak a reservation when the request throws after admission', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  const proxy = await startProxy({
    upstream: upstream.url,
    headroom: 1,
    groups: {
      test: { models: ['morph-test'], caps: { uncachedIn: 100_000, out: 600 } },
    },
  });
  const body = JSON.stringify({ model: 'morph-test', messages: [] });

  try {
    (proxy.config as { upstream: string }).upstream = 'not a url';
    const first = await post(proxy.url, body);
    const second = await post(proxy.url, body);
    assert.equal(first.status, 500);
    assert.equal(second.status, 500);

    let snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.test.reservations, 0);
    assert.equal(snapshot.groups.test.window.out, 0);

    (proxy.config as { upstream: string }).upstream = upstream.url;
    const healed = await post(proxy.url, body);
    assert.equal(healed.status, 200);
    assert.equal(upstream.requests.length, 1);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].wait_ms, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('keeps the conservative reservation when a JSON response has no usage', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'no-usage-from-upstream' }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await post(
      proxy.url,
      JSON.stringify({ model: 'morph-kimik31', messages: [] }),
    );
    assert.equal(response.status, 200);

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.ok(snapshot.groups.kimik31.window.uncached_in > 0);
    assert.ok(snapshot.groups.kimik31.window.out > 0);
    assert.equal(snapshot.groups.kimik31.reservations, 0);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('keeps the conservative reservation when the client aborts mid-stream', { timeout: 5_000 }, async () => {
  let chunksSent = 0;
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    chunksSent += 1;
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const client = http.request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ model: 'morph-kimik31', stream: true, messages: [] }));

    await waitFor(() => chunksSent === 1);
    client.destroy();
    await waitForAsync(async () => (await proxy.readLedger()).length === 1);

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.ok(snapshot.groups.kimik31.window.uncached_in > 0);
    assert.ok(snapshot.groups.kimik31.window.out > 0);
    assert.equal(snapshot.groups.kimik31.reservations, 0);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].status, 499);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('keeps the conservative reservation when an SSE stream ends without usage', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"a whole generation"}}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await post(
      proxy.url,
      JSON.stringify({ model: 'morph-kimik31', stream: true, messages: [] }),
    );
    assert.equal(response.status, 200);

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.ok(snapshot.groups.kimik31.window.uncached_in > 0);
    assert.ok(snapshot.groups.kimik31.window.out > 0);
    assert.equal(snapshot.groups.kimik31.reservations, 0);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('model alias: rewritten to the real model with its body fields, paced under that model, logged with the alias', { timeout: 10_000 }, async () => {
  let seen: Record<string, unknown> | null = null;
  const upstream = await startFakeUpstream((_request, body, response) => {
    seen = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });
  try {
    const r = await post(proxy.url, JSON.stringify({ model: 'morph-kimik31-nothink', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(r.status, 200);
    assert.equal(seen!.model, 'morph-kimik31');
    assert.deepEqual(seen!.chat_template_kwargs, { thinking: false });
    await waitFor(() => existsSync(proxy.ledgerPath) && readFileSync(proxy.ledgerPath, 'utf8').includes('"alias"'));
    const line = JSON.parse(readFileSync(proxy.ledgerPath, 'utf8').trim().split('\n').pop()!);
    assert.equal(line.model, 'morph-kimik31');
    assert.equal(line.alias, 'morph-kimik31-nothink');
    const usage = await (await fetch(`${proxy.url}/pacer/usage`)).json() as { groups: Record<string, { window: { out: number } }> };
    assert.equal(usage.groups.kimik31.window.out, 2);
  } finally {
    await proxy.close(); await upstream.close();
  }
});

test('model alias: client-set fields win over the alias body', { timeout: 10_000 }, async () => {
  let seen: Record<string, unknown> | null = null;
  const upstream = await startFakeUpstream((_request, body, response) => {
    seen = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });
  try {
    await post(proxy.url, JSON.stringify({ model: 'morph-kimik31-nothink', chat_template_kwargs: { thinking: true }, messages: [] }));
    assert.deepEqual(seen!.chat_template_kwargs, { thinking: true });
  } finally {
    await proxy.close(); await upstream.close();
  }
});

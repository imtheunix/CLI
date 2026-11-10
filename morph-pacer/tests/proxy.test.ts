import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFakeUpstream, startProxy, waitFor } from './helpers.js';

test('passes JSON through, injects auth, captures usage and writes the ledger', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    );
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-key' },
      body: JSON.stringify({ model: 'morph-kimik31', messages: [] }),
    });

    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).id, 'chatcmpl-test');
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].headers.authorization, 'Bearer test-key');

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.kimik31.window.uncached_in, 80);
    assert.equal(snapshot.groups.kimik31.window.out, 50);
    assert.equal(snapshot.groups.kimik31.reservations, 0);
    assert.equal(snapshot.groups.kimik31.queue, 0);

    const ledger = await proxy.readLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].model, 'morph-kimik31');
    assert.equal(ledger[0].uncached_in, 80);
    assert.equal(ledger[0].cached_in, 20);
    assert.equal(ledger[0].out, 50);
    assert.equal(ledger[0].reasoning, 10);
    assert.equal(ledger[0].status, 200);
    assert.equal(ledger[0].stream, false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('injects cache_ttl and a session run_id for Kimi and records them in the ledger', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'session-abc',
      },
      body: JSON.stringify({ model: 'morph-kimik31', messages: [] }),
    });

    assert.equal(response.status, 200);
    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.cache_ttl, '1h');
    assert.equal(sent.run_id, 'session-abc');

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].cache_ttl, '1h');
    assert.equal(ledger[0].run_id_set, true);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('falls back to x-opencode-session-id for run_id', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opencode-session-id': 'opencode-session',
      },
      body: JSON.stringify({ model: 'kimi-latest', messages: [] }),
    });

    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.run_id, 'opencode-session');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('never overwrites cache_ttl or run_id the client set', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'session-abc',
      },
      body: JSON.stringify({
        model: 'morph-kimik31',
        cache_ttl: '5m',
        run_id: 'client-run',
        messages: [],
      }),
    });

    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.cache_ttl, '5m');
    assert.equal(sent.run_id, 'client-run');

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].cache_ttl, '5m');
    assert.equal(ledger[0].run_id_set, true);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('sets run_id only for listed models and only when a session header exists', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'session-abc',
      },
      body: JSON.stringify({ model: 'morph-dsv41flash', messages: [] }),
    });
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-kimik31', messages: [] }),
    });

    const deepseek = JSON.parse(upstream.requests[0].body);
    const kimi = JSON.parse(upstream.requests[1].body);
    assert.equal(deepseek.run_id, undefined);
    assert.equal(kimi.run_id, undefined);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].run_id_set, false);
    assert.equal(ledger[1].run_id_set, false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('does not inject cache_ttl when it is disabled with an empty string', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url, cacheTtl: '' });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-kimik31', messages: [] }),
    });

    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.cache_ttl, undefined);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].cache_ttl, null);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('leaves other endpoints untouched', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    await request(`${proxy.url}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'session-abc',
      },
      body: JSON.stringify({ model: 'morph-kimik31', input: 'hi' }),
    });

    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.cache_ttl, undefined);
    assert.equal(sent.run_id, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('passes SSE through, injects include_usage and captures streamed usage', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    response.write(
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
    );
    response.end('data: [DONE]\n\n');
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'stream-session' },
      body: JSON.stringify({ model: 'morph-kimik31', stream: true, messages: [] }),
    });

    assert.equal(response.status, 200);
    assert.match(response.body, /\[DONE\]/);
    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.stream_options.include_usage, true);
    assert.equal(sent.cache_ttl, '1h');
    assert.equal(sent.run_id, 'stream-session');

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.kimik31.window.uncached_in, 25);
    assert.equal(snapshot.groups.kimik31.window.out, 7);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].stream, true);
    assert.equal(ledger[0].uncached_in, 25);
    assert.equal(ledger[0].out, 7);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('waits for the output window to decay before forwarding', { timeout: 5_000 }, async () => {
  let calls = 0;
  const upstream = await startFakeUpstream((_request, _body, response) => {
    calls += 1;
    const out = calls === 1 ? 900 : 10;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: out } }));
  });
  const proxy = await startProxy({
    admission: 'strict',
    upstream: upstream.url,
    groups: {
      test: { models: ['morph-test'], caps: { uncachedIn: 100_000, out: 1_000 } },
    },
  });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-test', messages: [] }),
    });
    assert.equal(upstream.requests.length, 1);

    const pending = request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-test', messages: [] }),
    });
    await waitFor(() => proxy.clock.pending > 0);
    assert.equal(upstream.requests.length, 1);

    await proxy.clock.advance(60_001);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);

    const ledger = await proxy.readLedger();
    assert.ok(Number(ledger[1].wait_ms) >= 60_000);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('holds new requests while the uncached-input window is over its cap', { timeout: 5_000 }, async () => {
  let calls = 0;
  const upstream = await startFakeUpstream((_request, _body, response) => {
    calls += 1;
    const prompt = calls === 1 ? 960 : 10;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: prompt, completion_tokens: 10 } }));
  });
  const proxy = await startProxy({
    upstream: upstream.url,
    groups: {
      test: { models: ['morph-test'], caps: { uncachedIn: 1_000, out: 100_000 } },
    },
  });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-test', messages: [] }),
    });

    const pending = request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-test', messages: [] }),
    });
    await waitFor(() => proxy.clock.pending > 0);
    assert.equal(upstream.requests.length, 1);

    await proxy.clock.advance(60_001);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);

    const ledger = await proxy.readLedger();
    assert.ok(Number(ledger[1].wait_ms) >= 60_000);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('forwards after the max wait instead of rejecting for budget', { timeout: 5_000 }, async () => {
  let calls = 0;
  const upstream = await startFakeUpstream((_request, _body, response) => {
    calls += 1;
    const out = calls === 1 ? 900 : 10;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: out } }));
  });
  const proxy = await startProxy({
    admission: 'strict',
    upstream: upstream.url,
    maxWaitMs: 1_000,
    groups: {
      test: { models: ['morph-test'], caps: { uncachedIn: 100_000, out: 1_000 } },
    },
  });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-test', messages: [] }),
    });

    const pending = request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-test', messages: [] }),
    });
    await waitFor(() => proxy.clock.pending > 0);
    assert.equal(upstream.requests.length, 1);

    await proxy.clock.advance(1_000);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);

    const ledger = await proxy.readLedger();
    assert.ok(Number(ledger[1].wait_ms) >= 1_000);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('shares one budget across both DeepSeek model ids', { timeout: 5_000 }, async () => {
  let calls = 0;
  const upstream = await startFakeUpstream((_request, _body, response) => {
    calls += 1;
    const out = calls === 1 ? 900 : 10;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: out } }));
  });
  const proxy = await startProxy({
    admission: 'strict',
    upstream: upstream.url,
    groups: {
      deepseek: {
        models: ['morph-dsv41flash', 'morph-dsv41flash-1017'],
        caps: { uncachedIn: 100_000, out: 1_000 },
      },
    },
  });

  try {
    await request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-dsv41flash', messages: [] }),
    });

    const pending = request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-dsv41flash-1017', messages: [] }),
    });
    await waitFor(() => proxy.clock.pending > 0);
    assert.equal(upstream.requests.length, 1);

    const waiting = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.deepEqual(waiting.groups.deepseek.models, [
      'morph-dsv41flash',
      'morph-dsv41flash-1017',
    ]);
    assert.equal(waiting.groups.deepseek.window.out, 900);
    assert.equal(waiting.groups.deepseek.queue, 1);

    await proxy.clock.advance(60_001);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('honors Retry-After on 429 and retries transparently', { timeout: 5_000 }, async () => {
  let calls = 0;
  const upstream = await startFakeUpstream((_request, _body, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      response.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const pending = request(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'morph-kimik31', messages: [] }),
    });
    await waitFor(() => proxy.clock.pending > 0);
    assert.equal(upstream.requests.length, 1);

    await proxy.clock.advance(1_999);
    assert.equal(upstream.requests.length, 1);
    await proxy.clock.advance(1);

    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);

    const ledger = await proxy.readLedger();
    assert.equal(ledger[0].retries, 1);

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.kimik31.rate_limits_last_hour, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

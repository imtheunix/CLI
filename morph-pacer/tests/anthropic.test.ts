import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFakeUpstream, startProxy } from './helpers.js';

function postMessages(
  proxyUrl: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return request(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

test('POST /v1/messages: alias maps the model only and Anthropic usage feeds pacing and the ledger', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          output_tokens: 30,
        },
      }),
    );
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await postMessages(
      proxy.url,
      JSON.stringify({
        model: 'morph-kimik31-nothink',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].url, '/v1/messages');

    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.model, 'morph-kimik31');
    assert.equal(sent.chat_template_kwargs, undefined, 'Anthropic wire aliases map the model only');

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.kimik31.window.uncached_in, 110);
    assert.equal(snapshot.groups.kimik31.window.out, 30);
    assert.equal(snapshot.groups.kimik31.reservations, 0);

    const ledger = await proxy.readLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].model, 'morph-kimik31');
    assert.equal(ledger[0].alias, 'morph-kimik31-nothink');
    assert.equal(ledger[0].uncached_in, 110);
    assert.equal(ledger[0].cached_in, 40);
    assert.equal(ledger[0].out, 30);
    assert.equal(ledger[0].reasoning, 0);
    assert.equal(ledger[0].status, 200);
    assert.equal(ledger[0].stream, false);
    assert.equal(ledger[0].cache_ttl, null);
    assert.equal(ledger[0].run_id_set, false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('POST /v1/messages streaming: merges message_start and message_delta usage without OpenAI-only injections', { timeout: 5_000 }, async () => {
  const upstream = await startFakeUpstream((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n',
    );
    response.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    );
    response.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
    );
    response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const proxy = await startProxy({ upstream: upstream.url });

  try {
    const response = await postMessages(
      proxy.url,
      JSON.stringify({
        model: 'morph-kimik31',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      { 'x-session-id': 'anthropic-session' },
    );

    assert.equal(response.status, 200);
    assert.match(response.body, /message_stop/);

    const sent = JSON.parse(upstream.requests[0].body);
    assert.equal(sent.stream_options, undefined, 'stream_options is OpenAI-only');
    assert.equal(sent.cache_ttl, undefined);
    assert.equal(sent.run_id, undefined);

    const snapshot = JSON.parse((await request(`${proxy.url}/pacer/usage`)).body);
    assert.equal(snapshot.groups.kimik31.window.uncached_in, 55);
    assert.equal(snapshot.groups.kimik31.window.out, 25);

    const ledger = await proxy.readLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].uncached_in, 55);
    assert.equal(ledger[0].cached_in, 20);
    assert.equal(ledger[0].out, 25);
    assert.equal(ledger[0].stream, true);
    assert.equal(ledger[0].status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

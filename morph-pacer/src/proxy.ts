import http from 'node:http';
import https from 'node:https';

import type { Clock } from './clock.js';
import type { PacerConfig } from './config.js';
import { Ledger, type LedgerEntry } from './ledger.js';
import type { Logger } from './logger.js';
import { Pacer, type Usage } from './pacer.js';
import { parseJsonUsage, SseUsageParser } from './usage.js';

export interface ProxyOptions {
  config: PacerConfig;
  clock: Clock;
  logger: Logger;
  pacer?: Pacer;
  ledger?: Ledger;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendUpstream(
  url: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method, headers }, (response) => resolve(response));
    request.on('error', reject);
    request.end(body);
  });
}

function parseRetryAfter(value: string | string[] | undefined, now: number): number | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function retryDelay(
  header: string | string[] | undefined,
  attempt: number,
  clock: Clock,
): number {
  const retryAfter = parseRetryAfter(header, clock.now());
  if (retryAfter !== null) return retryAfter;
  const base = Math.min(60_000, 1_000 * 2 ** attempt);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.max(1_000, Math.min(60_000, Math.round(base * jitter)));
}

function responseHeaders(
  upstream: http.IncomingMessage,
  contentLength?: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (
      lower === 'content-length' ||
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'content-encoding'
    ) {
      continue;
    }
    headers[key] = value;
  }
  if (contentLength !== undefined) headers['content-length'] = contentLength;
  return headers;
}

function upstreamHeaders(
  request: http.IncomingMessage,
  config: PacerConfig,
  url: URL,
  bodyLength: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key' ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'accept-encoding'
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers.authorization = `Bearer ${config.apiKey}`;
  headers.host = url.host;
  headers['content-length'] = bodyLength;
  headers['accept-encoding'] = 'identity';
  return headers;
}

function parseRequestJson(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function createProxyServer(options: ProxyOptions): http.Server {
  const { config, clock, logger } = options;
  const pacer = options.pacer ?? new Pacer(config, clock, logger);
  const ledger = options.ledger ?? new Ledger(config.ledgerPath, config.ledgerMaxBytes);

  return http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error(`morph-pacer: request failed: ${(error as Error).message}`);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({ error: { message: 'morph-pacer internal error' } }));
    });
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/pacer/usage' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(pacer.usageSnapshot()));
      return;
    }

    if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const rawBody = await readBody(request);
    const parsed = parseRequestJson(rawBody);
    const model = typeof parsed?.model === 'string' ? parsed.model : 'unknown';
    const requestedStream = parsed?.stream === true;

    let body = rawBody;
    if (parsed && requestedStream) {
      const streamOptions =
        parsed.stream_options && typeof parsed.stream_options === 'object'
          ? (parsed.stream_options as Record<string, unknown>)
          : {};
      if (streamOptions.include_usage === undefined) {
        streamOptions.include_usage = true;
      }
      parsed.stream_options = streamOptions;
      body = Buffer.from(JSON.stringify(parsed), 'utf8');
    }

    const admission = await pacer.admit(model);
    if (response.destroyed) {
      pacer.complete(admission, null);
      return;
    }

    const base = config.upstream.replace(/\/+$/, '');
    const suffix = (request.url ?? '/v1').replace(/^\/v1/, '');
    const upstreamUrl = new URL(base + suffix);
    const headers = upstreamHeaders(request, config, upstreamUrl, body.length);

    let retries = 0;
    let upstream: http.IncomingMessage | null = null;
    let networkError: Error | null = null;

    for (;;) {
      try {
        upstream = await sendUpstream(upstreamUrl, request.method ?? 'POST', headers, body);
      } catch (error) {
        networkError = error as Error;
        break;
      }

      const status = upstream.statusCode ?? 0;
      if (status !== 429 && status !== 503) break;
      if (status === 429) pacer.recordRateLimit(admission.groupKey);
      if (retries >= config.maxRetries) break;

      const delay = retryDelay(upstream.headers['retry-after'], retries, clock);
      upstream.resume();
      upstream = null;
      await clock.sleep(delay);
      retries += 1;
    }

    let finished = false;
    const finish = async (
      usage: Usage | null,
      status: number,
      stream: boolean,
    ): Promise<void> => {
      if (finished) return;
      finished = true;
      pacer.complete(admission, usage);
      const entry: LedgerEntry = {
        ts: new Date(clock.now()).toISOString(),
        model,
        uncached_in: usage ? Math.max(0, usage.promptTokens - usage.cachedTokens) : 0,
        cached_in: usage?.cachedTokens ?? 0,
        out: usage?.completionTokens ?? 0,
        reasoning: usage?.reasoningTokens ?? 0,
        status,
        wait_ms: admission.waitMs,
        retries,
        stream,
      };
      try {
        await ledger.append(entry);
      } catch (error) {
        logger.error(`morph-pacer: ledger write failed: ${(error as Error).message}`);
      }
    };

    if (!upstream) {
      const message = networkError?.message ?? 'upstream request failed';
      logger.error(`morph-pacer: ${message}`);
      await finish(null, 502, requestedStream);
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `morph-pacer: ${message}` } }));
      return;
    }

    const status = upstream.statusCode ?? 502;
    const contentType = String(upstream.headers['content-type'] ?? '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');

    response.on('close', () => {
      if (!finished) {
        upstream?.destroy();
        void finish(null, 499, requestedStream);
      }
    });

    if (isSse) {
      response.writeHead(status, responseHeaders(upstream));
      const parser = new SseUsageParser();
      upstream.on('data', (chunk: Buffer) => {
        response.write(chunk);
        parser.push(chunk);
      });
      upstream.on('end', () => {
        parser.flush();
        void finish(parser.usage, status, requestedStream).then(() => {
          if (!response.destroyed) response.end();
        });
      });
      upstream.on('error', (error) => {
        logger.error(`morph-pacer: upstream stream failed: ${error.message}`);
        response.destroy(error);
      });
      return;
    }

    const chunks: Buffer[] = [];
    upstream.on('data', (chunk: Buffer) => chunks.push(chunk));
    upstream.on('end', () => {
      const responseBody = Buffer.concat(chunks);
      const usage = parseJsonUsage(responseBody);
      void finish(usage, status, requestedStream).then(() => {
        if (response.destroyed) return;
        response.writeHead(status, responseHeaders(upstream, responseBody.length));
        response.end(responseBody);
      });
    });
    upstream.on('error', (error) => {
      logger.error(`morph-pacer: upstream response failed: ${error.message}`);
      response.destroy(error);
    });
  }
}

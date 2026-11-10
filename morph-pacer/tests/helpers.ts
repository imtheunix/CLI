import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock } from '../src/clock.js';
import { DEFAULT_CONFIG, DEFAULT_GROUPS, type PacerConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createProxyServer } from '../src/proxy.js';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeUpstream {
  server: http.Server;
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startFakeUpstream(
  handler: (
    request: http.IncomingMessage,
    body: string,
    response: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      void handler(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake upstream has no port');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface ProxyHarness {
  server: http.Server;
  url: string;
  clock: FakeClock;
  config: PacerConfig;
  ledgerPath: string;
  readLedger: () => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

export async function startProxy(overrides: Partial<PacerConfig> = {}): Promise<ProxyHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'morph-pacer-test-'));
  const clock = new FakeClock();
  const config: PacerConfig = {
    ...DEFAULT_CONFIG,
    host: '127.0.0.1',
    port: 0,
    apiKey: 'test-key',
    ledgerPath: join(directory, 'ledger.jsonl'),
    pollMs: 50,
    ...overrides,
    groups: overrides.groups ?? DEFAULT_GROUPS,
  };
  const server = createProxyServer({ config, clock, logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy has no port');

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    clock,
    config,
    ledgerPath: config.ledgerPath,
    readLedger: async () => {
      try {
        const text = await readFile(config.ledgerPath, 'utf8');
        return text
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface ClientResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    clientRequest.on('error', reject);
    if (options.body) clientRequest.write(options.body);
    clientRequest.end();
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

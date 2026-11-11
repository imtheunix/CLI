import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import { expandHome } from './config.js';
import type {
  PacerUsageSnapshot,
  ProbeHttpResponse,
  ProbeTransport,
} from './probe.js';

export interface LiveTransportOptions {
  apiKeyFile?: string;
  chatUrl?: string;
  usageUrl?: string;
  requestTimeoutMs?: number;
  usageTimeoutMs?: number;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  latencyMs: number;
}

function request(
  url: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = transport.request(
      url,
      { method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            latencyMs: Date.now() - started,
          });
        });
        response.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs} ms`));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function readApiKey(path: string): string {
  const key = readFileSync(expandHome(path), 'utf8').trim();
  if (!key) throw new Error(`no API key in ${path}`);
  return key;
}

/**
 * Live transport for the probe. The key is read into this process only and is never logged,
 * placed in argv, or written to the report.
 */
export function createLiveTransport(options: LiveTransportOptions = {}): ProbeTransport {
  const apiKeyFile = options.apiKeyFile ?? '~/.config/morph/api_key';
  const chatUrl = new URL(
    options.chatUrl ?? 'https://api.morphllm.com/v1/chat/completions',
  );
  const usageUrl = new URL(options.usageUrl ?? 'http://127.0.0.1:8198/pacer/usage');
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const usageTimeoutMs = options.usageTimeoutMs ?? 2_000;
  const apiKey = readApiKey(apiKeyFile);

  return {
    async postChat(input): Promise<ProbeHttpResponse> {
      const body = JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: input.prompt }],
        max_tokens: input.maxOutputTokens,
        temperature: 0,
        stream: false,
      });
      return request(
        chatUrl,
        'POST',
        {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
        requestTimeoutMs,
      );
    },

    async getUsage(): Promise<PacerUsageSnapshot> {
      const response = await request(usageUrl, 'GET', {}, null, usageTimeoutMs);
      if (response.status !== 200) {
        throw new Error(`pacer usage returned status ${response.status}`);
      }
      return JSON.parse(response.body) as PacerUsageSnapshot;
    },
  };
}

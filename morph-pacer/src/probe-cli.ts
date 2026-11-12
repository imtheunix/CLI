import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FakeClock, RealClock, type Clock } from './clock.js';
import { DEFAULT_GROUPS } from './config.js';
import {
  PROBE_MODELS,
  runProbe,
  sanitizeResult,
  type LiveUsage,
  type ProbeModelConfig,
  type ProbeRequest,
  type ProbeResponse,
  type ProbeResult,
  type ProbeTransport,
} from './probe.js';
import { parseJsonUsage } from './usage.js';

const DEFAULT_API_KEY_FILE = '~/.config/morph/api_key';
const DEFAULT_LIVE_USAGE_URL = 'http://127.0.0.1:8198/pacer/usage';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIVE_USAGE_TIMEOUT_MS = 2_000;

export interface ProbeCliOptions {
  live: boolean;
  test: boolean;
  dryRun: boolean;
  model: ProbeModelConfig;
  deadlineMs?: number;
  maxCalls?: number;
  maxInputSteps?: number;
  maxOutputSteps?: number;
  startInputTokens?: number;
  startOutputTokens?: number;
  successesPerLevel?: number;
  headroom?: number;
  apiKeyFile: string;
  liveUsageUrl: string;
  timeoutMs: number;
  liveUsageTimeoutMs: number;
}

export interface ProbeCliDeps {
  clock?: Clock;
  transport?: ProbeTransport;
  readKey?: (path: string) => string;
  print?: (text: string) => void;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function numberArg(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return parsed;
}

export function parseProbeArgs(argv: string[]): ProbeCliOptions {
  const options: ProbeCliOptions = {
    live: false,
    test: false,
    dryRun: false,
    model: PROBE_MODELS[0],
    apiKeyFile: DEFAULT_API_KEY_FILE,
    liveUsageUrl: DEFAULT_LIVE_USAGE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    liveUsageTimeoutMs: DEFAULT_LIVE_USAGE_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const next = (): string => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[index];
    };

    switch (flag) {
      case '--live':
        options.live = true;
        break;
      case '--test':
        options.test = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--model': {
        const wanted = next();
        const found = PROBE_MODELS.find((entry) => entry.model === wanted || entry.group === wanted);
        if (!found) {
          throw new Error(`unknown model ${wanted}; choose one of ${PROBE_MODELS.map((entry) => entry.model).join(', ')}`);
        }
        options.model = found;
        break;
      }
      case '--deadline-ms':
        options.deadlineMs = numberArg(next(), flag);
        break;
      case '--max-calls':
        options.maxCalls = numberArg(next(), flag);
        break;
      case '--max-input-steps':
        options.maxInputSteps = numberArg(next(), flag);
        break;
      case '--max-output-steps':
        options.maxOutputSteps = numberArg(next(), flag);
        break;
      case '--start-input-tokens':
        options.startInputTokens = numberArg(next(), flag);
        break;
      case '--start-output-tokens':
        options.startOutputTokens = numberArg(next(), flag);
        break;
      case '--successes-per-level':
        options.successesPerLevel = numberArg(next(), flag);
        break;
      case '--headroom':
        options.headroom = numberArg(next(), flag);
        break;
      case '--api-key-file':
        options.apiKeyFile = next();
        break;
      case '--live-usage-url':
        options.liveUsageUrl = next();
        break;
      case '--timeout-ms':
        options.timeoutMs = numberArg(next(), flag);
        break;
      case '--live-usage-timeout-ms':
        options.liveUsageTimeoutMs = numberArg(next(), flag);
        break;
      case '--help':
      case '-h':
        throw new Error('usage: probe-cli [--dry-run | --test | --live] [--model <id>] [bounds]');
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }

  if (options.live && options.test) throw new Error('--live and --test are mutually exclusive');
  return options;
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

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function requestJson(
  url: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: string | null,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

export function createLiveTransport(options: {
  apiKey: string;
  group: string;
  liveUsageUrl: string;
  timeoutMs: number;
  liveUsageTimeoutMs: number;
  clock: Clock;
}): ProbeTransport {
  const chatUrl = new URL('https://api.morphllm.com/v1/chat/completions');
  const usageUrl = new URL(options.liveUsageUrl);

  return {
    async postChat(request: ProbeRequest): Promise<ProbeResponse> {
      const body = JSON.stringify({
        model: request.model,
        messages: [{ role: 'user', content: request.prompt }],
        max_tokens: request.maxTokens,
        temperature: 0,
        stream: false,
      });
      const response = await requestJson(
        chatUrl,
        'POST',
        {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'accept-encoding': 'identity',
        },
        body,
        options.timeoutMs,
      );
      return {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers['retry-after'], options.clock.now()),
        usage: parseJsonUsage(response.body),
      };
    },

    async getLiveUsage(): Promise<LiveUsage> {
      const response = await requestJson(
        usageUrl,
        'GET',
        { accept: 'application/json', 'accept-encoding': 'identity' },
        null,
        options.liveUsageTimeoutMs,
      );
      if (response.status !== 200) throw new Error(`live usage HTTP ${response.status}`);
      const parsed = JSON.parse(response.body) as {
        groups?: Record<string, { window?: { uncached_in?: number; out?: number } }>;
      };
      const window = parsed.groups?.[options.group]?.window;
      if (!window || typeof window.uncached_in !== 'number' || typeof window.out !== 'number') {
        throw new Error(`live usage has no ${options.group} window`);
      }
      return { uncachedIn: window.uncached_in, out: window.out };
    },
  };
}

function readApiKey(path: string): string {
  const key = readFileSync(expandHome(path), 'utf8').trim();
  if (!key) throw new Error(`no API key in ${path}`);
  return key;
}

function offlineTransport(clock: FakeClock): ProbeTransport {
  let calls = 0;
  return {
    async getLiveUsage(): Promise<LiveUsage> {
      return { uncachedIn: 0, out: 0 };
    },
    async postChat(request: ProbeRequest): Promise<ProbeResponse> {
      calls += 1;
      await clock.advance(10);
      if (calls <= 3) {
        return {
          status: 200,
          retryAfterMs: null,
          usage: {
            promptTokens: Math.max(1, Math.ceil(request.prompt.length / 4)),
            completionTokens: 5,
            cachedTokens: 0,
            reasoningTokens: 0,
          },
        };
      }
      return { status: 429, retryAfterMs: 0, usage: null };
    },
  };
}

function plan(options: ProbeCliOptions): Record<string, unknown> {
  const caps = DEFAULT_GROUPS[options.model.group].caps;
  return {
    mode: 'dry-run',
    network: false,
    model: options.model.model,
    group: options.model.group,
    caps,
    budgets: { input: options.model.inputBudget, output: options.model.outputBudget },
    bounds: {
      deadlineMs: options.deadlineMs ?? 20 * 60_000,
      maxCalls: options.maxCalls ?? 160,
      maxInputSteps: options.maxInputSteps ?? 60,
      maxOutputSteps: options.maxOutputSteps ?? 30,
      successesPerLevel: options.successesPerLevel ?? 3,
    },
    protocol: [
      'one model per invocation, one request in flight, no automatic retries',
      'read the live /pacer/usage window before every call and add the probe window to it',
      'abort on missing usage, second consecutive 429, deadline, budget, step cap or live-load guard',
      'a below-cap 429 is cap-not-explanatory, never a proven ceiling',
    ],
    live: 'pass --live to acknowledge real provider traffic',
  };
}

export async function runCli(
  argv: string[],
  deps: ProbeCliDeps = {},
): Promise<{ mode: string; result?: ProbeResult; plan?: Record<string, unknown> }> {
  const options = parseProbeArgs(argv);
  const print = deps.print ?? ((text: string) => console.log(text));
  const caps = DEFAULT_GROUPS[options.model.group].caps;

  if (!options.live && !options.test) {
    const output = plan(options);
    print(JSON.stringify(output, null, 2));
    return { mode: 'dry-run', plan: output };
  }

  const clock = deps.clock ?? (options.test ? new FakeClock() : new RealClock());
  const transport =
    deps.transport ??
    (options.test
      ? offlineTransport(clock as FakeClock)
      : createLiveTransport({
          apiKey: (deps.readKey ?? readApiKey)(options.apiKeyFile),
          group: options.model.group,
          liveUsageUrl: options.liveUsageUrl,
          timeoutMs: options.timeoutMs,
          liveUsageTimeoutMs: options.liveUsageTimeoutMs,
          clock,
        }));

  const result = sanitizeResult(
    await runProbe({
      model: options.model,
      transport,
      clock,
      caps,
      headroom: options.headroom,
      deadlineMs: options.deadlineMs,
      maxCalls: options.maxCalls,
      maxInputSteps: options.maxInputSteps,
      maxOutputSteps: options.maxOutputSteps,
      startInputTokens: options.startInputTokens,
      startOutputTokens: options.startOutputTokens,
      successesPerLevel: options.successesPerLevel,
    }),
  );

  print(JSON.stringify(result, null, 2));
  return { mode: options.test ? 'test' : 'live', result };
}

async function main(): Promise<void> {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`morph-rate-probe: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

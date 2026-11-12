import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import { RealClock, type Clock } from './clock.js';
import { DEFAULT_GROUPS, expandHome } from './config.js';
import {
  DEFAULT_PROBE_BOUNDS,
  runProbe,
  type PacerUsageSnapshot,
  type ProbeBounds,
  type ProbeHttpResponse,
  type ProbeReport,
  type ProbeRequest,
  type ProbeTransport,
} from './probe.js';

const DEFAULT_MODEL = 'morph-dsv41flash-1017';
const PACER_USAGE_URL = 'http://127.0.0.1:8198/pacer/usage';
const MORPH_CHAT_URL = 'https://api.morphllm.com/v1/chat/completions';

export interface CliDeps {
  createTransport?: (options: { apiKey: string; bounds: ProbeBounds }) => ProbeTransport;
  readApiKey?: () => string;
  clock?: Clock;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface CliArgs {
  mode: 'help' | 'dry-run' | 'test' | 'live';
  model: string;
  inputBudget: number;
  outputBudget: number;
  bounds: ProbeBounds;
  initialInputTarget: number;
  initialOutputTarget: number;
  json: boolean;
}

const HELP = `Morph rate probe (offline by default)

Usage: tsx morph-pacer/src/probe-cli.ts [options]

Offline:
  --dry-run                 Print the resolved bounds and model; no network.
  --test                    Run a deterministic offline probe with a fake transport.
  --help                    Print this help; no network.

Live (explicit acknowledgement required):
  --live                    Acknowledge a real Morph probe. Requires --model,
                            --input-budget and --output-budget.
  --model <id|group>        Model id, or a group key (deepseek, kimik31).
                            Run DeepSeek before Kimi, one model per invocation.
  --input-budget <n>        Finite uncached-input token budget for this invocation.
  --output-budget <n>       Finite output token budget for this invocation.

Bounds:
  --deadline-ms <n>         Total wall-clock bound (default ${DEFAULT_PROBE_BOUNDS.deadlineMs}).
  --max-calls <n>           Cumulative calls, failures included (default ${DEFAULT_PROBE_BOUNDS.maxCalls}).
  --max-input-steps <n>     Input escalation cap (default ${DEFAULT_PROBE_BOUNDS.maxInputSteps}).
  --max-output-steps <n>    Output escalation cap (default ${DEFAULT_PROBE_BOUNDS.maxOutputSteps}).
  --input-start <n>         First input target (default 256).
  --output-start <n>        First output target (default 32).
  --headroom <fraction>     Live-load guard fraction (default ${DEFAULT_PROBE_BOUNDS.headroom}).
  --live-timeout-ms <n>     Bound for GET /pacer/usage (default ${DEFAULT_PROBE_BOUNDS.liveTimeoutMs}).
  --request-timeout-ms <n>  Bound for one provider request (default ${DEFAULT_PROBE_BOUNDS.requestTimeoutMs}).
  --json                    Print JSON (default for --test and --live).
`;

function numberArg(value: string | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name} needs a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function positiveArg(value: string | undefined, name: string): number {
  const parsed = numberArg(value, name);
  if (parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function resolveModel(value: string): string {
  const group = DEFAULT_GROUPS[value];
  if (group && group.models.length > 0) return group.models[0];
  return value;
}

export function parseArgs(argv: string[]): CliArgs {
  const bounds: ProbeBounds = { ...DEFAULT_PROBE_BOUNDS };
  let mode: CliArgs['mode'] = 'help';
  let model = DEFAULT_MODEL;
  let inputBudget = bounds.inputBudget;
  let outputBudget = bounds.outputBudget;
  let initialInputTarget = 256;
  let initialOutputTarget = 32;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string | undefined => {
      index += 1;
      return argv[index];
    };

    switch (arg) {
      case '--help':
      case '-h':
        mode = 'help';
        break;
      case '--dry-run':
        mode = 'dry-run';
        break;
      case '--test':
        mode = 'test';
        break;
      case '--live':
        mode = 'live';
        break;
      case '--json':
        json = true;
        break;
      case '--model':
        model = resolveModel(next() ?? '');
        break;
      case '--input-budget':
        inputBudget = positiveArg(next(), '--input-budget');
        break;
      case '--output-budget':
        outputBudget = positiveArg(next(), '--output-budget');
        break;
      case '--deadline-ms':
        bounds.deadlineMs = positiveArg(next(), '--deadline-ms');
        break;
      case '--max-calls':
        bounds.maxCalls = positiveArg(next(), '--max-calls');
        break;
      case '--max-input-steps':
        bounds.maxInputSteps = positiveArg(next(), '--max-input-steps');
        break;
      case '--max-output-steps':
        bounds.maxOutputSteps = positiveArg(next(), '--max-output-steps');
        break;
      case '--input-start':
        initialInputTarget = positiveArg(next(), '--input-start');
        break;
      case '--output-start':
        initialOutputTarget = positiveArg(next(), '--output-start');
        break;
      case '--headroom':
        bounds.headroom = positiveArg(next(), '--headroom');
        break;
      case '--live-timeout-ms':
        bounds.liveTimeoutMs = positiveArg(next(), '--live-timeout-ms');
        break;
      case '--request-timeout-ms':
        bounds.requestTimeoutMs = positiveArg(next(), '--request-timeout-ms');
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (mode === 'live') {
    if (!model) throw new Error('--live requires --model');
    if (inputBudget === bounds.inputBudget && !argv.includes('--input-budget')) {
      throw new Error('--live requires an explicit --input-budget');
    }
    if (outputBudget === bounds.outputBudget && !argv.includes('--output-budget')) {
      throw new Error('--live requires an explicit --output-budget');
    }
  }

  return {
    mode,
    model,
    inputBudget,
    outputBudget,
    bounds,
    initialInputTarget,
    initialOutputTarget,
    json: json || mode === 'test' || mode === 'live',
  };
}

function requestJson(
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<ProbeHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(
      parsed,
      { method: options.method, headers: options.headers },
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
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error('request timed out'));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export function createRealTransport(apiKey: string, bounds: ProbeBounds): ProbeTransport {
  return {
    postChatCompletion(request: ProbeRequest): Promise<ProbeHttpResponse> {
      return requestJson(MORPH_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'user', content: request.prompt }],
          max_tokens: request.maxTokens,
          stream: false,
        }),
        timeoutMs: bounds.requestTimeoutMs,
      });
    },
    async getPacerUsage(): Promise<PacerUsageSnapshot> {
      const response = await requestJson(PACER_USAGE_URL, {
        method: 'GET',
        timeoutMs: bounds.liveTimeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`pacer usage returned ${response.status}`);
      }
      return JSON.parse(response.body) as PacerUsageSnapshot;
    },
  };
}

function offlineTransport(model: string): ProbeTransport {
  let calls = 0;
  const snapshot: PacerUsageSnapshot = {
    now: new Date(0).toISOString(),
    groups: {
      test: {
        models: [model],
        window: { uncached_in: 0, out: 0 },
        caps: { uncached_in: 10_000, out: 1_000 },
        headroom: 0.95,
        reservations: 0,
        queue: 0,
        rate_limits_last_hour: 0,
      },
    },
  };

  return {
    async getPacerUsage() {
      return snapshot;
    },
    async postChatCompletion() {
      calls += 1;
      if (calls <= 3) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        };
      }
      return {
        status: 429,
        headers: { 'retry-after': '0' },
        body: JSON.stringify({ error: { message: 'synthetic rate limit' } }),
      };
    },
  };
}

function readDefaultApiKey(): string {
  const path = expandHome('~/.config/morph/api_key');
  const key = readFileSync(path, 'utf8').trim();
  if (!key) throw new Error(`no API key in ${path}`);
  return key;
}

function printReport(report: ProbeReport, stdout: (text: string) => void): void {
  stdout(`${JSON.stringify(report, null, 2)}\n`);
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const clock = deps.clock ?? new RealClock();

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`morph-rate-probe: ${(error as Error).message}\n`);
    return 2;
  }

  if (args.mode === 'help') {
    stdout(HELP);
    return 0;
  }

  if (args.mode === 'dry-run') {
    stdout(
      `${JSON.stringify(
        {
          mode: 'dry-run',
          model: args.model,
          bounds: args.bounds,
          inputBudget: args.inputBudget,
          outputBudget: args.outputBudget,
          initialInputTarget: args.initialInputTarget,
          initialOutputTarget: args.initialOutputTarget,
          network: false,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  let transport: ProbeTransport;
  if (args.mode === 'test') {
    transport = offlineTransport(args.model);
  } else {
    let apiKey: string;
    try {
      apiKey = (deps.readApiKey ?? readDefaultApiKey)();
    } catch (error) {
      stderr(`morph-rate-probe: cannot read API key: ${(error as Error).message}\n`);
      return 2;
    }
    transport = (deps.createTransport ?? createRealTransport)({
      apiKey,
      bounds: args.bounds,
    });
  }

  const report = await runProbe({
    model: args.model,
    bounds: {
      ...args.bounds,
      inputBudget: args.inputBudget,
      outputBudget: args.outputBudget,
    },
    clock,
    transport,
    initialInputTarget: args.initialInputTarget,
    initialOutputTarget: args.initialOutputTarget,
  });

  printReport(report, stdout);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

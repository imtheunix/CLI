import { writeFileSync } from 'node:fs';

import { RealClock, type Clock } from './clock.js';
import { DEFAULT_GROUPS } from './config.js';
import {
  runProbe,
  type PacerUsageSnapshot,
  type ProbeLevel,
  type ProbeModel,
  type ProbeReport,
  type ProbeTransport,
} from './probe.js';
import { createLiveTransport } from './probe-transport.js';

export const DEFAULT_LEVELS: ProbeLevel[] = [
  { inputTokens: 2_000, outputTokens: 256 },
  { inputTokens: 8_000, outputTokens: 256 },
  { inputTokens: 24_000, outputTokens: 256 },
  { inputTokens: 48_000, outputTokens: 256 },
  { inputTokens: 72_000, outputTokens: 256 },
  { inputTokens: 96_000, outputTokens: 256 },
  { inputTokens: 144_000, outputTokens: 256 },
  { inputTokens: 192_000, outputTokens: 256 },
];

export const DEFAULT_MODELS: ProbeModel[] = [
  { model: 'morph-dsv41flash-1017', group: 'deepseek' },
  { model: 'morph-kimik31', group: 'kimik31' },
];

const DEFAULT_DEADLINE_MS = 20 * 60 * 1000;
const DEFAULT_MAX_INPUT = 240_000;
const DEFAULT_MAX_OUTPUT = 32_000;

export interface ProbeCliDeps {
  clock?: Clock;
  createLiveTransport?: () => ProbeTransport;
  createTestTransport?: () => ProbeTransport;
  writeReport?: (path: string, report: ProbeReport) => void;
  stdout?: (text: string) => void;
}

interface ParsedArgs {
  live: boolean;
  test: boolean;
  help: boolean;
  reportPath: string | null;
  deadlineMs: number;
  maxInput: number;
  maxOutput: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    live: false,
    test: false,
    help: false,
    reportPath: null,
    deadlineMs: DEFAULT_DEADLINE_MS,
    maxInput: DEFAULT_MAX_INPUT,
    maxOutput: DEFAULT_MAX_OUTPUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') parsed.live = true;
    else if (arg === '--test') parsed.test = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--report') parsed.reportPath = argv[++index] ?? null;
    else if (arg === '--deadline-ms') parsed.deadlineMs = Number(argv[++index]);
    else if (arg === '--max-input') parsed.maxInput = Number(argv[++index]);
    else if (arg === '--max-output') parsed.maxOutput = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function usageText(): string {
  return [
    'Morph ceiling probe (offline by default)',
    '',
    '  --live                 acknowledge and use the real Morph transport',
    '  --test                 run an offline self-test with a fake transport',
    '  --report <path>        write the JSON report to <path>',
    '  --deadline-ms <n>      whole-run deadline (default 1200000)',
    '  --max-input <n>        per-request input cap (default 240000)',
    '  --max-output <n>       per-request output cap (default 32000)',
    '',
    'Without --live or --test the probe only prints its plan and makes no network call.',
  ].join('\n');
}

function planText(parsed: ParsedArgs): string {
  const models = DEFAULT_MODELS.map((model) => `${model.model} (${model.group})`).join(', ');
  const levels = DEFAULT_LEVELS.map(
    (level) => `${level.inputTokens}/${level.outputTokens}`,
  ).join(', ');
  return [
    'Morph ceiling probe plan (dry run, no network)',
    `models: ${models}`,
    `levels (input/output tokens): ${levels}`,
    `deadline: ${parsed.deadlineMs} ms`,
    `per-request cap: ${parsed.maxInput}/${parsed.maxOutput}`,
    'pass --live to acknowledge and run against Morph',
  ].join('\n');
}

function offlineSnapshot(): PacerUsageSnapshot {
  const groups: PacerUsageSnapshot['groups'] = {};
  for (const [key, group] of Object.entries(DEFAULT_GROUPS)) {
    groups[key] = {
      window: { uncached_in: 0, out: 0 },
      caps: { uncached_in: group.caps.uncachedIn, out: group.caps.out },
      headroom: 0.95,
    };
  }
  return { now: new Date(0).toISOString(), groups };
}

function createOfflineTestTransport(): ProbeTransport {
  return {
    async getUsage() {
      return offlineSnapshot();
    },
    async postChat(input) {
      return {
        status: 200,
        headers: {},
        latencyMs: 1,
        body: JSON.stringify({
          usage: {
            prompt_tokens: input.prompt.length > 0 ? 1_000 : 0,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      };
    },
  };
}

export async function runProbeCli(
  argv: string[],
  deps: ProbeCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => console.log(text));
  const parsed = parseArgs(argv);

  if (parsed.help) {
    stdout(usageText());
    return 0;
  }
  if (parsed.live && parsed.test) {
    throw new Error('--live and --test are mutually exclusive');
  }
  if (!parsed.live && !parsed.test) {
    stdout(planText(parsed));
    return 0;
  }

  const clock = deps.clock ?? new RealClock();
  const transport = parsed.live
    ? (deps.createLiveTransport ?? (() => createLiveTransport()))()
    : (deps.createTestTransport ?? createOfflineTestTransport)();

  const report = await runProbe({
    models: DEFAULT_MODELS,
    levels: parsed.test ? DEFAULT_LEVELS.slice(0, 1) : DEFAULT_LEVELS,
    clock,
    transport,
    deadlineMs: parsed.deadlineMs,
    maxRequestInputTokens: parsed.maxInput,
    maxRequestOutputTokens: parsed.maxOutput,
    live: parsed.live,
  });

  if (parsed.reportPath) {
    (deps.writeReport ?? ((path, value) => writeFileSync(path, JSON.stringify(value, null, 2))))(
      parsed.reportPath,
      report,
    );
  }
  stdout(JSON.stringify(report, null, 2));
  return report.stop?.reason === 'completed' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProbeCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    });
}

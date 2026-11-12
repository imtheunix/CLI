import { RealClock } from './clock.js';
import {
  DEFAULT_API_KEY_FILE,
  DEFAULT_LIVE_USAGE_URL,
  DEFAULT_PROBE_CAPS,
  DEFAULT_PROBE_LEVELS,
  MORPH_CHAT_COMPLETIONS_URL,
  runProbe,
  type ProbeLevel,
  type ProbeSweep,
} from './probe.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return value;
}

function parseLevels(raw: string | undefined): ProbeLevel[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((part) => {
    const [sweep, input, output] = part.split(':');
    if (sweep !== 'input' && sweep !== 'output') {
      throw new Error(`invalid level "${part}", expected sweep:input:output`);
    }
    const inputTokens = Number(input);
    const outputTokens = Number(output);
    if (
      !Number.isFinite(inputTokens) ||
      !Number.isFinite(outputTokens) ||
      inputTokens <= 0 ||
      outputTokens <= 0
    ) {
      throw new Error(`invalid level "${part}", expected sweep:input:output`);
    }
    return { sweep: sweep as ProbeSweep, input: inputTokens, output: outputTokens };
  });
}

function parseMode(raw: string | undefined): ProbeLevel[] | undefined {
  if (!raw || raw === 'all') return undefined;
  if (raw === 'output' || raw === 'input') {
    return DEFAULT_PROBE_LEVELS.filter((level) => level.sweep === raw);
  }
  throw new Error(`invalid --mode "${raw}", expected output, input or all`);
}

const live = process.argv.includes('--live');
if (live && process.env.MORPH_PROBE_ALLOW_LIVE !== '1') {
  console.error('refusing live transport: pass --live and set MORPH_PROBE_ALLOW_LIVE=1');
  process.exit(2);
}

const result = await runProbe({
  model: arg('--model') ?? 'morph-dsv41flash-1017',
  clock: new RealClock(),
  live,
  dryRun: !live,
  endpoint: arg('--endpoint') ?? MORPH_CHAT_COMPLETIONS_URL,
  usageUrl: arg('--usage-url') ?? DEFAULT_LIVE_USAGE_URL,
  apiKeyFile: arg('--api-key-file') ?? DEFAULT_API_KEY_FILE,
  caps: {
    uncachedIn: positive('--caps-in', arg('--caps-in'), DEFAULT_PROBE_CAPS.uncachedIn),
    out: positive('--caps-out', arg('--caps-out'), DEFAULT_PROBE_CAPS.out),
  },
  levels: parseLevels(arg('--levels')) ?? parseMode(arg('--mode')) ?? DEFAULT_PROBE_LEVELS,
  limits: {
    maxTotalMs: positive('--max-total-ms', arg('--max-total-ms'), 20 * 60_000),
    maxCalls: positive('--max-calls', arg('--max-calls'), 30),
    maxTokens: positive('--max-tokens', arg('--max-tokens'), 2_000_000),
    successesPerLevel: positive('--successes-per-level', arg('--successes-per-level'), 3),
    maxAttemptsPerLevel: positive(
      '--max-attempts-per-level',
      arg('--max-attempts-per-level'),
      5,
    ),
  },
});

console.log(JSON.stringify(result, null, 2));
if (result.conclusion.kind !== 'completed' && result.conclusion.kind !== 'dry_run') {
  process.exitCode = 1;
}

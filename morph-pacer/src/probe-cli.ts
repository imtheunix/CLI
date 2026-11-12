import { RealClock } from './clock.js';
import {
  DEFAULT_API_KEY_FILE,
  DEFAULT_LIVE_USAGE_URL,
  DEFAULT_PROBE_CAPS,
  DEFAULT_PROBE_LEVELS,
  DEFAULT_PROBE_LIMITS,
  MORPH_CHAT_COMPLETIONS_URL,
  runProbe,
  type ProbeCaps,
  type ProbeLevel,
} from './probe.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function numberArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

function parseLevels(raw: string | undefined): ProbeLevel[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((part) => {
    const [mode, target, companion] = part.split(':');
    if (mode !== 'input' && mode !== 'output') {
      throw new Error(
        `invalid level "${part}", expected mode:target:companion with mode input|output`,
      );
    }
    const targetValue = Number(target);
    const companionValue = Number(companion);
    if (
      !Number.isFinite(targetValue) ||
      !Number.isFinite(companionValue) ||
      targetValue <= 0 ||
      companionValue <= 0
    ) {
      throw new Error(`invalid level "${part}", expected positive mode:target:companion`);
    }
    return { mode, target: targetValue, companion: companionValue };
  });
}

function parseCaps(raw: string | undefined): ProbeCaps | undefined {
  if (!raw) return undefined;
  const [uncachedIn, out] = raw.split(':').map(Number);
  if (!Number.isFinite(uncachedIn) || !Number.isFinite(out) || uncachedIn <= 0 || out <= 0) {
    throw new Error(`invalid caps "${raw}", expected uncachedIn:out`);
  }
  return { uncachedIn, out };
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
  caps: parseCaps(arg('--caps')) ?? DEFAULT_PROBE_CAPS,
  levels: parseLevels(arg('--levels')) ?? DEFAULT_PROBE_LEVELS,
  limits: {
    maxTotalMs: numberArg('--max-total-ms', DEFAULT_PROBE_LIMITS.maxTotalMs),
    successesPerLevel: numberArg(
      '--successes-per-level',
      DEFAULT_PROBE_LIMITS.successesPerLevel,
    ),
    attemptsPerLevel: numberArg(
      '--attempts-per-level',
      DEFAULT_PROBE_LIMITS.attemptsPerLevel,
    ),
    maxCalls: numberArg('--max-calls', DEFAULT_PROBE_LIMITS.maxCalls),
    maxInputTokens: numberArg(
      '--max-input-tokens',
      DEFAULT_PROBE_LIMITS.maxInputTokens,
    ),
    maxOutputTokens: numberArg(
      '--max-output-tokens',
      DEFAULT_PROBE_LIMITS.maxOutputTokens,
    ),
  },
});

console.log(JSON.stringify(result, null, 2));
if (result.conclusion.kind !== 'completed' && result.conclusion.kind !== 'dry_run') {
  process.exitCode = 1;
}

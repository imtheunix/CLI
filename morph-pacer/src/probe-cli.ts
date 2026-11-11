import { RealClock } from './clock.js';
import {
  DEFAULT_API_KEY_FILE,
  DEFAULT_LIVE_USAGE_URL,
  DEFAULT_PROBE_CAPS,
  DEFAULT_PROBE_LEVELS,
  MORPH_CHAT_COMPLETIONS_URL,
  runProbe,
  type ProbeLevel,
} from './probe.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parseLevels(raw: string | undefined): ProbeLevel[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((part) => {
    const [input, output] = part.split(':').map(Number);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) {
      throw new Error(`invalid level "${part}", expected input:output`);
    }
    return { input, output };
  });
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
  caps: DEFAULT_PROBE_CAPS,
  levels: parseLevels(arg('--levels')) ?? DEFAULT_PROBE_LEVELS,
  limits: {
    maxTotalMs: Number(arg('--max-total-ms') ?? 20 * 60_000),
  },
});

console.log(JSON.stringify(result, null, 2));
if (result.conclusion.kind !== 'completed' && result.conclusion.kind !== 'dry_run') {
  process.exitCode = 1;
}

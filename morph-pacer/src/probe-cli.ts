import { RealClock } from './clock.js';
import { DEFAULT_PROBE_CONFIG, runProbe, type ProbeConfig } from './probe.js';

function usage(): string {
  return [
    'Usage: tsx morph-pacer/src/probe-cli.ts [options]',
    '',
    'Without --enable-live the probe prints a disabled report and makes no network calls.',
    'The API key is read in-process from --api-key-file and is never accepted as an argument.',
    '',
    'Options:',
    '  --enable-live                 allow live provider calls (required to probe)',
    '  --model <id>                  model id (default morph-dsv41flash-1017)',
    '  --group <key>                 pacer usage group (default deepseek)',
    '  --endpoint <url>              chat completions endpoint',
    '  --usage-url <url>             pacer usage endpoint',
    '  --api-key-file <path>         key file (default ~/.config/morph/api_key)',
    '  --deadline-ms <n>             hard wall-clock deadline',
    '  --max-calls <n>               hard call cap',
    '  --max-input-tokens <n>        hard input token cap',
    '  --max-output-tokens <n>       hard output token cap',
    '  --help                        show this help',
  ].join('\n');
}

function numberArg(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return parsed;
}

function parseArgs(argv: string[]): { config: ProbeConfig; help: boolean } {
  const config = structuredClone(DEFAULT_PROBE_CONFIG);
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--enable-live':
        config.enabled = true;
        break;
      case '--model':
        config.model = argv[++index] ?? config.model;
        break;
      case '--group':
        config.group = argv[++index] ?? config.group;
        break;
      case '--endpoint':
        config.endpoint = argv[++index] ?? config.endpoint;
        break;
      case '--usage-url':
        config.usageUrl = argv[++index] ?? config.usageUrl;
        break;
      case '--api-key-file':
        config.apiKeyFile = argv[++index] ?? config.apiKeyFile;
        break;
      case '--deadline-ms':
        config.caps.deadlineMs = numberArg(argv[++index], '--deadline-ms');
        break;
      case '--max-calls':
        config.caps.maxCalls = numberArg(argv[++index], '--max-calls');
        break;
      case '--max-input-tokens':
        config.caps.maxInputTokens = numberArg(argv[++index], '--max-input-tokens');
        break;
      case '--max-output-tokens':
        config.caps.maxOutputTokens = numberArg(argv[++index], '--max-output-tokens');
        break;
      case '--help':
        help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { config, help };
}

async function main(): Promise<void> {
  const { config, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await runProbe(config, { clock: new RealClock() });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'stopped') process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`morph-ceiling-probe: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

import { RealClock } from './clock.js';
import {
  DEFAULT_PROBE_CONFIG,
  createPacerUsageSource,
  pacerGroupFor,
  readApiKeyFromFile,
  runProbe,
  type ProbeConfig,
} from './ceiling-probe.js';

function numberArg(args: string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (raw === undefined) throw new Error(`${name} needs a value`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function stringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (raw === undefined) throw new Error(`${name} needs a value`);
  return raw;
}

function listArg(args: string[], name: string): number[] | undefined {
  const raw = stringArg(args, name);
  if (raw === undefined) return undefined;
  return raw.split(',').map((part) => {
    const value = Number(part.trim());
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} has an invalid step`);
    return value;
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const model = stringArg(args, '--model') ?? DEFAULT_PROBE_CONFIG.model;
  const config: ProbeConfig = {
    ...DEFAULT_PROBE_CONFIG,
    enabled: args.includes('--enable'),
    model,
    providerUrl: stringArg(args, '--provider-url') ?? DEFAULT_PROBE_CONFIG.providerUrl,
    apiKeyFile: stringArg(args, '--api-key-file') ?? DEFAULT_PROBE_CONFIG.apiKeyFile,
    pacerUsageUrl: stringArg(args, '--pacer-usage-url') ?? DEFAULT_PROBE_CONFIG.pacerUsageUrl,
    pacerTimeoutMs: numberArg(args, '--pacer-timeout-ms') ?? DEFAULT_PROBE_CONFIG.pacerTimeoutMs,
    requestTimeoutMs:
      numberArg(args, '--request-timeout-ms') ?? DEFAULT_PROBE_CONFIG.requestTimeoutMs,
    liveGuardFraction:
      numberArg(args, '--live-guard-fraction') ?? DEFAULT_PROBE_CONFIG.liveGuardFraction,
    maxWaitMs: numberArg(args, '--max-wait-ms') ?? DEFAULT_PROBE_CONFIG.maxWaitMs,
    pollMs: numberArg(args, '--poll-ms') ?? DEFAULT_PROBE_CONFIG.pollMs,
    inputSteps: listArg(args, '--input-steps') ?? DEFAULT_PROBE_CONFIG.inputSteps,
    outputSteps: listArg(args, '--output-steps') ?? DEFAULT_PROBE_CONFIG.outputSteps,
    caps: {
      maxCalls: numberArg(args, '--max-calls') ?? DEFAULT_PROBE_CONFIG.caps.maxCalls,
      maxInputTokens:
        numberArg(args, '--max-input-tokens') ?? DEFAULT_PROBE_CONFIG.caps.maxInputTokens,
      maxOutputTokens:
        numberArg(args, '--max-output-tokens') ?? DEFAULT_PROBE_CONFIG.caps.maxOutputTokens,
      deadlineMs: numberArg(args, '--deadline-ms') ?? DEFAULT_PROBE_CONFIG.caps.deadlineMs,
    },
  };

  const group = pacerGroupFor(model);
  if (!group) throw new Error(`no pacer group for model ${model}`);

  const clock = new RealClock();
  void runProbe(config, {
    clock,
    fetch: globalThis.fetch,
    readApiKey: readApiKeyFromFile,
    readLiveUsage: createPacerUsageSource(
      globalThis.fetch,
      config.pacerUsageUrl,
      config.pacerTimeoutMs,
      group,
    ),
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.stopReason === 'completed' ? 0 : 2;
  });
}

main();

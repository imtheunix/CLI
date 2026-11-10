import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Caps {
  uncachedIn: number;
  out: number;
}

export interface GroupConfig {
  models: string[];
  caps: Caps;
}

export interface PacerConfig {
  host: string;
  port: number;
  upstream: string;
  apiKeyFile: string;
  apiKey?: string;
  headroom: number;
  maxWaitMs: number;
  maxRetries: number;
  pollMs: number;
  ledgerPath: string;
  ledgerMaxBytes: number;
  groups: Record<string, GroupConfig>;
}

export const DEFAULT_GROUPS: Record<string, GroupConfig> = {
  kimik31: {
    models: ['morph-kimik31'],
    caps: { uncachedIn: 72_870, out: 6_162 },
  },
  deepseek: {
    models: ['morph-dsv41flash', 'morph-dsv41flash-1017'],
    caps: { uncachedIn: 2_103_237, out: 76_559 },
  },
};

export const DEFAULT_CONFIG: PacerConfig = {
  host: '127.0.0.1',
  port: 8198,
  upstream: 'https://api.morphllm.com/v1',
  apiKeyFile: '~/.config/morph/api_key',
  headroom: 0.95,
  maxWaitMs: 120_000,
  maxRetries: 6,
  pollMs: 100,
  ledgerPath: '~/.local/state/morph-pacer/ledger.jsonl',
  ledgerMaxBytes: 50 * 1024 * 1024,
  groups: DEFAULT_GROUPS,
};

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function readJson(path: string): Partial<PacerConfig> {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text.length === 0) return {};
    return JSON.parse(text) as Partial<PacerConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function mergeGroups(
  overrides: Record<string, Partial<GroupConfig>> | undefined,
): Record<string, GroupConfig> {
  const merged: Record<string, GroupConfig> = {};
  for (const [key, defaults] of Object.entries(DEFAULT_GROUPS)) {
    const override = overrides?.[key];
    merged[key] = {
      models: override?.models ?? defaults.models,
      caps: { ...defaults.caps, ...(override?.caps ?? {}) },
    };
  }
  for (const [key, override] of Object.entries(overrides ?? {})) {
    if (merged[key]) continue;
    merged[key] = {
      models: override.models ?? [],
      caps: {
        uncachedIn: override.caps?.uncachedIn ?? Number.NaN,
        out: override.caps?.out ?? Number.NaN,
      },
    };
  }
  return merged;
}

function validateGroups(groups: Record<string, GroupConfig>): void {
  for (const [key, group] of Object.entries(groups)) {
    if (
      !Array.isArray(group.models) ||
      group.models.length === 0 ||
      group.models.some((model) => typeof model !== 'string' || model.length === 0)
    ) {
      throw new Error(`morph-pacer: group ${key} must have a non-empty models array`);
    }
    for (const cap of ['uncachedIn', 'out'] as const) {
      const value = group.caps?.[cap];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(
          `morph-pacer: group ${key} cap ${cap} must be a finite positive number`,
        );
      }
    }
  }
}

function validateUpstream(upstream: string): void {
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    throw new Error(`morph-pacer: upstream must be an absolute URL, got ${upstream}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `morph-pacer: upstream must use http or https, got ${parsed.protocol}`,
    );
  }
}

export function loadConfig(path = '~/.config/morph-pacer/config.json'): PacerConfig {
  const file = readJson(expandHome(path));
  const config: PacerConfig = {
    ...DEFAULT_CONFIG,
    ...file,
    groups: mergeGroups(file.groups as Record<string, Partial<GroupConfig>> | undefined),
  };

  if (process.env.MORPH_PACER_HOST) config.host = process.env.MORPH_PACER_HOST;
  if (process.env.MORPH_PACER_PORT) config.port = Number(process.env.MORPH_PACER_PORT);
  if (process.env.MORPH_PACER_UPSTREAM) config.upstream = process.env.MORPH_PACER_UPSTREAM;
  if (process.env.MORPH_PACER_API_KEY_FILE) config.apiKeyFile = process.env.MORPH_PACER_API_KEY_FILE;
  if (process.env.MORPH_PACER_LEDGER) config.ledgerPath = process.env.MORPH_PACER_LEDGER;
  if (process.env.MORPH_API_KEY) config.apiKey = process.env.MORPH_API_KEY;

  config.apiKeyFile = expandHome(config.apiKeyFile);
  config.ledgerPath = expandHome(config.ledgerPath);

  validateUpstream(config.upstream);
  validateGroups(config.groups);

  if (!config.apiKey) {
    try {
      config.apiKey = readFileSync(config.apiKeyFile, 'utf8').trim();
    } catch (error) {
      throw new Error(
        `morph-pacer: cannot read API key from ${config.apiKeyFile}: ${(error as Error).message}`,
      );
    }
  }
  if (!config.apiKey) {
    throw new Error(`morph-pacer: no API key in ${config.apiKeyFile}`);
  }

  return config;
}

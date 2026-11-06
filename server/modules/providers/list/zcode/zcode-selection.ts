import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectGlmQuotaReset } from '@/shared/glm-quota.js';
import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * ZCode provider: the plans a headless run may use, in order of preference.
 * Ids and models come from ZCode 0.17.1's zcode-builtin.json; the Weekend Build is its "Z.AI Idle plan".
 */
export const ZCODE_PLANS = [
  { providerId: 'account:zai-offpeak-idle-plan', label: 'Weekend Build', models: ['GLM-5.3-Flash', 'GLM-5.3'] },
  { providerId: 'account:zai-start-plan', label: 'Start Plan', models: ['GLM-5.3-Flash'] },
  { providerId: 'account:zai-individual-coding-plan', label: 'Coding Plan', models: ['GLM-5.3-Flash', 'GLM-5.3'] },
] as const;

export type ZcodePlan = (typeof ZCODE_PLANS)[number];

/** How long a plan is skipped after headless ZCode would not run it, or after an ordinary 429. */
const UNAVAILABLE_COOLDOWN_MS = 6 * 3_600_000;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

type PlanState = { until: string; reason: string; at: string };
type SelectionState = { plans: Record<string, PlanState>; sessions: Record<string, string> };

function statePath(): string {
  return path.join(os.homedir(), '.cloudcli', 'zcode', 'provider-state.json');
}

function configPath(): string {
  return path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readSelectionState(): SelectionState {
  try {
    const raw = readObjectRecord(JSON.parse(readFileSync(statePath(), 'utf8'))) ?? {};
    return { plans: readObjectRecord(raw.plans) ?? {}, sessions: readObjectRecord(raw.sessions) ?? {} } as SelectionState;
  } catch {
    return { plans: {}, sessions: {} };
  }
}

function updateSelectionState(change: (state: SelectionState) => void): void {
  const state = readSelectionState();
  change(state);
  writeAtomic(statePath(), JSON.stringify(state, null, 2) + '\n');
}

/** Records why a plan was passed over and until when it is skipped. */
export function recordPlanUnavailable(providerId: string, until: Date, reason: string, now: Date): void {
  updateSelectionState((state) => {
    state.plans[providerId] = { until: until.toISOString(), reason, at: now.toISOString() };
  });
}

/** Remembers which plan an app session's ZCode conversation runs on, so a resume asks for the same one. */
export function recordSessionPlan(appSessionId: string, providerId: string): void {
  updateSelectionState((state) => {
    state.sessions[appSessionId] = providerId;
    delete state.plans[providerId];
  });
}

/**
 * The plans to try for a model, best first. Plans in cooldown are skipped, except the last (the Coding Plan),
 * which is always tried so its own quota errors reach the orchestrator. A resumed session asks first for the
 * plan its conversation already runs on.
 */
export function planCandidates(model: string, now: Date, appSessionId?: string): ZcodePlan[] {
  const state = readSelectionState();
  const eligible = ZCODE_PLANS.filter((plan) => (plan.models as readonly string[]).includes(model));
  const open = eligible.filter((plan, index) => {
    if (index === eligible.length - 1) return true;
    const until = Date.parse(state.plans[plan.providerId]?.until ?? '');
    return !(Number.isFinite(until) && until > now.getTime());
  });
  const previous = appSessionId ? state.sessions[appSessionId] : undefined;
  const first = open.find((plan) => plan.providerId === previous);
  return first ? [first, ...open.filter((plan) => plan !== first)] : open;
}

/** Classifies a failed attempt's error text: Z.ai quota (1308/1310), an ordinary 429, or neither. */
export function classifyPlanFailure(text: string, now: Date): { until: Date; reason: string } | null {
  const quota = detectGlmQuotaReset(text, now);
  if (quota) return { until: quota, reason: 'quota exhausted (Z.ai 1308/1310)' };
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
    return { until: new Date(now.getTime() + RATE_LIMIT_COOLDOWN_MS), reason: 'rate limited (429)' };
  }
  return null;
}

export function unavailableUntil(now: Date): Date {
  return new Date(now.getTime() + UNAVAILABLE_COOLDOWN_MS);
}

let configLock: Promise<void> = Promise.resolve();

/**
 * Serializes ownership of ~/.zcode/v2/provider_config.json: the caller writes the run's selection and keeps
 * the lock until ZCode has read it (its first provider/model report) or exits, so concurrent jobs never start
 * on each other's selection. Returns the release function.
 */
export async function acquireZcodeConfigLock(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const previous = configLock;
  configLock = previous.then(() => held);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/** Writes the run's explicit selection as ZCode's default; headless `-p` reads it as its cli-default model. */
export function writeZcodeSelection(providerId: string, modelId: string, reasoningLevel: string): void {
  const file = configPath();
  let config: AnyRecord = {};
  if (existsSync(file)) {
    try { config = readObjectRecord(JSON.parse(readFileSync(file, 'utf8'))) ?? {}; } catch { config = {}; }
  }
  const inner = readObjectRecord(config.config) ?? {};
  const current = readObjectRecord(inner.defaultModelSelection) ?? {};
  // ZCode rejects a default without a supported reasoningLevel and silently falls back to its first visible model.
  const options = { ...(readObjectRecord(current.options) ?? {}), reasoningLevel };
  const updated = {
    schemaVersion: config.schemaVersion ?? 1,
    ...config,
    config: { ...inner, defaultModelSelection: { providerId, modelId, options } },
  };
  writeAtomic(file, JSON.stringify(updated, null, 2) + '\n');
}

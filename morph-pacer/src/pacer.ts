import type { Clock } from './clock.js';
import type { Caps, PacerConfig, TurnBudget } from './config.js';
import type { Logger } from './logger.js';
import { RollingWindow, type UsageEvent } from './windows.js';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface Admission {
  groupKey: string;
  model: string;
  reservationId: number;
  waitMs: number;
  reservedInput: number;
  reservedOutput: number;
}

interface Reservation {
  input: number;
  output: number;
}

export interface GroupUsageSnapshot {
  models: string[];
  window: { uncached_in: number; out: number };
  caps: { uncached_in: number; out: number };
  headroom: number;
  reservations: number;
  queue: number;
  rate_limits_last_hour: number;
}

interface GroupState {
  key: string;
  models: string[];
  caps: Caps;
  window: RollingWindow;
  reservations: Map<number, Reservation>;
  queueTail: Promise<void>;
  queueLength: number;
  rateLimits: number[];
}

const MIN_ESTIMATE = 256;
const MIN_INPUT_ESTIMATE = 512;
const COMPLETION_HISTORY = 50;
const RATE_LIMIT_WINDOW_MS = 3_600_000;

function sumReservations(state: GroupState, field: keyof Reservation): number {
  let total = 0;
  for (const value of state.reservations.values()) total += value[field];
  return total;
}

export function estimateInput(bodyBytes: number): number {
  return Math.max(MIN_INPUT_ESTIMATE, Math.ceil(Math.max(0, bodyBytes) / 4));
}

export class Pacer {
  private readonly groups = new Map<string, GroupState>();
  private readonly modelToGroup = new Map<string, string>();
  private readonly completions = new Map<string, number[]>();
  /** Recent uncached share of each model's prompts (uncached / prompt tokens), to discount cached context. */
  private readonly uncachedShares = new Map<string, number[]>();
  private nextReservationId = 1;

  constructor(
    private readonly config: PacerConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    for (const [key, group] of Object.entries(config.groups)) {
      this.groups.set(key, this.createGroup(key, group.models, group.caps));
      for (const model of group.models) this.modelToGroup.set(model, key);
    }
  }

  private createGroup(key: string, models: string[], caps: Caps): GroupState {
    return {
      key,
      models: [...models],
      caps,
      window: new RollingWindow(60_000),
      reservations: new Map(),
      queueTail: Promise.resolve(),
      queueLength: 0,
      rateLimits: [],
    };
  }

  private groupFor(model: string): GroupState {
    let key = this.modelToGroup.get(model);
    if (!key) {
      key = `model:${model}`;
      this.groups.set(
        key,
        this.createGroup(key, [model], {
          uncachedIn: Number.MAX_SAFE_INTEGER,
          out: Number.MAX_SAFE_INTEGER,
        }),
      );
      this.modelToGroup.set(model, key);
    }
    return this.groups.get(key) as GroupState;
  }

  /** The hard per-call budget for a model's group, or null when the group has none. */
  turnBudgetFor(model: string): TurnBudget | null {
    const key = this.modelToGroup.get(model);
    return key ? this.config.turnBudgets[key] ?? null : null;
  }

  estimateOutput(model: string): number {
    const values = this.completions.get(model) ?? [];
    if (values.length === 0) return MIN_ESTIMATE;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(sorted.length * 0.75) - 1);
    return Math.max(MIN_ESTIMATE, sorted[index]);
  }

  /**
   * Uncached input a request will likely cost: its prompt size discounted by the model's recent
   * uncached share (p75). Agent sessions resend a mostly cached context, so the raw body size
   * overstates the input that counts toward the cap many times over.
   */
  estimateUncachedInput(model: string, bodyBytes: number): number {
    const raw = estimateInput(bodyBytes);
    const shares = this.uncachedShares.get(model) ?? [];
    if (shares.length === 0) return raw;
    const sorted = [...shares].sort((a, b) => a - b);
    const share = sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)];
    return Math.max(MIN_INPUT_ESTIMATE, Math.ceil(raw * share));
  }

  async admit(model: string, bodyBytes = 0): Promise<Admission> {
    const state = this.groupFor(model);
    const previous = state.queueTail;
    let release!: () => void;
    state.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.queueLength += 1;
    await previous;

    const started = this.clock.now();
    try {
      // A single request larger than a cap still runs at Morph (only the next one waits), so an
      // estimate is clamped to the cap: an oversized request goes through on an empty window
      // instead of waiting out maxWaitMs every time.
      const estimatedOut = Math.min(this.estimateOutput(model), state.caps.out * this.config.headroom);
      const estimatedIn = Math.min(
        this.estimateUncachedInput(model, bodyBytes),
        state.caps.uncachedIn * this.config.headroom,
      );
      const deadline = started + this.config.maxWaitMs;

      for (;;) {
        const now = this.clock.now();
        const totals = state.window.totals(now);
        const reservedIn = sumReservations(state, 'input');
        const reservedOut = sumReservations(state, 'output');
        const inputLimit = state.caps.uncachedIn * this.config.headroom;
        const outLimit = state.caps.out * this.config.headroom;
        const strict = this.config.admission === 'strict';
        const inputOver = strict
          ? totals.uncachedIn + reservedIn + estimatedIn > inputLimit
          : totals.uncachedIn >= inputLimit;
        const outOver = strict
          ? totals.out + reservedOut + estimatedOut > outLimit
          : totals.out >= outLimit;

        if (!inputOver && !outOver) break;
        if (now >= deadline) {
          this.logger.warn(
            `morph-pacer: max wait reached for ${state.key}; forwarding anyway`,
          );
          break;
        }

        const wait = this.computeWait(
          state,
          now,
          strict ? estimatedIn : 0,
          strict ? estimatedOut : 0,
          inputOver,
          outOver,
          strict,
        );
        await this.clock.sleep(Math.max(1, Math.min(wait, deadline - now)));
      }

      const reservationId = this.nextReservationId++;
      state.reservations.set(reservationId, { input: estimatedIn, output: estimatedOut });
      return {
        groupKey: state.key,
        model,
        reservationId,
        waitMs: this.clock.now() - started,
        reservedInput: estimatedIn,
        reservedOutput: estimatedOut,
      };
    } finally {
      state.queueLength -= 1;
      release();
    }
  }

  private computeWait(
    state: GroupState,
    now: number,
    estimatedIn: number,
    estimatedOut: number,
    inputOver: boolean,
    outOver: boolean,
    strict = true,
  ): number {
    const totals = state.window.totals(now);
    const events = state.window.snapshot(now).sort((a, b) => a.t - b.t);
    const waits: number[] = [];

    if (inputOver) {
      const reservedIn = strict ? sumReservations(state, 'input') : 0;
      const limit = state.caps.uncachedIn * this.config.headroom;
      const available = limit - reservedIn - estimatedIn;
      if (available < 0) {
        waits.push(this.config.pollMs);
      } else {
        waits.push(
          this.decayWait(events, now, 'uncachedIn', totals.uncachedIn - available + 1),
        );
      }
    }

    if (outOver) {
      const reservedOut = strict ? sumReservations(state, 'output') : 0;
      const limit = state.caps.out * this.config.headroom;
      const available = limit - reservedOut - estimatedOut;
      if (available < 0) {
        waits.push(this.config.pollMs);
      } else {
        waits.push(this.decayWait(events, now, 'out', totals.out - available + 1));
      }
    }

    return Math.max(1, ...waits);
  }

  private decayWait(
    events: UsageEvent[],
    now: number,
    field: 'uncachedIn' | 'out',
    excess: number,
  ): number {
    let remaining = excess;
    for (const event of events) {
      remaining -= event[field];
      if (remaining <= 0) return Math.max(1, event.t + 60_000 - now + 1);
    }
    return this.config.pollMs;
  }

  complete(admission: Admission, usage: Usage | null, consumed = false): void {
    const state = this.groups.get(admission.groupKey);
    if (!state) return;
    const reservation = state.reservations.get(admission.reservationId);
    state.reservations.delete(admission.reservationId);

    if (usage) {
      const uncachedIn = Math.max(0, usage.promptTokens - usage.cachedTokens);
      state.window.add({ t: this.clock.now(), uncachedIn, out: usage.completionTokens });

      if (usage.promptTokens > 0) {
        const shares = this.uncachedShares.get(admission.model) ?? [];
        shares.push(uncachedIn / usage.promptTokens);
        if (shares.length > COMPLETION_HISTORY) shares.shift();
        this.uncachedShares.set(admission.model, shares);
      }

      const history = this.completions.get(admission.model) ?? [];
      history.push(usage.completionTokens);
      if (history.length > COMPLETION_HISTORY) history.shift();
      this.completions.set(admission.model, history);
      return;
    }

    if (consumed && reservation) {
      state.window.add({
        t: this.clock.now(),
        uncachedIn: reservation.input,
        out: reservation.output,
      });
    }
  }

  recordRateLimit(groupKey: string): void {
    const state = this.groups.get(groupKey);
    if (!state) return;
    const now = this.clock.now();
    state.rateLimits.push(now);
    state.rateLimits = state.rateLimits.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  }

  usageSnapshot(): { now: string; groups: Record<string, GroupUsageSnapshot> } {
    const now = this.clock.now();
    const groups: Record<string, GroupUsageSnapshot> = {};
    for (const [key, state] of this.groups) {
      const totals = state.window.totals(now);
      state.rateLimits = state.rateLimits.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
      groups[key] = {
        models: [...state.models],
        window: { uncached_in: totals.uncachedIn, out: totals.out },
        caps: { uncached_in: state.caps.uncachedIn, out: state.caps.out },
        headroom: this.config.headroom,
        reservations: sumReservations(state, 'output'),
        queue: state.queueLength,
        rate_limits_last_hour: state.rateLimits.length,
      };
    }
    return { now: new Date(now).toISOString(), groups };
  }
}

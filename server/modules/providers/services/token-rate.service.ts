/**
 * Measures a turn's output-token rate from the provider's own usage events.
 *
 * Providers report output tokens differently: Claude reports each assistant
 * message's own output, while Codex reports the turn's cumulative output once
 * at completion. The tracker keeps the turn's cumulative output and the time
 * since generation started, so both shapes produce the same rate. It never
 * estimates from characters and never divides by a zero or sub-250ms window.
 */

/** A measured output-token rate for one turn. */
export type TokenRate = {
  /** Output tokens per second over the turn's generation window. */
  outputTokensPerSecond: number;
  /** Cumulative output tokens the rate is based on. */
  outputTokens: number;
  /** Milliseconds from generation start to this sample. */
  elapsedMs: number;
};

/** A rate attached to a token budget, with whether it describes a live turn. */
export type TokenRateSample = TokenRate & { live: boolean };

/** Below this window a rate is noise, so the tracker reports none. */
const MIN_RATE_WINDOW_MS = 250;

/**
 * Tracks one turn's output tokens and generation time.
 *
 * Call `start` when generation begins, then feed each provider usage event:
 * `addOutputTokens` for a per-request count (Claude assistant messages) or
 * `setCumulativeOutputTokens` for a turn total (Codex `turn.completed`).
 * `reset` starts a new turn, including a resumed turn after background work.
 */
export class TurnTokenRateTracker {
  private startedAt: number | null = null;
  private outputTokens = 0;
  private lastRate: TokenRate | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Marks the start of generation; a second call in the same turn is ignored. */
  start(at = this.now()): void {
    if (this.startedAt === null) {
      this.startedAt = at;
    }
  }

  /** Clears the turn so the next `start` measures a fresh generation window. */
  reset(): void {
    this.startedAt = null;
    this.outputTokens = 0;
    this.lastRate = null;
  }

  /** Adds one request's output tokens and returns the turn's rate so far. */
  addOutputTokens(tokens: number, at = this.now()): TokenRate | null {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return this.lastRate;
    }
    this.outputTokens += tokens;
    return this.sample(at);
  }

  /** Sets the turn's cumulative output tokens and returns its rate so far. */
  setCumulativeOutputTokens(tokens: number, at = this.now()): TokenRate | null {
    if (!Number.isFinite(tokens) || tokens < 0) {
      return this.lastRate;
    }
    this.outputTokens = tokens;
    return this.sample(at);
  }

  private sample(at: number): TokenRate | null {
    if (this.startedAt === null) {
      this.startedAt = at;
    }
    const elapsedMs = at - this.startedAt;
    if (elapsedMs < MIN_RATE_WINDOW_MS || this.outputTokens <= 0) {
      return this.lastRate;
    }
    const outputTokensPerSecond = this.outputTokens / (elapsedMs / 1000);
    if (!Number.isFinite(outputTokensPerSecond)) {
      return this.lastRate;
    }
    this.lastRate = { outputTokensPerSecond, outputTokens: this.outputTokens, elapsedMs };
    return this.lastRate;
  }
}

/**
 * Attaches a measured rate to a token budget without changing its usage fields.
 * A null rate leaves the budget untouched, so an unavailable provider keeps the
 * composer's explicit em dash rather than a fabricated number.
 */
export function withTokenRate<T extends Record<string, unknown>>(
  budget: T,
  rate: TokenRate | null,
  live: boolean,
): T & { rate?: TokenRateSample } {
  if (!rate) {
    return budget;
  }
  return { ...budget, rate: { ...rate, live } };
}

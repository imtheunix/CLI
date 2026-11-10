/**
 * Minimum generation window before an output-token rate is reported.
 *
 * The first usage event of a turn can land a few milliseconds after the turn
 * starts. Dividing the tokens it reports by that window produces a meaningless
 * spike, so the rate stays unavailable until the turn has actually been
 * generating for a moment.
 */
export const MIN_OUTPUT_RATE_WINDOW_MS = 250;

/**
 * Measured output-token rate for a turn.
 *
 * `outputTokens` is the turn's cumulative output count (reasoning included only
 * when the provider's own usage meter counts it as output), and `startedAtMs`
 * is when the turn began generating. Returns null when there is nothing honest
 * to show: no tokens yet, no start time, a window too short to measure, or a
 * non-finite result. Callers must not substitute a character-count estimate or
 * a lifetime session average.
 */
export function computeOutputTokenRate(
  outputTokens: number,
  startedAtMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
    return null;
  }
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) {
    return null;
  }
  if (!Number.isFinite(nowMs)) {
    return null;
  }

  const elapsedMs = nowMs - startedAtMs;
  if (elapsedMs < MIN_OUTPUT_RATE_WINDOW_MS) {
    return null;
  }

  const rate = outputTokens / (elapsedMs / 1000);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Adds the measured rate to a token-budget payload when one is available.
 * The budget is returned unchanged when the window is too short or empty, so
 * the client never receives an invented number.
 */
export function withOutputTokenRate<T extends Record<string, unknown>>(
  budget: T,
  outputTokens: number,
  startedAtMs: number | null | undefined,
  nowMs: number,
): T {
  const rate = computeOutputTokenRate(outputTokens, startedAtMs, nowMs);
  return rate === null ? budget : { ...budget, outputTokensPerSecond: rate };
}

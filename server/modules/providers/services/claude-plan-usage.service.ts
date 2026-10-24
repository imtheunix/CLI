import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude plan-usage snapshot writer.
 *
 * The Plans page of the host's usage monitor (TRIPAM's plan_usage.py) reads
 * Claude subscription usage from the snapshot file Claude Code's status line
 * writes (~/.local/state/tripam-plan-usage/claude-statusline.json). The status
 * line only runs in an interactive terminal, so once every Claude session ran
 * inside this CLI through the Agent SDK the snapshot went stale. The SDK's
 * stream, however, carries `rate_limit_event` messages with the same windows,
 * so this service folds them into that snapshot and keeps it fresh while
 * sessions run here.
 *
 * The written shape is exactly the status line's:
 * `{"at": <ISO UTC now>, "rate_limits": {"five_hour": {"used_percentage":
 * 0..100, "resets_at": <epoch seconds>}, "seven_day": {...}}}` — an event
 * carries one window, so the other window already in the file is merged in,
 * and nothing beyond those two keys is ever written. No credentials, no
 * session content, no network: the numbers above are the whole payload.
 */

/** The only windows the status line snapshot format carries. */
const SNAPSHOT_WINDOWS = ['five_hour', 'seven_day'] as const;

type SnapshotWindowName = (typeof SNAPSHOT_WINDOWS)[number];

/** One window as the status line snapshot stores it (snake_case on purpose). */
type SnapshotWindow = {
  used_percentage: number;
  resets_at: number;
};

/**
 * One rate-limit window extracted from an SDK `rate_limit_event`, in the
 * snapshot's camelCase-free terms after conversion.
 */
export type ClaudePlanUsageWindowUpdate = {
  window: SnapshotWindowName;
  /** Percentage of the window used, 0..100 (integer, like the status line's). */
  usedPercentage: number;
  /** Epoch seconds the window resets at, or null when the event stated none. */
  resetsAt: number | null;
};

/**
 * Maps an SDK stream message to the plan-usage window it reports.
 *
 * Only `rate_limit_event` messages for the `five_hour` and `seven_day` windows
 * with a numeric `utilization` qualify — the SDK's other rateLimitType values
 * (`seven_day_opus`, `seven_day_sonnet`, `overage`) have no place in the
 * status line snapshot. `utilization` is a 0..1 fraction (the CLI's own status
 * line computes `Math.round(utilization * 100)` for `used_percentage`; values
 * above 1 occur while a limit is exceeded), so it is converted here and
 * clamped to keep the stored percentage within 0..100. `resetsAt` is epoch
 * seconds and may be missing; the snapshot write then falls back to the reset
 * time already stored for that window.
 *
 * Used by the providers module's claude runtime (which folds it into the
 * stream loop) and by its tests, which pin the mapping directly.
 *
 * @param message - SDK stream message of any shape
 * @returns The window update, or null when the message reports nothing usable
 */
export function mapClaudeRateLimitEvent(message: unknown): ClaudePlanUsageWindowUpdate | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'rate_limit_event') {
    return null;
  }
  const info = record.rate_limit_info;
  if (!info || typeof info !== 'object') {
    return null;
  }
  const rateLimitInfo = info as Record<string, unknown>;
  const window = rateLimitInfo.rateLimitType;
  if (window !== 'five_hour' && window !== 'seven_day') {
    return null;
  }
  const utilization = rateLimitInfo.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return null;
  }
  const resetsAt = rateLimitInfo.resetsAt;

  return {
    window,
    usedPercentage: Math.min(100, Math.max(0, Math.round(utilization * 100))),
    resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/**
 * Reads a window entry the status line format defines, or null for anything
 * else. Percentages outside 0..100 (possible in older snapshots) are clamped
 * so a rewrite can never perpetuate an out-of-range value.
 */
function readSnapshotWindow(value: unknown): SnapshotWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const used = record.used_percentage;
  const resetsAt = record.resets_at;
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    return null;
  }
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) {
    return null;
  }
  return {
    used_percentage: Math.min(100, Math.max(0, used)),
    resets_at: resetsAt,
  };
}

/**
 * Where the snapshot lives: the `PLAN_USAGE_CLAUDE_STATUSLINE` override the
 * usage monitor's collector itself reads, else the status line's own default.
 */
function resolveSnapshotFilePath(explicitPath?: string): string {
  return explicitPath
    || process.env.PLAN_USAGE_CLAUDE_STATUSLINE
    || path.join(os.homedir(), '.local', 'state', 'tripam-plan-usage', 'claude-statusline.json');
}

/**
 * Merges one window update into the snapshot file, status-line style.
 *
 * The other window already in the file is kept; only `five_hour` and
 * `seven_day` survive the merge, and the write is atomic (temp file in the
 * same directory + rename) with mode 0600 inside a 0700 directory, exactly
 * like the status line script's own writes. An update whose window has no
 * reset time — neither in the event nor already in the file — is skipped:
 * the snapshot format has no way to express a window without one.
 *
 * Used by `rememberClaudeRateLimit` below and by the providers module's
 * tests, which pin the merge and the atomic write directly.
 *
 * @param update - Window update from `mapClaudeRateLimitEvent`
 * @param options - `filePath` overrides the resolved snapshot path (tests)
 * @returns Resolves when the snapshot holds the merged windows
 */
export async function writeClaudePlanUsageSnapshot(
  update: ClaudePlanUsageWindowUpdate,
  options: { filePath?: string } = {},
): Promise<void> {
  const filePath = resolveSnapshotFilePath(options.filePath);
  const directory = path.dirname(filePath);

  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });

  let stored: { rate_limits?: unknown } = {};
  try {
    stored = JSON.parse(await fsp.readFile(filePath, 'utf8')) as { rate_limits?: unknown };
  } catch {
    // No snapshot yet, or not JSON: start from empty, like a first status-line write.
  }
  const storedLimits = stored?.rate_limits;
  const existing = (storedLimits && typeof storedLimits === 'object'
    ? storedLimits
    : {}) as Record<string, unknown>;

  const windows: Partial<Record<SnapshotWindowName, SnapshotWindow>> = {};
  for (const name of SNAPSHOT_WINDOWS) {
    const window = name === update.window
      ? {
          used_percentage: update.usedPercentage,
          resets_at: update.resetsAt ?? readSnapshotWindow(existing[name])?.resets_at,
        }
      : readSnapshotWindow(existing[name]);
    if (window && typeof window.resets_at === 'number') {
      windows[name] = window as SnapshotWindow;
    }
  }
  if (!windows[update.window]) {
    // The update's window ended up unrepresentable (no reset time anywhere).
    return;
  }

  const payload = JSON.stringify({ at: new Date().toISOString(), rate_limits: windows });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tempPath, payload, { mode: 0o600 });
    // chmod on top of the mode above: open(2) applies the process umask, the
    // snapshot's privacy guarantee must not depend on it.
    await fsp.chmod(tempPath, 0o600);
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Guards the "log a snapshot write failure once" promise across the process. */
let writeFailureLogged = false;
/** Serializes writes so two sessions' events cannot interleave read-modify-write. */
let pendingSnapshotWrite: Promise<void> = Promise.resolve();

/**
 * Folds one SDK stream message into the plan-usage snapshot, fire and forget.
 *
 * The claude runtime calls this for every stream message; non-`rate_limit_event`
 * messages cost one type check. The write runs in the background and a failure
 * is logged once per process — a stale snapshot must never break a run.
 *
 * Used by the providers module's claude runtime and its tests.
 *
 * @param message - SDK stream message of any shape
 */
export function rememberClaudeRateLimit(message: unknown): void {
  const update = mapClaudeRateLimitEvent(message);
  if (!update) {
    return;
  }
  pendingSnapshotWrite = pendingSnapshotWrite
    .then(() => writeClaudePlanUsageSnapshot(update))
    .catch((error: unknown) => {
      if (!writeFailureLogged) {
        writeFailureLogged = true;
        console.error(
          '[Claude plan usage] Failed to update the plan usage snapshot:',
          error instanceof Error ? error.message : error,
        );
      }
    });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appConfigDb,
  getConnection,
  orchestratorJobsDb,
  runningTurnsDb,
  sessionsDb,
  userDb,
  type OrchestratorBackend,
  type OrchestratorJobRow,
  type SessionRow,
} from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError, getZcodeTranscriptPath } from '@/shared/index.js';

import {
  appendHubEvent,
  getHubEventsLogPath,
  isLiveHubEventsLogPath,
  isLiveHubProcess,
  onHubEvent,
} from './hub-events.service.js';
import type { HubEventState } from './hub-events.service.js';
import { getEffectOutbox } from './effect-outbox.service.js';
import type { EffectOutbox } from './effect-outbox.service.js';
import { DEFAULT_WAKE_ABANDON_MS } from './orchestrator-config.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';

/** Maximum number of event lines shown in a wake turn before truncating with `+N more`. */
const MAX_WAKE_LINES = 20;

/** Length of title before truncating in notification lines. */
const MAX_TITLE_LENGTH = 50;

/** Maximum bytes to read in one log file read chunk. */
const MAX_READ_CHUNK = 64 * 1024;

/** Upper bound on in-memory pending events buffer to prevent memory exhaustion. */
const MAX_PENDING_EVENTS = 500;

/** Simple async FIFO lock to serialize log reads and wake dispatches. */
class AsyncLock {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    };
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

/** Parsed single-line event from hub-events.log. */
export type LoggedHubEvent = {
  timestamp: string;
  jobId: string;
  state: HubEventState;
  title: string;
  reason: string;
};

/** Used by HubWakeService and tests to parse a tab-separated line from hub-events.log. */
export function parseHubEventLine(line: string): LoggedHubEvent | null {
  const parts = line.split('\t');
  if (parts.length < 5) return null;
  const [timestamp, jobId, state, title, reason] = parts;
  return {
    timestamp: timestamp.trim(),
    jobId: jobId.trim(),
    state: state.trim() as HubEventState,
    title: title.trim(),
    reason: reason.trim(),
  };
}

/** Formats the status description portion of a hub wake event line. */
export function formatHubEventStateDescription(event: LoggedHubEvent): string {
  switch (event.state) {
    case 'review':
      return event.reason === 'waiting for review' ? 'done, waiting for review' : `done, ${event.reason}`;
    case 'turn_ended':
      if (event.reason.includes('without tjob done')) {
        return `waiting, ${event.reason}`;
      }
      return `failed, ${event.reason}`;
    case 'blocked':
      return `blocked, ${event.reason}`;
    case 'merge_failed':
      return `merge failed, ${event.reason}`;
    case 'merged':
      return `merged, ${event.reason}`;
    case 'stalled':
      return `stalled, ${event.reason}`;
    default:
      return `${event.state}, ${event.reason}`;
  }
}

/** Formats a single event line for delivery to the hub session. */
export function formatHubEventLine(event: LoggedHubEvent): string {
  const shortTitle = event.title.length > MAX_TITLE_LENGTH
    ? `${event.title.slice(0, MAX_TITLE_LENGTH - 3)}...`
    : event.title;
  const desc = formatHubEventStateDescription(event);
  return `[tjob] ${event.jobId} ${shortTitle}: ${desc}`;
}

/** A logged event waiting for delivery, with the log byte offset just past its line. */
type PendingHubEvent = LoggedHubEvent & { endOffset: number };

/** Outcome of handing a wake message to the hub session. */
type DeliveryOutcome = 'started' | 'refused' | 'pending';

/** Builds the consolidated wake turn text from a list of logged events (newest last). */
export function buildHubWakeMessage(events: LoggedHubEvent[]): string {
  const displayEvents = events.slice(0, MAX_WAKE_LINES);
  const lines = displayEvents.map(formatHubEventLine);
  if (events.length > MAX_WAKE_LINES) {
    lines.push(`+${events.length - MAX_WAKE_LINES} more`);
  }
  return lines.join('\n');
}

/** Dependencies injected into createHubWakeService. */
export type HubWakeDependencies = {
  config: () => OrchestratorConfig;
  runtime: ProviderRuntimeGateway;
  now?: () => Date;
  eventsLogPath?: string;
  offsetPath?: string;
  stallsPath?: string;
  turnTimeoutMs?: number;
  /** The test sink: under test, a wake is delivered only through an injected runTurn or an isolated DB and log. */
  runTurn?: typeof runDetachedChatTurn;
  /** The durable effect outbox; defaults to this process's. */
  outbox?: EffectOutbox;
  /** Optional directory for zcode transcripts (defaults to ~/.cloudcli/zcode). */
  zcodeTranscriptsDir?: string;
  /** Optional hook to check if zcode child process is alive. */
  isZcodeProcessAlive?: (sessionId: string) => boolean;
};

/**
 * Determines whether an orchestrator job is running on the ZCode backend.
 * Consuming files: hub-wake.service.ts, hub-wake.service.test.ts.
 */
export function isZcodeJob(
  job: OrchestratorJobRow,
  session?: SessionRow | null,
  cfg?: OrchestratorConfig,
): boolean {
  if (job.backend === 'zcode' || job.requested_backend === 'zcode') return true;
  if (session?.provider === 'zcode') return true;
  if (job.backend && cfg?.backends?.[job.backend as OrchestratorBackend]?.provider === 'zcode') return true;
  if (job.backend === 'glm' && (cfg?.glmProvider === 'zcode' || cfg?.backends?.glm?.provider === 'zcode' || !cfg?.backends?.glm)) return true;
  return false;
}

/**
 * Why a wake must not be delivered from this process, or null when it may. Outside the
 * live server (see isLiveHubProcess: any test, run by the runner or directly, or another
 * process that inherited the server's environment) a wake reaches the chat path only
 * through an injected runTurn, or when both the database (DATABASE_PATH) and the events
 * log are temporary ones: the live database holds the real hub session.
 */
export function hubWakeTestGuard(deps: Pick<HubWakeDependencies, 'runTurn' | 'eventsLogPath'>): string | null {
  if (isLiveHubProcess() || deps.runTurn) return null;
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath || !isInTempDirectory(databasePath)) return 'not the live server, without an isolated DATABASE_PATH';
  if (isLiveHubEventsLogPath(resolveEventsLogPath(deps))) return 'not the live server, with the live hub events log';
  return null;
}

function isInTempDirectory(file: string): boolean {
  const resolved = path.resolve(file);
  const roots = new Set([path.resolve(os.tmpdir())]);
  try {
    roots.add(fs.realpathSync(os.tmpdir()));
  } catch {
    // tmpdir missing: the unresolved root only
  }
  return [...roots].some((root) => resolved.startsWith(root + path.sep));
}

function resolveEventsLogPath(deps: Pick<HubWakeDependencies, 'eventsLogPath'>): string {
  return deps.eventsLogPath ?? getHubEventsLogPath();
}

function resolveOffsetPath(deps: HubWakeDependencies, logPath: string): string {
  return deps.offsetPath ?? `${logPath}.offset`;
}

function resolveStallsPath(deps: HubWakeDependencies, logPath: string): string {
  return deps.stallsPath ?? `${logPath}.stalls.json`;
}

function firstUserId(): number | null {
  const user = userDb.getFirstUser() as { id?: number } | null | undefined;
  return typeof user?.id === 'number' ? user.id : null;
}

/**
 * Used by OrchestratorModule: monitors hub events and active job transcript stalls,
 * coalescing and delivering notifications directly to the hub session via chat turns
 * without polling processes.
 */
export function createHubWakeService(deps: HubWakeDependencies) {
  const now = deps.now ?? (() => new Date());
  const outbox = deps.outbox ?? getEffectOutbox();
  const lock = new AsyncLock();
  let unsubscribeEvents: (() => void) | null = null;

  let storedOffset: number | null = null;
  let targetEndOffset = 0;
  let pendingEvents: PendingHubEvent[] = [];
  /**
   * The wake turn handed to the chat path and not yet reserved or refused. A
   * turn can stay undecided past the start timeout (runDetachedChatTurn waits
   * for the hub's previous provider run to settle) and still start later, so
   * the hub counts as busy until the turn decides, or until it is abandoned
   * after hub.wakeAbandonMs so a turn that never decides cannot silence the hub.
   */
  let wakeInFlight: number | null = null;
  let wakeSequence = 0;
  /** Bumped when the log is truncated, so a late commit for the old log is ignored. */
  let logGeneration = 0;
  let firstEventTimeMs: number | null = null;
  let lastEventTimeMs = 0;

  const lastStallEmitted = new Map<string, number>();
  const lastZcodeStats = new Map<string, { size: number; mtimeMs: number; lastActivityMs: number }>();
  let stallsLoaded = false;

  function getOffsetPath(): string {
    return resolveOffsetPath(deps, resolveEventsLogPath(deps));
  }

  function getStallsPath(): string {
    return resolveStallsPath(deps, resolveEventsLogPath(deps));
  }

  function loadStoredOffset(): number {
    const offsetFile = getOffsetPath();
    try {
      if (fs.existsSync(offsetFile)) {
        const content = fs.readFileSync(offsetFile, 'utf8').trim();
        const num = parseInt(content, 10);
        if (Number.isFinite(num) && num >= 0) return num;
      }
    } catch {}
    try {
      const val = appConfigDb.get('orchestrator.hub_wake_offset');
      if (val) {
        const num = parseInt(val, 10);
        if (Number.isFinite(num) && num >= 0) return num;
      }
    } catch {}
    return 0;
  }

  function saveStoredOffset(offset: number): void {
    const offsetFile = getOffsetPath();
    try {
      fs.mkdirSync(path.dirname(offsetFile), { recursive: true });
      fs.writeFileSync(offsetFile, String(offset), 'utf8');
    } catch (err) {
      console.error('[HubWake] Failed to persist offset file:', err);
    }
    try {
      appConfigDb.set('orchestrator.hub_wake_offset', String(offset));
    } catch {}
    storedOffset = offset;
  }

  /**
   * Marks every event up to `offset` as delivered: persists the offset (never
   * backwards) and drops those events from the pending buffer. Called the moment
   * a wake turn is reserved, before the provider receives the message, so a
   * delivered event is never offered again, not even after a restart.
   */
  function commitDelivered(offset: number, generation: number): void {
    if (generation !== logGeneration) return;
    if (storedOffset === null || offset > storedOffset) {
      saveStoredOffset(offset);
    }
    pendingEvents = pendingEvents.filter((event) => event.endOffset > offset);
    if (pendingEvents.length === 0) {
      firstEventTimeMs = null;
      lastEventTimeMs = 0;
    } else {
      firstEventTimeMs = lastEventTimeMs;
    }
  }

  function ensureStallsLoaded(): void {
    if (stallsLoaded) return;
    stallsLoaded = true;

    // 1. Load from file
    const stallsFile = getStallsPath();
    try {
      if (fs.existsSync(stallsFile)) {
        const content = fs.readFileSync(stallsFile, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'number' && Number.isFinite(v)) {
              lastStallEmitted.set(k, v);
            }
          }
        }
      }
    } catch {}

    // 2. Load from appConfigDb
    try {
      const raw = appConfigDb.get('orchestrator.hub_wake_stalls');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'number' && Number.isFinite(v) && !lastStallEmitted.has(k)) {
              lastStallEmitted.set(k, v);
            }
          }
        }
      }
    } catch {}

    // 3. Supplement / reconstruct from hub-events.log
    const logPath = resolveEventsLogPath(deps);
    try {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (!line.includes('\tstalled\t')) continue;
          const parsed = parseHubEventLine(line);
          if (parsed && parsed.state === 'stalled') {
            const timeMs = Date.parse(parsed.timestamp);
            if (Number.isFinite(timeMs)) {
              const current = lastStallEmitted.get(parsed.jobId) ?? 0;
              if (timeMs > current) {
                lastStallEmitted.set(parsed.jobId, timeMs);
              }
            }
          }
        }
      }
    } catch {}
  }

  function saveStallsState(): void {
    const stallsFile = getStallsPath();
    const data: Record<string, number> = {};
    for (const [k, v] of lastStallEmitted.entries()) {
      data[k] = v;
    }
    const json = JSON.stringify(data);
    try {
      fs.mkdirSync(path.dirname(stallsFile), { recursive: true });
      fs.writeFileSync(stallsFile, json, 'utf8');
    } catch (err) {
      console.error('[HubWake] Failed to persist stalls file:', err);
    }
    try {
      appConfigDb.set('orchestrator.hub_wake_stalls', json);
    } catch {}
  }

  /** Reads unread events from hub-events.log starting at the stored offset. */
  function readPendingEvents(): void {
    const logPath = resolveEventsLogPath(deps);
    if (storedOffset === null) {
      storedOffset = loadStoredOffset();
      targetEndOffset = storedOffset;
    }

    if (!fs.existsSync(logPath)) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(logPath);
    } catch {
      return;
    }

    if (stat.size < targetEndOffset || (storedOffset !== null && stat.size < storedOffset)) {
      // File was truncated or reset/rotated
      logGeneration += 1;
      storedOffset = 0;
      targetEndOffset = 0;
      pendingEvents = [];
      firstEventTimeMs = null;
      lastEventTimeMs = 0;
      saveStoredOffset(0);
    }

    if (stat.size <= targetEndOffset) {
      return;
    }

    const cfg = deps.config();
    const hubSessionId = cfg.hub?.sessionId;
    let newlyAdded = 0;

    while (stat.size > targetEndOffset) {
      const bytesToRead = Math.min(stat.size - targetEndOffset, MAX_READ_CHUNK);
      const buffer = Buffer.alloc(bytesToRead);
      let bytesRead = 0;
      try {
        const fd = fs.openSync(logPath, 'r');
        try {
          bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, targetEndOffset);
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        console.error('[HubWake] Error reading hub events log:', err);
        return;
      }

      if (bytesRead === 0) break;

      // Locate complete lines using raw newline bytes (0x0A) to ensure byte alignment
      const lastNewlineByteIndex = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNewlineByteIndex === -1) {
        // Incomplete line; wait for newline to be appended
        break;
      }

      const chunkStart = targetEndOffset;
      targetEndOffset += lastNewlineByteIndex + 1;

      let lineStart = 0;
      while (lineStart <= lastNewlineByteIndex) {
        const lineEnd = buffer.indexOf(0x0a, lineStart);
        const line = buffer.toString('utf8', lineStart, lineEnd);
        const endOffset = chunkStart + lineEnd + 1;
        lineStart = lineEnd + 1;
        if (!line.trim()) continue;
        const parsed = parseHubEventLine(line);
        if (!parsed) continue;
        // Do not generate or forward events originated by the hub session itself
        if (hubSessionId && parsed.jobId === hubSessionId) continue;
        pendingEvents.push({ ...parsed, endOffset });
        newlyAdded += 1;

        const eventTime = Date.parse(parsed.timestamp);
        const effectiveTime = Number.isFinite(eventTime) ? eventTime : now().getTime();
        if (firstEventTimeMs === null || effectiveTime < firstEventTimeMs) {
          firstEventTimeMs = effectiveTime;
        }
        if (effectiveTime > lastEventTimeMs) {
          lastEventTimeMs = effectiveTime;
        }
      }
    }

    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS);
    }
  }

  /**
   * Checks whether the user is actively typing in the UI composer for the hub session,
   * as evidenced by an uncommitted draft saved within the last 60 seconds.
   */
  function isUserTyping(sessionId: string, nowMs: number): boolean {
    try {
      const db = getConnection();
      const row = db.prepare(
        'SELECT draft_text, updated_at FROM session_drafts WHERE draft_scope = ?'
      ).get(sessionId) as { draft_text?: string; updated_at?: string } | undefined;
      if (!row || !row.draft_text || !row.draft_text.trim()) {
        return false;
      }
      if (!row.updated_at) return false;
      const raw = row.updated_at;
      const updatedAtMs = Date.parse(raw.includes('Z') ? raw : `${raw.replace(' ', 'T')}Z`);
      if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < 60_000) {
        return true;
      }
    } catch {
      // session_drafts table not ready or query error
    }
    return false;
  }

  /**
   * True if the hub session is busy with an in-flight run, has background work,
   * a wake turn is currently in flight, or the person was typing in the last 60 seconds.
   */
  function isHubBusy(sessionId: string, nowMs: number): boolean {
    if (wakeInFlight !== null) return true;
    if (chatRunRegistry.isProcessing(sessionId)) return true;
    if (deps.runtime.hasBackgroundWork?.(sessionId)) return true;
    if (isUserTyping(sessionId, nowMs)) return true;
    return false;
  }

  /** Checks active jobs for stall conditions (no transcript activity for stallMin minutes). */
  function checkStalls(nowMs: number): void {
    const cfg = deps.config();
    if (!cfg.hub?.wake || !cfg.hub.sessionId) return;
    const stallMin = cfg.hub.stallMin ?? 30;
    const stallMs = stallMin * 60_000;

    ensureStallsLoaded();

    const activeJobs = orchestratorJobsDb.listByState(['active']);
    const activeJobIds = new Set(activeJobs.map((j) => j.id));

    // Prune entries for jobs that are no longer active to prevent unbounded memory growth
    let pruned = false;
    for (const jobId of lastStallEmitted.keys()) {
      if (!activeJobIds.has(jobId)) {
        lastStallEmitted.delete(jobId);
        pruned = true;
      }
    }
    for (const jobId of lastZcodeStats.keys()) {
      if (!activeJobIds.has(jobId)) {
        lastZcodeStats.delete(jobId);
      }
    }
    if (pruned) {
      saveStallsState();
    }

    for (const job of activeJobs) {
      if (!job.session_id) continue;
      const isWorking = chatRunRegistry.isProcessing(job.session_id) || Boolean(job.in_turn);
      if (!isWorking) {
        if (lastStallEmitted.has(job.id)) {
          lastStallEmitted.delete(job.id);
          saveStallsState();
        }
        lastZcodeStats.delete(job.id);
        continue;
      }

      let lastActivityMs = 0;

      // 1. Session jsonl transcript mtime / activity
      const session = sessionsDb.getSessionById(job.session_id);
      const isZcode = isZcodeJob(job, session, cfg);

      if (isZcode) {
        let isProcessAlive = true;
        if (typeof deps.isZcodeProcessAlive === 'function') {
          isProcessAlive = deps.isZcodeProcessAlive(job.session_id);
        } else if (typeof deps.runtime.isProcessAlive === 'function') {
          isProcessAlive = deps.runtime.isProcessAlive(job.session_id);
        }

        const zcodeDir = deps.zcodeTranscriptsDir ?? process.env.ZCODE_TRANSCRIPTS_DIR;
        const defaultZcodePath = zcodeDir
          ? path.join(zcodeDir, `${encodeURIComponent(job.session_id)}.jsonl`)
          : getZcodeTranscriptPath(job.session_id);
        const candidatePaths = [
          defaultZcodePath,
          ...(session?.jsonl_path && session.jsonl_path !== defaultZcodePath ? [session.jsonl_path] : []),
        ];

        for (const transcriptPath of candidatePaths) {
          try {
            if (fs.existsSync(transcriptPath)) {
              const stat = fs.statSync(transcriptPath);
              if (stat.mtimeMs > lastActivityMs) {
                lastActivityMs = stat.mtimeMs;
              }

              const prevStats = lastZcodeStats.get(job.id);
              if (prevStats) {
                if (stat.size !== prevStats.size || stat.mtimeMs > prevStats.mtimeMs) {
                  if (isProcessAlive) {
                    lastActivityMs = Math.max(lastActivityMs, stat.mtimeMs, nowMs);
                    lastZcodeStats.set(job.id, { size: stat.size, mtimeMs: stat.mtimeMs, lastActivityMs });
                  } else {
                    lastZcodeStats.set(job.id, { size: stat.size, mtimeMs: stat.mtimeMs, lastActivityMs: prevStats.lastActivityMs });
                  }
                } else {
                  if (prevStats.lastActivityMs > lastActivityMs) {
                    lastActivityMs = prevStats.lastActivityMs;
                  }
                }
              } else {
                lastZcodeStats.set(job.id, { size: stat.size, mtimeMs: stat.mtimeMs, lastActivityMs });
              }
              break;
            }
          } catch {}
        }
      } else {
        // Keep Claude/Codex/agy behavior unchanged
        if (session?.jsonl_path) {
          try {
            if (fs.existsSync(session.jsonl_path)) {
              const stat = fs.statSync(session.jsonl_path);
              if (stat.mtimeMs > lastActivityMs) lastActivityMs = stat.mtimeMs;
            }
          } catch {}
        }
      }

      // 2. Detached turn log mtime & start time
      const runningTurn = runningTurnsDb.getRunningTurnBySession(job.session_id);
      if (runningTurn?.log_path) {
        try {
          if (fs.existsSync(runningTurn.log_path)) {
            const stat = fs.statSync(runningTurn.log_path);
            if (stat.mtimeMs > lastActivityMs) lastActivityMs = stat.mtimeMs;
          }
        } catch {}
      }
      if (runningTurn?.started_at) {
        const startedMs = Date.parse(runningTurn.started_at);
        if (Number.isFinite(startedMs) && startedMs > lastActivityMs) {
          lastActivityMs = startedMs;
        }
      }

      // 3. Live chat run start time
      const run = chatRunRegistry.getRun(job.session_id);
      if (run?.startedAt && run.startedAt > lastActivityMs) {
        lastActivityMs = run.startedAt;
      }

      // 4. Job updated_at timestamp
      if (job.updated_at) {
        const updatedMs = Date.parse(job.updated_at.includes('Z') ? job.updated_at : `${job.updated_at.replace(' ', 'T')}Z`);
        if (Number.isFinite(updatedMs) && updatedMs > lastActivityMs) {
          lastActivityMs = updatedMs;
        }
      }

      if (lastActivityMs === 0) {
        lastActivityMs = nowMs;
      }

      if (nowMs - lastActivityMs >= stallMs) {
        const lastEmitted = lastStallEmitted.get(job.id);
        if (!lastEmitted || lastActivityMs > lastEmitted) {
          appendHubEvent({
            jobId: job.id,
            state: 'stalled',
            title: job.title,
            reason: `no transcript activity for ${stallMin}m`,
          });
          lastStallEmitted.set(job.id, nowMs);
          saveStallsState();
        }
      } else {
        if (lastStallEmitted.has(job.id)) {
          lastStallEmitted.delete(job.id);
          saveStallsState();
        }
      }
    }
  }

  /**
   * Delivers a message to the hub session as a normal turn.
   *
   * `commitOffset` (with the log generation it belongs to) is committed the
   * moment the turn is reserved, before the provider sees the message. Resolves
   * 'started' or 'refused' once the turn decides, or 'pending' when it is still
   * undecided after the start timeout: the wake then stays in flight (the hub
   * counts as busy) and commits or releases itself when the turn decides, so the
   * same events are never handed to a second turn while the first may still start.
   */
  async function deliverMessage(
    hubSessionId: string,
    message: string,
    commit: { offset: number; generation: number; eventCount: number } | null,
  ): Promise<DeliveryOutcome> {
    const refusal = hubWakeTestGuard(deps);
    if (refusal) {
      console.error(`[HubWake] Refusing to wake hub session "${hubSessionId}" ${refusal}.`);
      return 'refused';
    }
    const session = sessionsDb.getSessionById(hubSessionId);
    if (!session) {
      console.warn(`[HubWake] Hub session "${hubSessionId}" not found in database.`);
      return 'refused';
    }

    // Recorded before the turn (process-bound: a wake cut by a restart is dropped, its events were not
    // committed and go out again). Done when reserved: the same events reach the hub at most once.
    const effectKey = commit ? `hub-wake:${hubSessionId}:${commit.generation}:${commit.offset}` : null;
    if (effectKey && commit) {
      const begun = outbox.begin({ key: effectKey, jobId: null, kind: 'hub_wake', replay: 'process_bound', payload: { hubSessionId, eventCount: commit.eventCount } });
      if (begun.status === 'skipped') {
        if (begun.reason !== 'done') return 'refused';
        commitDelivered(commit.offset, commit.generation);
        return 'started';
      }
    }

    const options: Record<string, unknown> = {
      permissionMode: 'bypassPermissions',
    };
    if (session.model) options.model = session.model;
    if (session.effort) options.effort = session.effort;

    const wakeId = ++wakeSequence;
    wakeInFlight = wakeId;
    let decided = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    let abandonTimer: NodeJS.Timeout | null = null;
    let resolveOutcome!: (outcome: DeliveryOutcome) => void;
    const outcome = new Promise<DeliveryOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const decide = (started: boolean) => {
      if (decided) return;
      decided = true;
      if (timer) clearTimeout(timer);
      if (abandonTimer) clearTimeout(abandonTimer);
      // Safe after abandonment too: the commit only moves the offset forward and
      // drops pending events up to this wake's offset, which this turn delivered;
      // events a newer wake reserved were already committed past that offset.
      if (started && commit) commitDelivered(commit.offset, commit.generation);
      if (effectKey) outbox.finish(effectKey, started ? { ok: true } : { ok: false, error: 'the wake turn was refused' });
      if (wakeInFlight === wakeId) wakeInFlight = null;
      if (timedOut) {
        console.warn(`[HubWake] Wake turn #${wakeId} ${started ? 'started' : 'was refused'} after the start timeout.`);
      }
      resolveOutcome(started ? 'started' : 'refused');
    };

    const timeoutMs = deps.turnTimeoutMs ?? 5_000;
    timer = setTimeout(() => {
      timer = null;
      if (decided) return;
      timedOut = true;
      resolveOutcome('pending');
    }, timeoutMs);

    const abandonMs = deps.config().hub?.wakeAbandonMs ?? DEFAULT_WAKE_ABANDON_MS;
    abandonTimer = setTimeout(() => {
      abandonTimer = null;
      if (decided || wakeInFlight !== wakeId) return;
      // Release the hub: the events were never committed, so the next tick
      // offers them again. A rare duplicate is cheaper than a silent hub.
      wakeInFlight = null;
      if (effectKey) outbox.finish(effectKey, { ok: false, error: 'abandoned while undecided; events released' });
      console.warn(
        `[HubWake] Abandoned wake turn #${wakeId} (${commit?.eventCount ?? 0} events) still undecided after ${abandonMs} ms; its events are released for redelivery.`,
      );
    }, abandonMs);
    abandonTimer.unref?.();

    const runTurn = deps.runTurn ?? runDetachedChatTurn;
    let turn: ReturnType<typeof runDetachedChatTurn>;
    try {
      turn = runTurn(
        {
          sessionId: hubSessionId,
          userId: firstUserId(),
          content: message,
          options,
          onReserved: () => decide(true),
        },
        { runtime: deps.runtime },
      );
    } catch (err) {
      console.error('[HubWake] Detached chat turn execution error:', err);
      decide(false);
      return outcome;
    }

    turn
      .then((result) => decide(Boolean(result?.started)))
      .catch((err) => {
        console.error('[HubWake] Detached chat turn execution error:', err);
        decide(false);
      });

    return outcome;
  }

  /** Delivers all coalesced pending events if debounce has elapsed and the hub session is idle. */
  async function flushPendingIfEligible(): Promise<boolean> {
    return lock.runExclusive(async () => {
      const cfg = deps.config();
      if (!cfg.hub?.wake || !cfg.hub.sessionId) {
        return false;
      }
      readPendingEvents();
      if (pendingEvents.length === 0) {
        return false;
      }

      const session = sessionsDb.getSessionById(cfg.hub.sessionId);
      if (!session) {
        // Hub session does not exist. Reset debounce timers to prevent tight loop.
        firstEventTimeMs = null;
        lastEventTimeMs = 0;
        return false;
      }

      const nowMs = now().getTime();
      const debounceSec = cfg.hub.debounceSec ?? 90;
      const debounceMs = debounceSec * 1000;

      // Must wait for quiet debounce period or max coalescing window
      if (firstEventTimeMs !== null) {
        const timeSinceLast = nowMs - lastEventTimeMs;
        const timeSinceFirst = nowMs - firstEventTimeMs;
        if (timeSinceLast < debounceMs && timeSinceFirst < debounceMs * 2) {
          return false;
        }
      }

      if (isHubBusy(cfg.hub.sessionId, nowMs)) {
        return false;
      }

      const message = buildHubWakeMessage(pendingEvents);
      const commit = { offset: targetEndOffset, generation: logGeneration, eventCount: pendingEvents.length };

      const outcome = await deliverMessage(cfg.hub.sessionId, message, commit);
      if (outcome === 'refused') {
        // Delivery failed: reset debounce window to prevent rapid retry loop
        firstEventTimeMs = nowMs;
      }
      return outcome === 'started';
    });
  }

  /**
   * Sends one wake on demand (e.g. for `tjob hub-wake [--test]`).
   */
  async function triggerWake(options: { test?: boolean } = {}): Promise<{ success: boolean; message: string }> {
    return lock.runExclusive(async () => {
      const cfg = deps.config();
      if (!cfg.hub?.sessionId) {
        throw new AppError('Hub session is not configured in orchestrator.json', {
          code: 'HUB_NOT_CONFIGURED',
          statusCode: 400,
        });
      }
      if (!cfg.hub.wake) {
        throw new AppError('Hub wake is disabled in orchestrator.json', {
          code: 'HUB_WAKE_DISABLED',
          statusCode: 400,
        });
      }
      const session = sessionsDb.getSessionById(cfg.hub.sessionId);
      if (!session) {
        throw new AppError(`Hub session "${cfg.hub.sessionId}" was not found`, {
          code: 'HUB_SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const nowMs = now().getTime();
      if (isHubBusy(cfg.hub.sessionId, nowMs)) {
        if (options.test) {
          appendHubEvent({
            jobId: 'test',
            state: 'turn_ended',
            title: 'test wake',
            reason: 'manual test requested',
          });
          return {
            success: true,
            message: 'Hub session is currently busy; test wake queued for delivery when idle.',
          };
        }
        return {
          success: true,
          message: 'Hub session is currently busy; wake queued for delivery when idle.',
        };
      }

      readPendingEvents();
      let message: string;
      let commit: { offset: number; generation: number; eventCount: number } | null = null;
      if (pendingEvents.length > 0) {
        commit = { offset: targetEndOffset, generation: logGeneration, eventCount: pendingEvents.length };
        message = buildHubWakeMessage(pendingEvents);
      } else if (options.test) {
        message = '[tjob] test wake: hub wake is active and responding';
      } else {
        return {
          success: true,
          message: 'No pending hub events to deliver.',
        };
      }

      const outcome = await deliverMessage(cfg.hub.sessionId, message, commit);
      if (outcome === 'refused') {
        return {
          success: false,
          message: 'Failed to deliver wake turn to hub session.',
        };
      }
      if (outcome === 'pending') {
        return {
          success: true,
          message: 'Wake turn is waiting for the hub session to settle; it will not be sent twice.',
        };
      }

      return {
        success: true,
        message: options.test ? 'Test wake delivered to hub session.' : 'Wake delivered to hub session.',
      };
    });
  }

  return {
    start(): void {
      ensureStallsLoaded();
      unsubscribeEvents = onHubEvent((event) => {
        const cfg = deps.config();
        if (!cfg.hub?.wake || !cfg.hub.sessionId) return;
        if (event.jobId === cfg.hub.sessionId) return;
        lock.runExclusive(() => {
          readPendingEvents();
        }).catch((err) => {
          console.error('[HubWake] Error reading pending events after hub event:', err);
        });
      });
      lock.runExclusive(() => {
        readPendingEvents();
      }).catch(() => {});
    },

    stop(): void {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
    },

    /** Run periodically by Orchestrator balancer loop. */
    async tick(): Promise<void> {
      const nowMs = now().getTime();
      checkStalls(nowMs);
      await flushPendingIfEligible();
    },

    /**
     * Sends one wake on demand for `tjob hub-wake [--test]`.
     */
    triggerWake,

    /**
     * Sends one test wake on demand for backward compatibility and `tjob hub-wake --test`.
     */
    async triggerTestWake(): Promise<{ success: boolean; message: string }> {
      return triggerWake({ test: true });
    },

    /** Direct testing inspection helpers */
    getPendingEvents: (): LoggedHubEvent[] => pendingEvents.map(({ endOffset: _endOffset, ...event }) => event),
    getStoredOffset: () => storedOffset ?? loadStoredOffset(),
    isHubBusy: (sessionId: string) => isHubBusy(sessionId, now().getTime()),
    getLastStallEmitted: (jobId: string) => {
      ensureStallsLoaded();
      return lastStallEmitted.get(jobId);
    },
  };
}

export type HubWakeService = ReturnType<typeof createHubWakeService>;

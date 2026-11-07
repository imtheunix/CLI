import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// waiting: a job stopped on its provider's usage limit or login and needs the hub (or says when it resumes).
export type HubEventState = 'review' | 'blocked' | 'merge_failed' | 'turn_ended' | 'merged' | 'stalled' | 'waiting';

export type HubEventInput = {
  jobId: string;
  state: HubEventState;
  title: string;
  reason: string;
  timestamp?: string;
};

type HubEventListener = (event: HubEventInput) => void;
const hubEventListeners = new Set<HubEventListener>();

/** Used by HubWakeService to subscribe to state change events as they are emitted. */
export function onHubEvent(listener: HubEventListener): () => void {
  hubEventListeners.add(listener);
  return () => {
    hubEventListeners.delete(listener);
  };
}

/**
 * True inside a test run: node --test (and tsx --test) sets NODE_TEST_CONTEXT in every
 * test file process and its children; NODE_ENV=test covers other runners. The merge
 * queue's checks run `npm test` on the workstation, so a test must never reach the live hub.
 */
export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
}

/** The events log the live server's hub wake tails (~/.cache/cli/hub-events.log). */
export function getLiveHubEventsLogPath(): string {
  return path.join(os.homedir(), '.cache', 'cli', 'hub-events.log');
}

/**
 * Every path the live log may be reached by: $HOME's, and the account's real home from
 * the password database (a run with a temporary HOME can still name the real log in
 * CLI_HUB_EVENTS_LOG), resolved through symlinks.
 */
export function isLiveHubEventsLogPath(candidate: string): boolean {
  const homes = new Set([os.homedir()]);
  try {
    homes.add(os.userInfo().homedir);
  } catch {
    // no passwd entry: $HOME is the only home
  }
  const resolve = (file: string) => {
    const absolute = path.resolve(file);
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  };
  const target = resolve(candidate);
  for (const home of homes) {
    const live = path.join(home, '.cache', 'cli', 'hub-events.log');
    if (target === path.resolve(live) || target === resolve(live)) return true;
  }
  return false;
}

/**
 * Set only by the server entrypoint (server/index.ts). An in-process flag, never an
 * environment variable: shells, agents and test runs the live server starts inherit its
 * environment (NODE_ENV=production, the live DATABASE_PATH, HOME), and a test file run
 * directly (`tsx file.test.ts`, no --test) has no NODE_TEST_CONTEXT, so neither the
 * environment nor the runner can tell such a process from the server.
 */
let liveHubProcess = false;

/** Used by server/index.ts at startup: this process is the live server, whose hub wake tails the live log. */
export function enableLiveHubEvents(): void {
  if (!isTestEnvironment()) liveHubProcess = true;
}

/** True only in the live server process (see enableLiveHubEvents), never under test. */
export function isLiveHubProcess(): boolean {
  return liveHubProcess && !isTestEnvironment();
}

/**
 * Used by Orchestrator and tests to resolve the destination log for hub state events.
 * Only the live server writes the live log: any other process (a test file, run by the
 * runner or directly, a helper, a spawned script) that would resolve it, from the default
 * or from an inherited CLI_HUB_EVENTS_LOG, gets a per-process file in the temp directory,
 * so fixture events cannot wake the real hub.
 */
export function getHubEventsLogPath(): string {
  const target = process.env.CLI_HUB_EVENTS_LOG || getLiveHubEventsLogPath();
  if (!isLiveHubEventsLogPath(target) || isLiveHubProcess()) return target;
  return path.join(os.tmpdir(), `cli-test-hub-events-${process.pid}.log`);
}

/** Sanitize a text field so the output is strictly a single line without tab separators. */
function sanitizeField(value: string | null | undefined): string {
  if (!value) return '-';
  return value.replace(/[\r\n\t]+/g, ' ').trim() || '-';
}

/**
 * Used by the Orchestrator jobs service and merge queue to emit state change events
 * to ~/.cache/cli/hub-events.log, allowing hub sessions to follow job progress with tail -F.
 */
export function appendHubEvent(event: HubEventInput): void {
  try {
    const filePath = getHubEventsLogPath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const ts = event.timestamp ?? new Date().toISOString();
    const jobId = sanitizeField(event.jobId);
    const state = sanitizeField(event.state);
    const title = sanitizeField(event.title);
    const reason = sanitizeField(event.reason);

    const line = `${ts}\t${jobId}\t${state}\t${title}\t${reason}\n`;
    fs.appendFileSync(filePath, line, { mode: 0o600 });

    for (const listener of hubEventListeners) {
      try {
        listener({ ...event, timestamp: ts });
      } catch (listenerError) {
        console.error('[Orchestrator] Hub event listener error:', listenerError);
      }
    }
  } catch (error) {
    console.error('[Orchestrator] Could not append hub event:', error);
  }
}

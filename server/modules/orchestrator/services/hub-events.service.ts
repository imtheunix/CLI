import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HubEventState = 'review' | 'blocked' | 'merge_failed' | 'turn_ended' | 'merged' | 'stalled';

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
 * Used by Orchestrator and tests to resolve the destination log for hub state events.
 * Under test, the live log is never returned: without CLI_HUB_EVENTS_LOG (or with it set
 * to the live log) events go to a per-process file in the temp directory, so a test's
 * fixture events cannot wake the real hub.
 */
export function getHubEventsLogPath(): string {
  const configured = process.env.CLI_HUB_EVENTS_LOG;
  const live = getLiveHubEventsLogPath();
  if (isTestEnvironment()) {
    if (configured && path.resolve(configured) !== live) return configured;
    return path.join(os.tmpdir(), `cli-test-hub-events-${process.pid}.log`);
  }
  return configured || live;
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

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

/** Used by Orchestrator and tests to resolve the destination log for hub state events. */
export function getHubEventsLogPath(): string {
  return process.env.CLI_HUB_EVENTS_LOG || path.join(os.homedir(), '.cache', 'cli', 'hub-events.log');
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

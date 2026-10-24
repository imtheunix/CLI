import type { QueuedSendOptions } from '@/shared/types';

/**
 * Interactive sends that left the composer but have not been accepted by a
 * run yet, keyed by the `clientId` the composer stamped on the `chat.send`.
 *
 * The server answers a send it cannot start with a `protocol_error` that
 * echoes the `clientId`. When that error is `RUN_IN_PROGRESS` — the client's
 * view of the session was stale and a turn was already going — the message is
 * recovered from here and written back into the session's durable queue
 * instead of being lost. Any send the server accepts produces stream events
 * and never an error frame, so entries simply expire.
 */

/** How long a send can stay pending: protocol rejections are immediate, so this only bounds memory. */
const PENDING_SEND_TTL_MS = 15_000;

export type PendingSend = {
  clientId: string;
  /** Session scope the message must be re-queued under. */
  sessionKey: string;
  content: string;
  options?: QueuedSendOptions;
  /** Uploaded attachment descriptors, so a re-queued message keeps its files. */
  attachments?: unknown[];
};

const pendingSends = new Map<string, PendingSend>();

/** Records a send as awaiting its server verdict; replaces any earlier entry with the same id. */
export function registerPendingSend(send: PendingSend): void {
  pendingSends.set(send.clientId, send);
  setTimeout(() => {
    pendingSends.delete(send.clientId);
  }, PENDING_SEND_TTL_MS);
}

/** Removes and returns the send registered under `clientId`, if it is still pending. */
export function takePendingSend(clientId: string): PendingSend | null {
  const send = pendingSends.get(clientId) ?? null;
  pendingSends.delete(clientId);
  return send;
}

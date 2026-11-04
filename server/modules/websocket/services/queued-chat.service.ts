import type { LLMProvider } from '@/shared/types.js';
import { sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord } from '@/modules/database/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';

// A claim is synchronous; hold the session until injection or reservation finishes.
const preparingQueuedSessions = new Set<string>();

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
  onReserved: () => void,
  allowInterrupt: boolean,
): Promise<boolean> {
  const queue = candidate.queuedMessage as { items?: unknown[]; forceId?: string };
  const message = readQueuedMessage(Array.isArray(queue?.items)
    ? queue.items.find((item, index) => queue.forceId ? (item as { id?: string })?.id === queue.forceId : index === 0)
    : candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return false;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      steerActiveRun: true,
      interruptActiveRun: Boolean(queue?.forceId) && allowInterrupt,
      onReserved,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.started && result.error?.includes('already in progress for this session.')) {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return false;
  }
  if (!result.started) sessionDraftsDb.restoreQueuedMessage(candidate);
  // A run that already started owns its prompt even when it fails later.
  // Only unsent input is restored; retrying a partial turn would duplicate it.
  if (!result.started || result.error) sessionDraftsDb.pauseQueue(candidate.sessionId);
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
  return result.started;
}

/** Used by the websocket handler and timer to consume one durable message exactly once. */
export async function dispatchQueuedChatMessage(
  original: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
  messageId?: string,
  allowInterrupt = false,
  onClaimed?: () => void,
): Promise<boolean> {
  if (preparingQueuedSessions.has(original.sessionId)) return false;
  const queue = original.queuedMessage as { items?: Array<{ id?: string }>; paused?: boolean; forceId?: string; forceInterrupt?: boolean };
  if (messageId && !queue.items?.some((item) => item.id === messageId)) return false;
  if (!messageId && queue.paused) return false;
  allowInterrupt ||= queue.forceInterrupt === true;
  const candidate = messageId ? { ...original, queuedMessage: { ...queue, forceId: messageId } } : original;
  const provider = sessionsDb.getSessionById(candidate.sessionId)?.provider;
  if (!messageId && !queue.forceId && !chatRunRegistry.isProcessing(candidate.sessionId) && runtime.hasBackgroundWork(candidate.sessionId)) return false;
  const busy = chatRunRegistry.isProcessing(candidate.sessionId) || runtime.hasBackgroundWork(candidate.sessionId);
  const supportsInjection = provider && (runtime.supportsInjection?.(provider as LLMProvider) ?? provider === 'claude');
  if (busy && !supportsInjection && !((messageId || queue.forceId) && allowInterrupt)) return false;
  if (!sessionDraftsDb.claimQueuedMessage(candidate)) return false;
  preparingQueuedSessions.add(candidate.sessionId);
  onClaimed?.();
  try {
    return await sendClaimedQueuedMessage(candidate, runtime, () => preparingQueuedSessions.delete(candidate.sessionId), allowInterrupt);
  } catch (error) {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    sessionDraftsDb.pauseQueue(candidate.sessionId);
    throw error;
  } finally {
    preparingQueuedSessions.delete(candidate.sessionId);
  }
}

/** Used by scheduled-messages to deliver pending input, including into live Claude queries. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  let count = 0;
  await Promise.all(sessionDraftsDb.listQueuedMessages().map(async (candidate) => {
    if (await dispatchQueuedChatMessage(candidate, runtime)) count++;
  }));
  return count;
}

import { useEffect, useState } from 'react';
import { Loader2, Shuffle } from 'lucide-react';

import { api } from '@/shared/api';

type SentJob = { id: string; backend: string | null; state: string };

const BACKEND_LABELS: Record<string, string> = { claude: 'Claude', codex: 'GPT', glm: 'GLM' };

/** Sends a message to the load balancer; resolves with the job it became, or throws with the server's reason. */
async function sendToLoadBalancer(sessionId: string, content: string): Promise<SentJob> {
  const response = await api.orchestrator.sendFromSession(sessionId, content);
  const body = await response.json().catch(() => null) as
    | { success?: boolean; data?: { job?: SentJob }; error?: { message?: string } }
    | null;
  if (!response.ok || !body?.success || !body.data?.job) {
    throw new Error(body?.error?.message || `The load balancer answered ${response.status}`);
  }
  return body.data.job;
}

function describe(job: SentJob): string {
  return job.backend
    ? `Sent as job ${job.id} to ${BACKEND_LABELS[job.backend] ?? job.backend}: it is in Sessions.`
    : `Sent as job ${job.id}: every model is busy, it starts when one frees up.`;
}

/**
 * Used by ChatComposer (the message being written) and QueuedMessageList (a
 * message waiting for this session): instead of waiting for this session,
 * the message becomes a new session on whichever of Claude, GPT and GLM is
 * least busy.
 */
export default function SendToLoadBalancerButton({
  sessionId,
  content,
  disabled = false,
  disabledReason,
  compact = false,
  onSent,
  onResult,
}: {
  sessionId: string;
  content: string;
  disabled?: boolean;
  disabledReason?: string;
  /** An icon button for the composer's toolbar; a labelled one elsewhere. */
  compact?: boolean;
  onSent: () => void;
  /** Reports the outcome to the caller instead of showing it here, for a button that goes away once sent. */
  onResult?: (result: { text: string; error: boolean }) => void;
}) {
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(null), status.error ? 8_000 : 5_000);
    return () => clearTimeout(timer);
  }, [status]);

  const title = disabled && disabledReason
    ? disabledReason
    : 'Send to the load balancer: a new session on whichever of Claude, GPT and GLM is least busy, instead of waiting for this one';

  const report = (result: { text: string; error: boolean }) => (onResult ? onResult(result) : setStatus(result));

  const send = async () => {
    setSending(true);
    try {
      const job = await sendToLoadBalancer(sessionId, content);
      setSending(false);
      report({ text: describe(job), error: false });
      onSent();
    } catch (error) {
      setSending(false);
      report({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        disabled={disabled || sending || !content.trim()}
        onClick={() => void send()}
        aria-label="Send to load balancer"
        title={title}
        className={compact
          ? 'flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40'
          : 'inline-flex min-h-11 min-w-11 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-40'}
      >
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
        {!compact && <span>To load balancer</span>}
      </button>
      {!onResult && <span
        role="status"
        aria-live="polite"
        className={status
          ? `absolute bottom-full right-0 z-20 mb-2 w-64 rounded-md border bg-popover p-2 text-sm shadow-md ${status.error ? 'text-destructive' : 'text-foreground'}`
          : 'sr-only'}
      >
        {status?.text}
      </span>}
    </span>
  );
}

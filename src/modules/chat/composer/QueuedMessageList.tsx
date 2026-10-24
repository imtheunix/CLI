import { useEffect, useReducer, useState } from 'react';

import SendToLoadBalancerButton from '@/modules/chat/composer/SendToLoadBalancerButton';
import { hasChatDraftSaveError, isQueuePaused, readQueuedMessages, replaceQueuedMessages, subscribeToChatDrafts } from '@/shared/chatDrafts';

/** Used by ChatComposer to edit and control durable per-session queued turns. */
export default function QueuedMessageList({ scope, busy }: { scope: string; busy: boolean }) {
  // The store owns the queue; this counter repaints after local or remote changes.
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => subscribeToChatDrafts(refresh), []);
  // What became of the last item sent to the load balancer; it outlives the item.
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!note) return undefined;
    const timer = setTimeout(() => setNote(null), note.error ? 8_000 : 5_000);
    return () => clearTimeout(timer);
  }, [note]);
  const items = readQueuedMessages(scope);
  const paused = isQueuePaused(scope);
  const saveFailed = hasChatDraftSaveError(scope);
  if (!items.length && !note && !saveFailed) return null;
  const buttonClass = 'min-h-11 min-w-11 rounded-md border px-3 text-sm hover:bg-accent';
  return (
    <section aria-label="Queued messages" className="mx-auto mb-2 max-h-72 max-w-[54.25rem] overflow-y-auto rounded-lg border bg-card p-2 text-sm">
      {saveFailed && <p role="alert" className="mb-2 text-destructive">Queue changes could not be saved to the server. Kept on this device; check the connection or server storage and try again.</p>}
      {note && <p role="status" className={`mb-2 ${note.error ? 'text-destructive' : ''}`}>{note.text}</p>}
      {!!items.length && <div className="flex items-center justify-between gap-2">
        <span>{paused ? 'Queue paused' : 'Queued'} · {items.length}</span>
        {paused && <button type="button" className={buttonClass} onClick={() => replaceQueuedMessages(scope, items, false)}>Resume queue</button>}
      </div>}
      <ol className="space-y-2">
        {items.map((item, index) => (
          <li key={item.id} className="rounded border p-2">
            <label className="block">Queued message {index + 1}
              <textarea aria-label={`Queued message ${index + 1}`} className="mt-1 min-h-11 w-full rounded border bg-background p-2 text-base"
                value={item.content} onChange={(event) => replaceQueuedMessages(scope, items.map((entry) => entry.id === item.id ? { ...entry, content: event.target.value } : entry))} />
            </label>
            {!!item.attachments?.length && <p>{item.attachments.length} files attached</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                title={busy
                  ? 'Hands this message to the running turn without stopping it; if the provider cannot take it mid-turn, it goes out the moment the turn ends.'
                  : 'Sends this message now, ahead of the rest of the queue.'}
                onClick={() => {
                  replaceQueuedMessages(scope, items, false, item.id);
                }}
              >Send now</button>
              <SendToLoadBalancerButton
                sessionId={scope}
                content={item.content}
                disabled={!!item.attachments?.length}
                disabledReason="Messages with attached files stay with this session"
                onResult={setNote}
                onSent={() => replaceQueuedMessages(scope, readQueuedMessages(scope).filter((entry) => entry.id !== item.id))}
              />
              <button type="button" className={buttonClass} onClick={() => replaceQueuedMessages(scope, items.filter((entry) => entry.id !== item.id))}>Remove</button>
              {index > 0 && <button type="button" className={buttonClass} aria-label={`Move queued message ${index + 1} up`} onClick={() => {
                const reordered = [...items];
                [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                replaceQueuedMessages(scope, reordered);
              }}>Move up</button>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Loader2, Workflow } from 'lucide-react';

import { LLMProviderLogo } from '@/shared/ui';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import type { ChatMessage, SpawnedSessionChild } from '@/shared/types';
import { deriveSessionChecklist } from '@/modules/chat/utils/sessionChecklist';
import type { SessionChecklistTodo } from '@/modules/chat/utils/sessionChecklist';

type SessionChecklistProps = {
  messages: ChatMessage[];
  revealMessage: (message: ChatMessage) => void;
  /** Session the checklist belongs to; the open/closed choice is remembered per session. */
  sessionId: string | null;
  /** Sessions spawned from this one, listed in the expanded panel. */
  spawnedSessions?: SpawnedSessionChild[];
  /** Opens a spawned session by id when its row is tapped. */
  onOpenSession?: (sessionId: string) => void;
  /** Re-reads the spawned list when the panel expands, so a session that appeared while the panel was closed still shows up. */
  onRefreshSpawnedSessions?: () => void;
};

/** Per-session localStorage key remembering whether the checklist strip is expanded ('1') or collapsed ('0'). */
const expandedStorageKey = (sessionId: string) => `session-checklist-expanded-${sessionId}`;

function readStoredExpanded(sessionId: string | null, fallback: boolean): boolean {
  if (!sessionId) {
    return fallback;
  }
  try {
    const stored = localStorage.getItem(expandedStorageKey(sessionId));
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

/** The collapsed strip's one-line summary: how far along, what is in flight, what else runs. */
function summarize(todos: SessionChecklistTodo[]): string {
  const active = todos.find((todo) => todo.status === 'in_progress');
  if (active) {
    return active.activeForm || active.content;
  }
  return todos.every((todo) => todo.status === 'completed') ? 'Done' : todos[0]?.content ?? '';
}

/** Text treatment per checklist status: done rows read as finished, the active one stands out. */
function todoTextClass(status: SessionChecklistTodo['status']): string {
  if (status === 'completed') {
    return 'text-muted-foreground line-through';
  }
  return status === 'in_progress' ? 'font-medium text-foreground' : 'text-foreground';
}

/**
 * Rendered by ChatComposer above the queued-message list: what the session's
 * plan is, which step is in flight and which subagents/workflows still run,
 * with every row jumping to the transcript message it came from. The sessions
 * this one spawned are listed in the expanded view.
 */
export default function SessionChecklist({
  messages,
  revealMessage,
  sessionId,
  spawnedSessions,
  onOpenSession,
  onRefreshSpawnedSessions,
}: SessionChecklistProps) {
  // Collapsed by default on phones: the strip must not crowd the composer.
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  // The open/closed choice is the user's per session, so it survives reloads
  // and re-opening the session; a session change falls back to the device default.
  const [expanded, setExpanded] = useState<boolean>(() => readStoredExpanded(sessionId, !isMobile));
  // Re-read the stored choice when the strip moves to another session. Done
  // during render (the React-recommended reset pattern) rather than in an
  // effect, so no extra frame shows the previous session's choice.
  const [lastSessionId, setLastSessionId] = useState(sessionId);
  if (sessionId !== lastSessionId) {
    setLastSessionId(sessionId);
    setExpanded(readStoredExpanded(sessionId, !isMobile));
  }

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    try {
      localStorage.setItem(expandedStorageKey(sessionId), expanded ? '1' : '0');
    } catch {
      // A full quota is not worth failing the strip over.
    }
  }, [expanded, sessionId]);

  useEffect(() => {
    if (expanded) {
      onRefreshSpawnedSessions?.();
    }
  }, [expanded, sessionId, onRefreshSpawnedSessions]);

  const { todos, running } = useMemo(() => deriveSessionChecklist(messages), [messages]);
  const spawnedList = spawnedSessions ?? [];
  if (todos.length === 0 && running.length === 0 && spawnedList.length === 0) {
    return null;
  }

  const doneCount = todos.filter((todo) => todo.status === 'completed').length;
  const headline = todos.length > 0 ? `${doneCount}/${todos.length} · ${summarize(todos)}` : 'Checklist';
  const runningSuffix = running.length > 0 ? ` · ${running.length} running` : '';

  const toggle = () => setExpanded((previous) => !previous);

  return (
    <section
      aria-label="Session checklist"
      className="mx-auto mb-2 max-w-[54.25rem] rounded-lg border bg-card p-2 text-[15px] sm:text-sm"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent/50"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium tabular-nums text-foreground">{headline}</span>
        {runningSuffix && (
          <span className="min-w-0 flex-1 truncate text-primary">{runningSuffix}</span>
        )}
      </button>

      {expanded && (
        <div className="max-h-72 overflow-y-auto">
          <ul>
            {todos.map((todo) => (
              <li key={todo.content}>
                <button
                  type="button"
                  onClick={() => revealMessage(todo.message)}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent/50"
                >
                  {todo.status === 'completed' ? (
                    <Check className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : todo.status === 'in_progress' ? (
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
                  )}
                  <span className={`min-w-0 flex-1 leading-snug ${todoTextClass(todo.status)}`}>
                    {todo.content}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {running.length > 0 && (
            <div className="mt-1 border-t border-border/40 pt-1">
              <p className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Running</p>
              <ul>
                {running.map((entry) => (
                  <li key={`${entry.kind}-${entry.label}`}>
                    <button
                      type="button"
                      onClick={() => revealMessage(entry.message)}
                      className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent/50"
                    >
                      {entry.kind === 'workflow' ? (
                        <Workflow className="h-4 w-4 shrink-0 text-purple-500 dark:text-purple-400" aria-hidden="true" />
                      ) : (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate leading-snug text-foreground">{entry.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {spawnedList.length > 0 && (
            <div className="mt-1 border-t border-border/40 pt-1">
              <p className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Spawned sessions ({spawnedList.length})
              </p>
              <ul>
                {spawnedList.map((child) => (
                  <li key={child.sessionId}>
                    <button
                      type="button"
                      onClick={() => onOpenSession?.(child.sessionId)}
                      className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent/50"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/50">
                        <LLMProviderLogo provider={child.provider} className="h-3 w-3" />
                      </span>
                      <span className="min-w-0 flex-1 truncate leading-snug text-foreground">{child.name}</span>
                      {child.running && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

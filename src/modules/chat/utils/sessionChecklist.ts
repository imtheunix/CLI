import type { ChatMessage, SessionChecklistState, SessionChecklistTodo, SessionChecklistTodoStatus } from '@/shared/types';
import { readBackgroundTaskStatus } from '@/modules/chat/utils/backgroundTasks';

/** The tool names every provider's subagent launches are normalized onto (see toolConfigs). */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const WORKFLOW_TOOLS = new Set(['Workflow']);

/**
 * Reads a tool call's input whether it arrived as an object or as a JSON
 * string: providers and the history path are not consistent about which one
 * they hand the client.
 */
function parseToolInput(toolInput: unknown): Record<string, unknown> {
  if (typeof toolInput === 'string') {
    try {
      const parsed = JSON.parse(toolInput);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {};
}

function readTodoStatus(value: unknown): SessionChecklistTodoStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

type RawTodo = {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
};

/** One usable row of a checklist snapshot: content identifies the item across snapshots. */
type SnapshotRow = {
  content: string;
  status: SessionChecklistTodoStatus;
  activeForm?: string;
};

/**
 * The checklist rows of one unified TodoWrite snapshot, or null when the
 * message is not a checklist snapshot. Entries missing content are dropped:
 * a row with nothing to say cannot be jumped to or rendered.
 */
function readChecklistSnapshot(message: ChatMessage): SnapshotRow[] | null {
  if (!message.isToolUse || message.toolName !== 'TodoWrite') {
    return null;
  }

  const input = parseToolInput(message.toolInput);
  if (!Array.isArray(input.todos)) {
    return null;
  }

  const rows: SnapshotRow[] = [];
  for (const entry of input.todos as RawTodo[]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content) {
      continue;
    }
    rows.push({
      content,
      status: readTodoStatus(entry.status),
      activeForm: typeof entry.activeForm === 'string' && entry.activeForm.trim() ? entry.activeForm : undefined,
    });
  }
  return rows;
}

/** What to call a still-running subagent or workflow launch. */
function describeRunningEntry(toolName: string, input: Record<string, unknown>): string {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description) {
    return description;
  }
  if (toolName === 'Workflow') {
    const workflowName = typeof input.name === 'string' ? input.name.trim() : '';
    if (workflowName) {
      return workflowName;
    }
  }
  const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  if (subagentType) {
    return subagentType;
  }
  return toolName === 'Workflow' ? 'Workflow' : 'Subagent';
}

/**
 * Derives the session checklist strip's data from a transcript.
 *
 * `todos` come from the LATEST TodoWrite snapshot (every provider's checklist
 * is rewritten onto that one tool by the backend), and each row points at the
 * message where its current status was FIRST seen, so tapping it jumps to the
 * moment the status changed. `running` lists the subagent and workflow
 * launches of the current turn that have no result yet — plus background ones
 * whose task status still says running, whose launch result arrives before the
 * work does.
 */
export function deriveSessionChecklist(messages: ChatMessage[]): SessionChecklistState {
  // Keyed by content: a snapshot replaces the whole list, so the content is
  // the stable identity of an item across snapshots.
  const firstSeenByContent = new Map<string, { status: SessionChecklistTodoStatus; message: ChatMessage }>();
  let latestSnapshotMessage: ChatMessage | null = null;
  let latestSnapshotRows: SnapshotRow[] | null = null;

  const running: SessionChecklistState['running'] = [];
  const seenRunningToolIds = new Set<string>();

  // Only unresolved foreground launches in the latest user turn are current.
  // Explicit background status can outlive that boundary.
  let currentTurnStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'user' && !messages[index].isToolUse) {
      currentTurnStart = index;
      break;
    }
  }
  for (const [index, message] of messages.entries()) {
    if (!message.isToolUse) {
      continue;
    }

    const snapshot = readChecklistSnapshot(message);
    if (snapshot) {
      latestSnapshotMessage = message;
      latestSnapshotRows = snapshot;
      const present = new Set(snapshot.map((row) => row.content));
      for (const content of firstSeenByContent.keys()) {
        if (!present.has(content)) firstSeenByContent.delete(content);
      }
      for (const row of snapshot) {
        const tracked = firstSeenByContent.get(row.content);
        if (!tracked || tracked.status !== row.status) {
          firstSeenByContent.set(row.content, { status: row.status, message });
        }
      }
      continue;
    }

    const toolName = message.toolName ?? '';
    const isSubagent = SUBAGENT_TOOLS.has(toolName);
    const isWorkflow = WORKFLOW_TOOLS.has(toolName);
    if (!isSubagent && !isWorkflow) {
      continue;
    }

    // A launch with no result yet is running; a backgrounded launch gets its
    // ack immediately and keeps running until its task status settles.
    const backgroundStatus = readBackgroundTaskStatus(message);
    const isRunning = backgroundStatus === 'running'
      || (backgroundStatus === undefined && message.toolResult == null && index >= currentTurnStart);
    if (!isRunning) {
      continue;
    }

    const toolKey = message.toolId ?? `${toolName}-${message.timestamp}`;
    if (seenRunningToolIds.has(toolKey)) {
      continue;
    }
    seenRunningToolIds.add(toolKey);

    running.push({
      kind: isWorkflow ? 'workflow' : 'subagent',
      label: describeRunningEntry(toolName, parseToolInput(message.toolInput)),
      message,
    });
  }

  const todos: SessionChecklistTodo[] = [];
  if (latestSnapshotRows && latestSnapshotMessage) {
    for (const row of latestSnapshotRows) {
      // A row whose content never resolved to a message cannot happen (every
      // snapshot row records itself), but the guard keeps the type honest.
      const message = firstSeenByContent.get(row.content)?.message ?? latestSnapshotMessage;
      todos.push({
        content: row.content,
        status: row.status,
        ...(row.activeForm ? { activeForm: row.activeForm } : {}),
        message,
      });
    }
  }

  return { todos, running };
}

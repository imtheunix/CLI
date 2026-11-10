import fsSync from 'node:fs';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import { abortTurn, spawnDetachedTurn } from '@/modules/detached-turns/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors
} from '@/shared/image-attachments.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell, getOpenCodeDatabasePath, stripAnsiSequences } from '@/shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

const activeOpenCodeProcesses = new Map();

/**
 * Maps the UI permission mode onto OpenCode's non-interactive controls.
 *
 * OpenCode has no single "permission mode" flag; each mode uses a different
 * lever of the `opencode run` CLI (verified against v1.17.13):
 * - plan              → the built-in read-only `plan` agent (`--agent plan`).
 * - bypassPermissions → `--auto`, which auto-approves every permission that
 *                       is not explicitly denied in the user's config.
 * - acceptEdits       → the OPENCODE_PERMISSION env var, whose JSON body the
 *                       CLI merges into its permission config. Forcing
 *                       `edit: allow` guarantees file edits go through while
 *                       every other rule stays under the user's own config.
 * - default           → nothing; the user's opencode.json governs. In
 *                       non-interactive `run` mode any `ask` rule is denied.
 *
 * Exported for tests only.
 */
export function resolveOpenCodePermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

function resolveOpenCodeEffort(model, effort, modelsDefinition) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function readOpenCodeSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionID || event.sessionId || null;
}

function readOpenCodeTokenUsage(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all();
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId);

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Per-turn line parser for `opencode run --format json` output.
 *
 * Used by the live runtime and by detached-turn reattachment (registered in
 * opencode.provider.ts) so both paths normalize identically. It tracks the
 * part ids whose text already reached the client as `stream_delta` events:
 * OpenCode can follow those deltas with the same part completed, and emitting
 * that completed text again would duplicate the assistant message. A part
 * that never streamed still falls back to its completed text.
 *
 * @param {(raw: unknown, sessionId: string | null) => Array<object>} normalizeMessage
 */
export function createOpenCodeTurnLineParser(normalizeMessage) {
  let capturedSessionId = null;
  // Part ids whose text was already delivered incrementally.
  const streamedPartIds = new Set();

  const parse = (line) => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === 'object' ? event : null;
    } catch {
      return null;
    }
  };

  const readPart = (event) => (event.part && typeof event.part === 'object' ? event.part : null);

  const captureSession = (event, writer) => {
    const nextSessionId = event.sessionID || event.sessionId;
    if (typeof nextSessionId !== 'string' || !nextSessionId || capturedSessionId) {
      return;
    }

    capturedSessionId = nextSessionId;
    // A brand-new session has no provider id on its writer yet. Writers that
    // cannot report their id (legacy callers) are left to the live runtime.
    const isNewSession = typeof writer?.getSessionId === 'function' && !writer.getSessionId();
    writer?.setSessionId?.(nextSessionId);
    if (isNewSession) {
      writer?.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: nextSessionId,
        sessionId: nextSessionId,
        provider: 'opencode',
      }));
    }
  };

  const handleLine = (line, writer, sessionId) => {
    const event = parse(line);
    if (!event) {
      return;
    }

    captureSession(event, writer);
    const sid = capturedSessionId || writer?.getSessionId?.() || sessionId || null;
    const type = event.type || event.event;
    const part = readPart(event);
    const partId = typeof part?.id === 'string' ? part.id : null;

    if (type === 'text') {
      // A nested `part.text` is the completed part; flat `delta`/`text` is a
      // live increment. Suppress the completion when its deltas already went out.
      const isCompletedPart = typeof part?.text === 'string';
      if (isCompletedPart && partId && streamedPartIds.has(partId)) {
        return;
      }

      for (const message of normalizeMessage(event, sid)) {
        if (message.kind === 'stream_delta' && partId) {
          streamedPartIds.add(partId);
        }
        writer?.send(message);
      }
      return;
    }

    for (const message of normalizeMessage(event, sid)) {
      writer?.send(message);
    }
  };

  // The part of the log delivered before a restart: re-establish the session
  // id and which parts already streamed, without sending any of it again.
  handleLine.prime = (lines, writer, sessionId) => {
    for (const line of lines) {
      const event = parse(line);
      if (!event) {
        continue;
      }
      captureSession(event, writer);
      const type = event.type || event.event;
      const part = readPart(event);
      const partId = typeof part?.id === 'string' ? part.id : null;
      if (type === 'text' && partId && typeof part?.text !== 'string') {
        streamedPartIds.add(partId);
      }
    }
  };

  handleLine.finish = () => {
    streamedPartIds.clear();
  };

  return handleLine;
}

async function spawnOpenCode(command, options = {}, ws, context) {
  return new Promise((resolve, reject) => {
    const {
      sessionId,
      projectPath,
      cwd,
      model,
      effort,
      agent,
      sessionSummary,
      images,
      files,
      permissionMode
    } = options;
    // Callers pass the stable app session id; the CLI resumes with the
    // provider-native id recorded on the session row.
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const workingDir = cwd || projectPath || process.cwd();
    // Process-map key: the app session id when the caller supplied one, so
    // abort-by-app-id always works.
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let opencodeProcess = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    // One parser per turn: it remembers which text parts already streamed.
    const lineParser = createOpenCodeTurnLineParser(context.normalizeMessage);

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'opencode',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `OpenCode CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && opencodeProcess) {
        activeOpenCodeProcesses.delete(processKey);
        activeOpenCodeProcesses.set(capturedSessionId, opencodeProcess);
      }
      if (opencodeProcess) {
        opencodeProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        return;
      }

      try {
        registerSession(readOpenCodeSessionId(response));
        lineParser(line, ws, capturedSessionId || sessionId || null);
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      }
    };

    void context.resolveResumeModel(sessionId, model).then(async (resolvedModel) => {
      let effortModels = null;
      try {
        effortModels = await context.getProviderModels();
      } catch (error) {
        console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
      }

      const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);
      const args = ['run', '--format', 'json'];
      // OpenCode's `run` command owns workspace selection through `--dir`.
      // Relying on the child-process cwd alone is not enough on Linux, where
      // the CLI can still resolve the session under the server install dir.
      args.push('--dir', workingDir);
      if (providerSessionId) {
        args.push('--session', providerSessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      if (resolvedEffort) {
        args.push('--variant', resolvedEffort);
      }
      const permissionOptions = resolveOpenCodePermissionOptions(permissionMode);
      args.push(...permissionOptions.args);
      // A per-session OpenCode agent (e.g. morph-hub) rides along unless the
      // turn's permission mode already picked one (`plan`). Before the prompt:
      // the positional prompt must stay the last argument.
      const sessionAgent = typeof agent === 'string' ? agent.trim() : '';
      if (sessionAgent && !permissionOptions.args.includes('--agent')) {
        args.push('--agent', sessionAgent);
      }
      const hasAttachments =
        normalizeAttachmentDescriptors(images).length > 0
        || normalizeAttachmentDescriptors(files).length > 0;
      if ((command && command.trim()) || hasAttachments) {
        // Image attachments ride along as an <images_input> path list appended
        // to the prompt; the session history reader strips the tag back out.
        // opencode is a .cmd shim on Windows, so the whole argument must be
        // newline-free or cmd.exe silently truncates it at the first newline.
        const promptWithAttachments = appendFilesInputTag(
          appendImagesInputTag(command?.trim() || '', images),
          files
        );
        args.push(flattenPromptForWindowsShell(promptWithAttachments));
      }

      if (options.abortController?.signal.aborted) { resolve(); return; }

      const turnExecution = spawnDetachedTurn({
        command: 'opencode',
        args,
        cwd: workingDir,
        sessionId: processKey,
        // The real provider id: after a restart the turn reattaches through it
        // (provider lookup, abort), so a foreign label here would break both.
        backend: 'opencode',
        jobId: typeof options.jobId === 'string' ? options.jobId : null,
        env: permissionOptions.env,
        onLine: (line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('{')) {
            processOpenCodeOutputLine(trimmed);
          } else {
            const stderrText = stripAnsiSequences(trimmed);
            if (stderrText.trim()) {
              ws.send(createNormalizedMessage({
                kind: 'error',
                content: stderrText,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'opencode',
              }));
            }
          }
        },
        signal: options.abortController?.signal,
      });

      const { exitCode: code } = await turnExecution.promise;
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeOpenCodeProcesses.delete(finalSessionId);
      activeOpenCodeProcesses.delete(processKey);
      if (options.abortController?.signal.aborted) { resolve(); return; }

      // OpenCode's own database is keyed by the provider-native id.
      const tokenBudget = readOpenCodeTokenUsage(capturedSessionId);
      if (tokenBudget) {
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));
      }

      // Terminal complete — skipped for aborted runs (abort-session
      // already sent the aborted complete on this run's behalf).
      if (!completeSent && !options.abortController?.signal.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: code }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      if (code === 127 || code === null) {
        const installed = await context.isProviderInstalled();
        if (!installed) {
          ws.send(createNormalizedMessage({
            kind: 'error',
            content: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }
      }

      notifyTerminalState({ code });
      reject(new Error(code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${code}`));
    }).catch(reject);
  });
}

function abortOpenCodeSession(sessionId) {
  const detachedAborted = abortTurn(sessionId);
  const process = activeOpenCodeProcesses.get(sessionId);
  if (!process) {
    return detachedAborted;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  process.aborted = true;
  process.kill('SIGTERM');
  activeOpenCodeProcesses.delete(sessionId);
  return true;
}

function isOpenCodeSessionActive(sessionId) {
  return activeOpenCodeProcesses.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(activeOpenCodeProcesses.keys());
}

export const opencodeRuntime = {
  run: spawnOpenCode,
  abort: abortOpenCodeSession,
};

export {
  spawnOpenCode,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
};

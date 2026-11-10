import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import Database from 'better-sqlite3';
import { spawn } from 'cross-spawn';
import { rgPath } from '@vscode/ripgrep';

import {
  getOpenCodeDatabasePath,
  getZcodeTranscriptPath,
  isClaudeNonTurnMessageRow,
  readJsonRecord,
  readOptionalString,
  stripAnsiSequences,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';

type AnyRecord = Record<string, any>;
type SearchableProvider = 'claude' | 'codex' | 'opencode' | 'zcode';

type SearchSnippetHighlight = {
  start: number;
  end: number;
};

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: SearchableProvider;
  messageUuid?: string | null;
};

type SessionConversationResult = {
  sessionId: string;
  provider: SearchableProvider;
  sessionSummary: string;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

type SessionTitleSearchResult = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  signal?: AbortSignal;
  onTitleResults?: (results: SessionTitleSearchResult[]) => void;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];
type SearchableSessionRow = SessionRepositoryRow & {
  provider: SearchableProvider;
  jsonl_path: string | null;
};

type OpenCodeSearchRow = {
  session_id: string;
  message_id: string;
  part_data: string | null;
  part_time_created: number | null;
  message_data: string | null;
};

type SearchRuntime = {
  matchesQuery: (text: string) => boolean;
  buildSnippet: (text: string) => { snippet: string; highlights: SearchSnippetHighlight[] };
  limit: number;
  totalMatches: number;
  isAborted: () => boolean;
  matchedSessionKeys: Set<string>;
  claudeSessionsByFileKey: Map<string, SearchableSessionRow[]>;
  claudeFileResultsCache: Map<string, Map<string, SessionConversationResult>>;
  openCodeRowsBySessionKey: Map<string, OpenCodeSearchRow[]>;
};

type SearchablePathEntry = {
  normalizedPath: string;
  absolutePath: string;
};

type ProjectBucket = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SearchableSessionRow[];
};

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude', 'codex', 'opencode', 'zcode']);
const MAX_MATCHES_PER_SESSION = 2;
const RIPGREP_FILE_CHUNK_SIZE = 40;
const RIPGREP_CHUNK_CONCURRENCY = 6;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';

const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  'Invalid API key',
  '[Request interrupted',
] as const;

/**
 * Codex includes extra internal metadata tags that should not surface as
 * user-facing searchable conversation content.
 */
const CODEX_INTERNAL_CONTENT_PREFIXES = [
  '<environment_context>',
  '<cwd>',
] as const;

function normalizeComparablePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());
  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: TItem[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function getSessionKey(session: Pick<SessionRepositoryRow, 'provider' | 'session_id'>): string {
  return `${session.provider}:${session.session_id}`;
}

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName) {
    return trimmedCustomName;
  }

  const trimmedFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!trimmedFallback) {
    return emptyLabel;
  }

  return trimmedFallback.length > 50 ? `${trimmedFallback.slice(0, 50)}...` : trimmedFallback;
}

/**
 * Job worktrees live at `~/Tribeira/.jobs/<repo>/<job id>`, and the job id is
 * not part of the session title. Recover it from the project path so searching
 * for a job id finds the session that ran it.
 */
function extractJobIdFromProjectPath(projectPath: string | null): string | null {
  if (!projectPath) {
    return null;
  }

  const segments = projectPath.split(/[\\/]+/).filter(Boolean);
  const jobsIndex = segments.lastIndexOf('.jobs');
  if (jobsIndex === -1 || segments.length - jobsIndex !== 3) {
    return null;
  }

  return segments[jobsIndex + 2] || null;
}

/**
 * Finds visible sessions whose displayed title, job id, or session id prefix
 * contains the query. Title matches are resolved from the database before
 * transcript scanning so the UI can always present them first, including
 * sessions without a transcript yet.
 */
function findSessionTitleResults(
  sessions: SessionRepositoryRow[],
  query: string,
  limit: number,
): SessionTitleSearchResult[] {
  const normalizedQuery = query.toLocaleLowerCase().replace(/\s+/g, ' ');
  const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

  return sessions
    .flatMap((session) => {
      const sessionTitle = toSummaryText(session.custom_name, session.session_id, session.session_id);
      const normalizedTitle = sessionTitle.toLocaleLowerCase().replace(/\s+/g, ' ');
      const projectPath = typeof session.project_path === 'string' && session.project_path.trim()
        ? session.project_path.trim()
        : null;
      const jobId = extractJobIdFromProjectPath(projectPath);
      const normalizedJobId = jobId ? jobId.toLocaleLowerCase() : '';
      const normalizedSessionId = session.session_id.toLocaleLowerCase();

      const candidateIndexes = [
        normalizedTitle.indexOf(normalizedQuery),
        normalizedJobId ? normalizedJobId.indexOf(normalizedQuery) : -1,
        normalizedSessionId.startsWith(normalizedQuery) ? 0 : -1,
      ].filter((index) => index >= 0);
      if (candidateIndexes.length === 0) {
        return [];
      }
      const matchIndex = Math.min(...candidateIndexes);

      const projectKey = projectPath ?? UNKNOWN_PROJECT_KEY;
      if (!projectCache.has(projectKey)) {
        projectCache.set(
          projectKey,
          projectPath ? projectsDb.getProjectPath(projectPath) : null,
        );
      }

      const project = projectCache.get(projectKey) ?? null;
      if (project?.isArchived) {
        return [];
      }

      return [{
        sessionId: session.session_id,
        provider: session.provider,
        projectId: project?.project_id ?? null,
        projectDisplayName: projectPath
          ? (project?.custom_project_name?.trim() || path.basename(projectPath) || projectPath)
          : 'Unknown Project',
        sessionTitle,
        lastActivity: session.updated_at || session.created_at || null,
        matchIndex,
      }];
    })
    .sort((left, right) => {
      if (left.matchIndex !== right.matchIndex) {
        return left.matchIndex - right.matchIndex;
      }

      return new Date(right.lastActivity ?? 0).getTime() - new Date(left.lastActivity ?? 0).getTime();
    })
    .slice(0, limit)
    .map(({ matchIndex: _matchIndex, ...result }) => result);
}

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function isInternalCodexContent(content: string): boolean {
  const normalized = content.trimStart();
  return CODEX_INTERNAL_CONTENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWordMatcher(
  rawQuery: string,
  words: string[],
): Pick<SearchRuntime, 'matchesQuery' | 'buildSnippet'> {
  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;
  const wordPatterns = words.map((word) => new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u'));
  const phrasePattern = words.map((word) => escapeRegex(word)).join('\\s+');
  const phraseRegex = new RegExp(phrasePattern, 'iu');

  const allWordsMatch = (textLower: string): boolean =>
    wordPatterns.every((pattern) => pattern.test(textLower));

  const matchesQuery = (text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) {
      return false;
    }

    if (requireExactPhrase) {
      return phraseRegex.test(text);
    }

    if (phraseRegex.test(text)) {
      return true;
    }

    if (words.length === 1) {
      return allWordsMatch(text.toLowerCase());
    }

    return allWordsMatch(text.toLowerCase());
  };

  const buildSnippet = (
    text: string,
    snippetLen = 150,
  ): { snippet: string; highlights: SearchSnippetHighlight[] } => {
    const textLower = text.toLowerCase();
    let firstIndex = -1;
    let firstWordLen = 0;
    let phraseStart = -1;
    let phraseLength = 0;

    const phraseMatch = phraseRegex.exec(text);
    if (phraseMatch) {
      phraseStart = phraseMatch.index;
      phraseLength = phraseMatch[0].length;
      firstIndex = phraseStart;
      firstWordLen = phraseLength;
    }

    if (firstIndex === -1) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u');
        const match = regex.exec(textLower);
        if (match && (firstIndex === -1 || match.index < firstIndex)) {
          firstIndex = match.index;
          firstWordLen = word.length;
        }
      }
    }

    if (firstIndex === -1) {
      firstIndex = 0;
    }

    const halfLen = Math.floor(snippetLen / 2);
    const start = Math.max(0, firstIndex - halfLen);
    const end = Math.min(text.length, firstIndex + halfLen + firstWordLen);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    const snippetBody = text.slice(start, end).replace(/\n/g, ' ');
    const snippet = `${prefix}${snippetBody}${suffix}`;

    const snippetLower = snippet.toLowerCase();
    const highlights: SearchSnippetHighlight[] = [];

    if (phraseStart >= start && phraseStart + phraseLength <= end) {
      const phraseOffset = prefix.length + (phraseStart - start);
      highlights.push({
        start: phraseOffset,
        end: phraseOffset + phraseLength,
      });
    }

    if (!requireExactPhrase) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'gu');
        let match = regex.exec(snippetLower);
        while (match) {
          highlights.push({ start: match.index, end: match.index + word.length });
          match = regex.exec(snippetLower);
        }
      }
    }

    highlights.sort((left, right) => left.start - right.start);
    const merged: SearchSnippetHighlight[] = [];
    for (const highlight of highlights) {
      const previous = merged[merged.length - 1];
      if (previous && highlight.start <= previous.end) {
        previous.end = Math.max(previous.end, highlight.end);
      } else {
        merged.push({ ...highlight });
      }
    }

    return { snippet, highlights: merged };
  };

  return { matchesQuery, buildSnippet };
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part: AnyRecord) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: AnyRecord) => String(part.text))
    .join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

type ClaudeSearchableMessage = {
  text: string;
  role: 'user' | 'assistant';
};

/**
 * Claude mixes visible chat, compact summaries, and local command wrappers into
 * the same transcript stream. Search should operate on the user-visible meaning
 * of those rows rather than the raw wrapper syntax.
 */
function extractClaudeSearchableMessage(entry: AnyRecord): ClaudeSearchableMessage | null {
  if (!entry.message?.content || entry.isApiErrorMessage || isClaudeNonTurnMessageRow(entry)) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return {
        text: content,
        role: 'assistant',
      };
    }

    const localCommand = parseClaudeLocalCommandPayload(content);
    if (localCommand) {
      const displayText = buildClaudeLocalCommandDisplayText(localCommand);
      return displayText
        ? {
            text: displayText,
            role: 'user',
          }
        : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiSequences(localCommandStdout).trim();
      return stdoutText
        ? {
            text: stdoutText,
            role: 'assistant',
          }
        : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return {
      text: content,
      role: rawRole,
    };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return {
      text,
      role: 'assistant',
    };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return {
    text,
    role: rawRole,
  };
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function resolveZcodeTranscriptPath(row: SessionRepositoryRow): string | null {
  const appPath = getZcodeTranscriptPath(row.session_id);
  if (fsSync.existsSync(appPath)) {
    return appPath;
  }

  const providerSessionId = typeof row.provider_session_id === 'string'
    ? row.provider_session_id.trim()
    : '';
  if (providerSessionId && providerSessionId !== row.session_id) {
    const providerPath = getZcodeTranscriptPath(providerSessionId);
    if (fsSync.existsSync(providerPath)) {
      return providerPath;
    }
  }

  return null;
}

function normalizeSearchableSessions(rows: SessionRepositoryRow[]): SearchableSessionRow[] {
  const normalizedRows: SearchableSessionRow[] = [];
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    /**
     * Active session rows can still belong to an archived project because
     * project archiving intentionally preserves the underlying session data.
     * Global conversation search should follow the visible workspace model,
     * which means excluding any session whose owning project is archived.
     *
     * Cache the archive lookup per normalized project path so one search pass
     * does not re-query the same project row for every session in that folder.
     */
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }

      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    // OpenCode keeps every conversation in one shared SQLite database, so its
    // session rows have no per-session transcript path.
    if (provider === 'opencode') {
      normalizedRows.push({
        ...row,
        provider,
        jsonl_path: null,
      });
      continue;
    }

    const rawJsonlPath = provider === 'zcode'
      ? resolveZcodeTranscriptPath(row)
      : (typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '');
    if (!rawJsonlPath) {
      continue;
    }

    const absoluteJsonlPath = path.resolve(rawJsonlPath);
    if (!fsSync.existsSync(absoluteJsonlPath)) {
      continue;
    }

    normalizedRows.push({
      ...row,
      provider,
      jsonl_path: absoluteJsonlPath,
    });
  }

  return normalizedRows;
}

function buildProjectBuckets(searchableSessions: SearchableSessionRow[]): ProjectBucket[] {
  const projectBuckets = new Map<string, ProjectBucket>();
  const projectMetadataCache = new Map<string, { projectId: string | null; projectDisplayName: string }>();

  for (const session of searchableSessions) {
    const key = makeProjectKey(session.project_path);
    if (!projectBuckets.has(key)) {
      if (!projectMetadataCache.has(key)) {
        if (key === UNKNOWN_PROJECT_KEY) {
          projectMetadataCache.set(key, {
            projectId: null,
            projectDisplayName: 'Unknown Project',
          });
        } else {
          const projectRow = projectsDb.getProjectPath(key);
          const customProjectName = typeof projectRow?.custom_project_name === 'string'
            ? projectRow.custom_project_name.trim()
            : '';
          const displayName = customProjectName || path.basename(key) || key;

          projectMetadataCache.set(key, {
            projectId: projectRow?.project_id ?? null,
            projectDisplayName: displayName,
          });
        }
      }

      const metadata = projectMetadataCache.get(key) as { projectId: string | null; projectDisplayName: string };
      projectBuckets.set(key, {
        key,
        projectId: metadata.projectId,
        projectName: key,
        projectDisplayName: metadata.projectDisplayName,
        sessions: [],
      });
    }

    const bucket = projectBuckets.get(key) as ProjectBucket;
    bucket.sessions.push(session);
  }

  const buckets = Array.from(projectBuckets.values());
  for (const bucket of buckets) {
    bucket.sessions.sort((left, right) => {
      const leftTs = new Date(left.updated_at || left.created_at || 0).getTime();
      const rightTs = new Date(right.updated_at || right.created_at || 0).getTime();
      return rightTs - leftTs;
    });
  }

  return buckets;
}

/**
 * Executes ripgrep with the file list explicitly provided from sessionsDb jsonl paths.
 *
 * This avoids recursive directory walks and uses a fixed known candidate list.
 */
async function runRipgrepFilesWithMatches(
  pattern: string,
  filePaths: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (!pattern || filePaths.length === 0 || signal?.aborted) {
    return new Set();
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--files-with-matches',
      '--no-messages',
      '--ignore-case',
      '--fixed-strings',
      '--',
      pattern,
      ...filePaths,
    ];
    const rg = spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };

    if (signal) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    rg.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    rg.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      reject(error);
    });

    rg.on('close', (code) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(code)}: ${stderr}`));
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const matchedPaths = new Set<string>();

      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        matchedPaths.add(normalizeComparablePath(trimmed));
      }

      resolve(matchedPaths);
    });
  });
}

async function findMatchedFileKeys(
  searchablePathEntries: SearchablePathEntry[],
  rawQuery: string,
  words: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (searchablePathEntries.length === 0 || words.length === 0 || signal?.aborted) {
    return new Set();
  }

  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;

  if (requireExactPhrase) {
    let matchedForPhrase = searchablePathEntries.slice();

    // Keep ripgrep as an over-approximation for exact phrase mode by requiring
    // each word to appear somewhere in the file, then defer strict phrase
    // validation to the in-memory matcher.
    for (const word of words) {
      if (signal?.aborted) {
        return new Set();
      }

      const matchedForWord = new Set<string>();
      const fileChunks = chunkArray(
        matchedForPhrase.map((entry) => entry.absolutePath),
        RIPGREP_FILE_CHUNK_SIZE,
      );

      let nextChunkIndex = 0;
      const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
          const currentIndex = nextChunkIndex;
          nextChunkIndex += 1;
          const chunkMatches = await runRipgrepFilesWithMatches(word, fileChunks[currentIndex], signal);
          for (const matchedPath of chunkMatches) {
            matchedForWord.add(matchedPath);
          }
        }
      });

      await Promise.all(workers);
      if (signal?.aborted) {
        return new Set();
      }

      matchedForPhrase = matchedForPhrase.filter((entry) => matchedForWord.has(entry.normalizedPath));
      if (matchedForPhrase.length === 0) {
        break;
      }
    }

    return new Set(matchedForPhrase.map((entry) => entry.normalizedPath));
  }

  let remainingEntries = searchablePathEntries.slice();

  // Run one ripgrep pass per term and intersect by keeping only files that
  // matched every query word.
  for (const word of words) {
    if (signal?.aborted) {
      return new Set();
    }

    const matchedForWord = new Set<string>();
    const fileChunks = chunkArray(
      remainingEntries.map((entry) => entry.absolutePath),
      RIPGREP_FILE_CHUNK_SIZE,
    );

    let nextChunkIndex = 0;
    const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
        const currentIndex = nextChunkIndex;
        nextChunkIndex += 1;
        const chunkMatches = await runRipgrepFilesWithMatches(word, fileChunks[currentIndex], signal);
        for (const matchedPath of chunkMatches) {
          matchedForWord.add(matchedPath);
        }
      }
    });

    await Promise.all(workers);
    if (signal?.aborted) {
      return new Set();
    }

    remainingEntries = remainingEntries.filter((entry) => matchedForWord.has(entry.normalizedPath));
    if (remainingEntries.length === 0) {
      break;
    }
  }

  return new Set(remainingEntries.map((entry) => entry.normalizedPath));
}

function addSessionMatch(
  runtime: SearchRuntime,
  matches: SessionConversationMatch[],
  match: SessionConversationMatch,
): void {
  if (runtime.totalMatches >= runtime.limit || matches.length >= MAX_MATCHES_PER_SESSION) {
    return;
  }

  matches.push(match);
  runtime.totalMatches += 1;
}

async function parseClaudeSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  const jsonlPath = session.jsonl_path;
  const fileKey = normalizeComparablePath(jsonlPath ?? '');
  if (!jsonlPath || !fileKey) {
    return null;
  }

  if (!runtime.claudeFileResultsCache.has(fileKey)) {
    const sessionsForFile = runtime.claudeSessionsByFileKey.get(fileKey) || [];
    const matchedSessionsForFile = sessionsForFile.filter((candidate) =>
      runtime.matchedSessionKeys.has(getSessionKey(candidate)),
    );

    const targetSessions = matchedSessionsForFile.length > 0
      ? matchedSessionsForFile
      : [session];

    // Transcript lines are tagged with the provider session id (e.g. Claude's own
    // conversation UUID), which is not necessarily the app-facing `session_id`.
    // Match and attribute by the provider id, but map results back to the
    // internal `session_id` the rest of the app uses to identify sessions.
    const providerToInternalId = new Map<string, string>();
    const customNameBySessionId = new Map<string, string | null>();
    for (const candidate of targetSessions) {
      const providerId = candidate.provider_session_id || candidate.session_id;
      providerToInternalId.set(providerId, candidate.session_id);
      customNameBySessionId.set(providerId, candidate.custom_name ?? null);
    }
    const targetSessionIds = new Set(providerToInternalId.keys());

    type ClaudeSessionSearchState = {
      matches: SessionConversationMatch[];
      pendingSummaries: Map<string, string>;
      fallbackUserText: string | null;
      fallbackAssistantText: string | null;
      resolvedSummary: string | null;
    };

    const sessionStateById = new Map<string, ClaudeSessionSearchState>();
    const getSessionState = (sessionId: string): ClaudeSessionSearchState => {
      if (!sessionStateById.has(sessionId)) {
        sessionStateById.set(sessionId, {
          matches: [],
          pendingSummaries: new Map<string, string>(),
          fallbackUserText: null,
          fallbackAssistantText: null,
          resolvedSummary: null,
        });
      }
      return sessionStateById.get(sessionId) as ClaudeSessionSearchState;
    };

    let currentSessionId: string | null = null;

    try {
      const fileStream = fsSync.createReadStream(jsonlPath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
          break;
        }
        if (!line.trim()) {
          continue;
        }

        let entry: AnyRecord;
        try {
          entry = JSON.parse(line) as AnyRecord;
        } catch {
          continue;
        }

        if (entry.sessionId) {
          currentSessionId = String(entry.sessionId);
        }
        const entrySessionId = entry.sessionId
          ? String(entry.sessionId)
          : currentSessionId;
        if (!entrySessionId || !targetSessionIds.has(entrySessionId)) {
          continue;
        }

        const state = getSessionState(entrySessionId);

        if (entry.type === 'summary' && entry.summary) {
          const summaryValue = String(entry.summary);
          if (entry.sessionId) {
            state.resolvedSummary = summaryValue;
          } else if (entry.leafUuid) {
            state.pendingSummaries.set(String(entry.leafUuid), summaryValue);
          }
        }

        if (!state.resolvedSummary && entry.parentUuid) {
          const pendingSummary = state.pendingSummaries.get(String(entry.parentUuid));
          if (pendingSummary) {
            state.resolvedSummary = pendingSummary;
          }
        }

        const searchableMessage = extractClaudeSearchableMessage(entry);
        if (!searchableMessage) {
          continue;
        }

        const { text, role } = searchableMessage;

        /**
         * Claude compact summaries are the most faithful session-summary source
         * after a `/compact` because they describe the post-compaction state that
         * the resumed session actually continues from. Prefer them over generic
         * fallback user text when present.
         */
        if (entry.isCompactSummary === true) {
          state.resolvedSummary = text;
        }

        if (role === 'user') {
          state.fallbackUserText = text;
        } else {
          state.fallbackAssistantText = text;
        }

        if (!runtime.matchesQuery(text)) {
          continue;
        }

        const { snippet, highlights } = runtime.buildSnippet(text);
        addSessionMatch(runtime, state.matches, {
          role,
          snippet,
          highlights,
          timestamp: entry.timestamp ? String(entry.timestamp) : null,
          provider: 'claude',
          messageUuid: entry.uuid ? String(entry.uuid) : null,
        });
      }
    } catch {
      runtime.claudeFileResultsCache.set(fileKey, new Map());
      return null;
    }

    const fileResults = new Map<string, SessionConversationResult>();
    for (const [sessionId, state] of sessionStateById.entries()) {
      if (state.matches.length === 0) {
        continue;
      }

      const internalSessionId = providerToInternalId.get(sessionId) ?? sessionId;
      fileResults.set(internalSessionId, {
        sessionId: internalSessionId,
        provider: 'claude',
        sessionSummary: toSummaryText(
          customNameBySessionId.get(sessionId) ?? null,
          state.resolvedSummary || state.fallbackUserText || state.fallbackAssistantText,
          'New Session',
        ),
        matches: state.matches,
      });
    }

    runtime.claudeFileResultsCache.set(fileKey, fileResults);
  }

  return runtime.claudeFileResultsCache.get(fileKey)?.get(session.session_id) ?? null;
}

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

async function parseCodexSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  const jsonlPath = session.jsonl_path;
  if (!jsonlPath) {
    return null;
  }

  const matches: SessionConversationMatch[] = [];
  let latestUserMessageText: string | null = null;
  const seenMessageFingerprints = new Set<string>();

  try {
    const fileStream = fsSync.createReadStream(jsonlPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }
      if (!line.trim()) {
        continue;
      }

      let entry: AnyRecord;
      try {
        entry = JSON.parse(line) as AnyRecord;
      } catch {
        continue;
      }

      let text: string | null = null;
      let role: 'user' | 'assistant' | null = null;

      if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
        text = String(entry.payload.message);
        role = 'user';
      } else if (
        entry.type === 'event_msg'
        && entry.payload?.type === 'agent_reasoning'
        && typeof entry.payload?.text === 'string'
      ) {
        text = String(entry.payload.text);
        role = 'assistant';
      } else if (entry.type === 'response_item' && entry.payload?.type === 'message') {
        const payload = entry.payload as AnyRecord;
        if (payload.role === 'user') {
          text = extractCodexText(payload.content);
          role = 'user';
        } else if (payload.role === 'assistant') {
          text = extractCodexText(payload.content);
          role = 'assistant';
        }
      } else if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
        const summaryText = Array.isArray(entry.payload.summary)
          ? entry.payload.summary
            .map((item: AnyRecord) => (typeof item?.text === 'string' ? item.text : ''))
            .filter(Boolean)
            .join('\n')
          : '';

        if (summaryText.trim()) {
          text = summaryText;
          role = 'assistant';
        }
      }

      if (!text || !role) {
        continue;
      }
      if (isInternalCodexContent(text)) {
        continue;
      }
      if (role === 'user') {
        latestUserMessageText = text;
      }

      const fingerprint = `${role}:${text.trim().toLowerCase()}`;
      if (seenMessageFingerprints.has(fingerprint)) {
        continue;
      }
      seenMessageFingerprints.add(fingerprint);

      if (!runtime.matchesQuery(text)) {
        continue;
      }

      const { snippet, highlights } = runtime.buildSnippet(text);
      addSessionMatch(runtime, matches, {
        role,
        snippet,
        highlights,
        timestamp: entry.timestamp ? String(entry.timestamp) : null,
        provider: 'codex',
      });
    }
  } catch {
    return null;
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    sessionId: session.session_id,
    provider: 'codex',
    sessionSummary: toSummaryText(session.custom_name, latestUserMessageText, 'Codex Session'),
    matches,
  };
}

/**
 * Finds OpenCode sessions with at least one text part containing every query
 * word. The `part_session_idx` index narrows the scan to the app's own
 * sessions; the LIKE clauses are only an over-approximation and the exact
 * word matcher runs again while building snippets.
 */
function findOpenCodeMatchingRows(
  sessions: SearchableSessionRow[],
  words: string[],
  signal?: AbortSignal,
): Map<string, OpenCodeSearchRow[]> {
  const rowsBySessionKey = new Map<string, OpenCodeSearchRow[]>();
  const sessionKeyByProviderId = new Map<string, string>();

  for (const session of sessions) {
    if (session.provider !== 'opencode') {
      continue;
    }

    const providerSessionId = typeof session.provider_session_id === 'string'
      ? session.provider_session_id.trim()
      : '';
    const targetId = providerSessionId || session.session_id;
    if (targetId) {
      sessionKeyByProviderId.set(targetId, getSessionKey(session));
    }
  }

  if (sessionKeyByProviderId.size === 0 || words.length === 0 || signal?.aborted) {
    return rowsBySessionKey;
  }

  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return rowsBySessionKey;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return rowsBySessionKey;
  }

  try {
    const providerSessionIds = Array.from(sessionKeyByProviderId.keys());
    const likePatterns = words.map((word) => `%${word}%`);
    const likeClause = likePatterns.map(() => 'p.data LIKE ?').join(' AND ');

    for (const idChunk of chunkArray(providerSessionIds, 400)) {
      if (signal?.aborted) {
        break;
      }

      const placeholders = idChunk.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT
          p.session_id AS session_id,
          p.message_id AS message_id,
          p.data AS part_data,
          p.time_created AS part_time_created,
          m.data AS message_data
        FROM part p
        LEFT JOIN message m ON m.id = p.message_id
        WHERE p.session_id IN (${placeholders})
          AND ${likeClause}
        ORDER BY p.time_created ASC
      `).all(...idChunk, ...likePatterns) as OpenCodeSearchRow[];

      for (const row of rows) {
        const sessionKey = sessionKeyByProviderId.get(row.session_id);
        if (!sessionKey) {
          continue;
        }

        const existing = rowsBySessionKey.get(sessionKey);
        if (existing) {
          existing.push(row);
        } else {
          rowsBySessionKey.set(sessionKey, [row]);
        }
      }
    }
  } catch {
    return rowsBySessionKey;
  } finally {
    db.close();
  }

  return rowsBySessionKey;
}

function parseOpenCodeSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): SessionConversationResult | null {
  const rows = runtime.openCodeRowsBySessionKey.get(getSessionKey(session)) ?? [];
  const matches: SessionConversationMatch[] = [];
  let latestUserMessageText: string | null = null;
  const seenMessageFingerprints = new Set<string>();

  for (const row of rows) {
    if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
      break;
    }

    const partData = readJsonRecord(row.part_data);
    if (readOptionalString(partData?.type) !== 'text') {
      continue;
    }

    const text = unwrapJsonStringLiteral(
      readOptionalString(partData?.text) ?? readOptionalString(partData?.content) ?? '',
    );
    if (!text.trim()) {
      continue;
    }

    const messageInfo = readJsonRecord(row.message_data);
    const role = readOptionalString(messageInfo?.role) === 'user' ? 'user' : 'assistant';
    if (role === 'user') {
      latestUserMessageText = text;
    }

    const fingerprint = `${role}:${text.trim().toLowerCase()}`;
    if (seenMessageFingerprints.has(fingerprint)) {
      continue;
    }
    seenMessageFingerprints.add(fingerprint);

    if (!runtime.matchesQuery(text)) {
      continue;
    }

    const { snippet, highlights } = runtime.buildSnippet(text);
    addSessionMatch(runtime, matches, {
      role,
      snippet,
      highlights,
      timestamp: row.part_time_created ? new Date(row.part_time_created).toISOString() : null,
      provider: 'opencode',
    });
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    sessionId: session.session_id,
    provider: 'opencode',
    sessionSummary: toSummaryText(session.custom_name, latestUserMessageText, 'OpenCode Session'),
    matches,
  };
}

async function parseZcodeSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  if (!session.jsonl_path) {
    return null;
  }

  const matches: SessionConversationMatch[] = [];
  const seenMessageFingerprints = new Set<string>();
  let latestUserMessageText: string | null = null;
  let assistantBuffer: { text: string; timestamp: string | null } | null = null;

  const processText = (text: string, role: 'user' | 'assistant', timestamp: string | null): void => {
    if (!text.trim()) {
      return;
    }
    if (role === 'user') {
      latestUserMessageText = text;
    }

    const fingerprint = `${role}:${text.trim().toLowerCase()}`;
    if (seenMessageFingerprints.has(fingerprint)) {
      return;
    }
    seenMessageFingerprints.add(fingerprint);

    if (!runtime.matchesQuery(text)) {
      return;
    }

    const { snippet, highlights } = runtime.buildSnippet(text);
    addSessionMatch(runtime, matches, {
      role,
      snippet,
      highlights,
      timestamp,
      provider: 'zcode',
    });
  };

  const flushAssistant = (): void => {
    if (assistantBuffer) {
      processText(assistantBuffer.text, 'assistant', assistantBuffer.timestamp);
      assistantBuffer = null;
    }
  };

  const appendAssistant = (delta: string, timestamp: string | null): void => {
    if (!assistantBuffer) {
      assistantBuffer = { text: '', timestamp };
    }
    assistantBuffer.text += delta;
    if (!assistantBuffer.timestamp) {
      assistantBuffer.timestamp = timestamp;
    }
  };

  try {
    const fileStream = fsSync.createReadStream(session.jsonl_path);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }
      if (!line.trim()) {
        continue;
      }

      let event: AnyRecord;
      try {
        event = JSON.parse(line) as AnyRecord;
      } catch {
        continue;
      }

      const timestamp = event.timestamp ? String(event.timestamp) : null;

      if (event.event === 'user') {
        flushAssistant();
        processText(String(event.content ?? ''), 'user', timestamp);
        continue;
      }
      if (event.event === 'text' || event.event === 'agent_response') {
        flushAssistant();
        processText(String(event.content ?? event.text_delta ?? ''), 'assistant', timestamp);
        continue;
      }
      if (event.event === 'stream_delta') {
        appendAssistant(String(event.content ?? ''), timestamp);
        continue;
      }

      const payload = readJsonRecord(event.payload);
      if (
        event.type === 'model.streaming'
        && payload?.kind === 'text_delta'
        && typeof payload.delta === 'string'
      ) {
        appendAssistant(payload.delta, timestamp);
        continue;
      }

      const step = readJsonRecord(event.step_update);
      if (
        event.event === 'step_update'
        && step?.step_type === 'agent_response'
        && typeof step.text_delta === 'string'
      ) {
        appendAssistant(step.text_delta, timestamp);
        continue;
      }

      if (typeof event.text_delta === 'string') {
        appendAssistant(event.text_delta, timestamp);
        continue;
      }

      flushAssistant();
    }

    flushAssistant();
  } catch {
    return null;
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    sessionId: session.session_id,
    provider: 'zcode',
    sessionSummary: toSummaryText(session.custom_name, latestUserMessageText, 'ZCode Session'),
    matches,
  };
}

async function parseSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  if (session.provider === 'claude') {
    return parseClaudeSessionMatches(session, runtime);
  }
  if (session.provider === 'codex') {
    return parseCodexSessionMatches(session, runtime);
  }
  if (session.provider === 'opencode') {
    return parseOpenCodeSessionMatches(session, runtime);
  }
  if (session.provider === 'zcode') {
    return parseZcodeSessionMatches(session, runtime);
  }
  return null;
}

/**
 * Searches session titles and provider transcripts for the provider search
 * service and its route-level integration tests.
 */
export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
  onTitleResults: ((results: SessionTitleSearchResult[]) => void) | null = null,
): Promise<{
  results: ProjectConversationResult[];
  titleResults: SessionTitleSearchResult[];
  totalMatches: number;
  query: string;
}> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const words = safeQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0);

  if (words.length === 0) {
    return { results: [], titleResults: [], totalMatches: 0, query: safeQuery };
  }

  const isAborted = () => signal?.aborted === true;
  if (isAborted()) {
    return { results: [], titleResults: [], totalMatches: 0, query: safeQuery };
  }

  const activeSessions = sessionsDb.getAllSessions();
  const titleResults = findSessionTitleResults(activeSessions, safeQuery, safeLimit);
  onTitleResults?.(titleResults);

  const searchableSessions = normalizeSearchableSessions(activeSessions);
  if (searchableSessions.length === 0) {
    return { results: [], titleResults, totalMatches: 0, query: safeQuery };
  }

  const sessionsByPathKey = new Map<string, SearchableSessionRow[]>();
  const searchablePathEntries: SearchablePathEntry[] = [];

  for (const session of searchableSessions) {
    if (!session.jsonl_path) {
      continue;
    }

    const normalizedPath = normalizeComparablePath(session.jsonl_path);
    if (!normalizedPath) {
      continue;
    }

    if (!sessionsByPathKey.has(normalizedPath)) {
      sessionsByPathKey.set(normalizedPath, []);
      searchablePathEntries.push({
        normalizedPath,
        absolutePath: session.jsonl_path,
      });
    }

    const pathSessions = sessionsByPathKey.get(normalizedPath) as SearchableSessionRow[];
    pathSessions.push(session);
  }

  const matchedFileKeys = await findMatchedFileKeys(
    searchablePathEntries,
    safeQuery,
    words,
    signal ?? undefined,
  );
  if (isAborted()) {
    return { results: [], titleResults, totalMatches: 0, query: safeQuery };
  }

  const matchedSessionKeys = new Set<string>();
  for (const fileKey of matchedFileKeys) {
    const sessions = sessionsByPathKey.get(fileKey);
    if (!sessions) {
      continue;
    }

    for (const session of sessions) {
      matchedSessionKeys.add(getSessionKey(session));
    }
  }

  const openCodeRowsBySessionKey = findOpenCodeMatchingRows(
    searchableSessions,
    words,
    signal ?? undefined,
  );
  for (const sessionKey of openCodeRowsBySessionKey.keys()) {
    matchedSessionKeys.add(sessionKey);
  }

  if (matchedSessionKeys.size === 0) {
    return { results: [], titleResults, totalMatches: 0, query: safeQuery };
  }

  const projectBuckets = buildProjectBuckets(searchableSessions);
  const totalProjects = projectBuckets.length;
  const results: ProjectConversationResult[] = [];
  let scannedProjects = 0;

  const runtime: SearchRuntime = {
    ...createWordMatcher(safeQuery, words),
    limit: safeLimit,
    totalMatches: 0,
    isAborted,
    matchedSessionKeys,
    claudeSessionsByFileKey: new Map<string, SearchableSessionRow[]>(),
    claudeFileResultsCache: new Map<string, Map<string, SessionConversationResult>>(),
    openCodeRowsBySessionKey,
  };

  for (const [fileKey, sessions] of sessionsByPathKey.entries()) {
    const claudeSessions = sessions.filter((session) => session.provider === 'claude');
    if (claudeSessions.length > 0) {
      runtime.claudeSessionsByFileKey.set(fileKey, claudeSessions);
    }
  }

  for (const bucket of projectBuckets) {
    if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
      break;
    }

    const projectResult: ProjectConversationResult = {
      projectId: bucket.projectId,
      projectName: bucket.projectName,
      projectDisplayName: bucket.projectDisplayName,
      sessions: [],
    };

    for (const session of bucket.sessions) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }
      if (!matchedSessionKeys.has(getSessionKey(session))) {
        continue;
      }

      const sessionResult = await parseSessionMatches(session, runtime);
      if (sessionResult) {
        projectResult.sessions.push(sessionResult);
      }
    }

    scannedProjects += 1;
    if (projectResult.sessions.length > 0) {
      results.push(projectResult);
      onProjectResult?.({
        projectResult,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    } else if (onProjectResult && scannedProjects % 10 === 0) {
      onProjectResult({
        projectResult: null,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    }
  }

  return {
    results,
    titleResults,
    totalMatches: runtime.totalMatches,
    query: safeQuery,
  };
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<void> {
    await searchConversations(
      input.query,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
      input.onTitleResults ?? null,
    );
  },
};

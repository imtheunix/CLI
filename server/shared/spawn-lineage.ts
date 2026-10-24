import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';

/**
 * Spawn-lineage detection for sessions discovered on disk.
 *
 * Claude Code exports `CLAUDE_CODE_SESSION_ID=<its own provider session id>`
 * into every process it starts, and a provider CLI keeps its transcript file
 * open as a file descriptor for the whole run. So while a discovered
 * transcript is still being written, the process holding it open can be found
 * in `/proc`, and its environment names the Claude session whose shell started
 * it — the spawning parent.
 */

/** Default `/proc` mount the scanner reads; injectable so tests can point it at a fixture tree. */
const DEFAULT_PROC_ROOT = '/proc';

/** Process cap: one discovery scan must stay cheap even on a busy machine. */
const DEFAULT_MAX_PROCESSES = 512;

/** File-descriptor cap per process, so one process with thousands of fds cannot dominate a scan. */
const DEFAULT_MAX_FDS_PER_PROCESS = 1024;

const ENVIRONMENT_VARIABLE_NAME = 'CLAUDE_CODE_SESSION_ID';

/** Every fs/process input the scanner needs, overridable for tests. */
export type SpawnLineageDependencies = {
  platform?: NodeJS.Platform;
  procRoot?: string;
  maxProcesses?: number;
  maxFileDescriptorsPerProcess?: number;
  readdirSync?: typeof readdirSync;
  readFileSync?: typeof readFileSync;
  readlinkSync?: typeof readlinkSync;
  statSync?: typeof statSync;
  getuid?: () => number;
};

function readClaudeCodeSessionId(
  environPath: string,
  readFile: typeof readFileSync,
): string | null {
  // /proc environ entries are NUL-separated KEY=VALUE records.
  const entries = readFile(environPath).toString().split('\0');
  const prefix = `${ENVIRONMENT_VARIABLE_NAME}=`;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      const value = entry.slice(prefix.length).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Finds the provider session id that spawned the process writing one transcript.
 *
 * Used by the providers module's session synchronizers when they create a NEW
 * row for a discovered transcript: while the transcript is being written, its
 * process is alive, so scanning `/proc` for the process that holds the file
 * open and reading `CLAUDE_CODE_SESSION_ID` from its environment names the
 * parent Claude session. Returns null everywhere except Linux, on any error,
 * when no such process exists, or when the only value found is the
 * `ownProviderSessionId` the caller passed (that process is the session
 * itself, not its parent). Never throws and never reads anything outside the
 * process table: this runs inside discovery, which must not be blocked.
 */
export function findSpawningProviderSessionId(
  transcriptPath: string,
  ownProviderSessionId?: string,
  deps: SpawnLineageDependencies = {},
): string | null {
  const {
    platform = process.platform,
    procRoot = DEFAULT_PROC_ROOT,
    maxProcesses = DEFAULT_MAX_PROCESSES,
    maxFileDescriptorsPerProcess = DEFAULT_MAX_FDS_PER_PROCESS,
    readdirSync: readdir = readdirSync,
    readFileSync: readFile = readFileSync,
    readlinkSync: readlink = readlinkSync,
    statSync: stat = statSync,
    getuid = process.getuid?.bind(process),
  } = deps;

  // /proc semantics exist only on Linux; elsewhere there is nothing to find.
  if (platform !== 'linux') {
    return null;
  }

  try {
    const ownUid = getuid?.();
    let scanned = 0;

    for (const entry of readdir(procRoot, { withFileTypes: true }) as Dirent[]) {
      if (scanned >= maxProcesses) {
        break;
      }
      // Only numeric directories are processes; everything else in /proc is metadata.
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        continue;
      }
      scanned += 1;

      const pidRoot = `${procRoot}/${entry.name}`;
      try {
        // Another user's /proc/<pid>/fd is unreadable (and irrelevant), so
        // skip it before touching any file descriptor.
        if (ownUid !== undefined && stat(pidRoot).uid !== ownUid) {
          continue;
        }

        let holdsTranscript = false;
        const fdRoot = `${pidRoot}/fd`;
        let fdsScanned = 0;
        for (const fd of readdir(fdRoot, { withFileTypes: true }) as Dirent[]) {
          if (fdsScanned >= maxFileDescriptorsPerProcess) {
            break;
          }
          fdsScanned += 1;
          // readlink is the cheap check: it resolves one symlink and nothing else.
          if (readlink(`${fdRoot}/${fd.name}`) === transcriptPath) {
            holdsTranscript = true;
            break;
          }
        }
        if (!holdsTranscript) {
          continue;
        }

        const parentProviderSessionId = readClaudeCodeSessionId(`${pidRoot}/environ`, readFile);
        // A process reporting the session's own id is the session itself (or a
        // launcher re-exporting it), not the parent; keep scanning for a real one.
        if (parentProviderSessionId && parentProviderSessionId !== ownProviderSessionId) {
          return parentProviderSessionId;
        }
      } catch {
        // A process can exit (or lock its fds) between the listing and the
        // read; it is simply no longer a candidate.
      }
    }
  } catch {
    // An unreadable /proc root means no lineage can be found, not an error.
    return null;
  }

  return null;
}

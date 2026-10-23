import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_TEXT_BYTES = 128 * 1024;

type JobRecord = {
  id: string; title: string; tool: 'codex' | 'agy' | 'claude';
  machine: 'workstation' | 'archsv'; startedAt: string;
  status: 'queued' | 'running' | 'done' | 'failed'; finishedAt?: string;
  logPath?: string; summaryPath?: string; inferred?: boolean;
};

function parseRecord(value: unknown): JobRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as JobRecord;
  if (typeof record.id !== 'string' || !record.id || typeof record.title !== 'string'
    || !['codex', 'agy', 'claude'].includes(record.tool)
    || !['workstation', 'archsv'].includes(record.machine)
    || !['queued', 'running', 'done', 'failed'].includes(record.status)
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
    || (record.logPath !== undefined && typeof record.logPath !== 'string')
    || (record.summaryPath !== undefined && typeof record.summaryPath !== 'string')) return null;
  return record;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function remoteReadCommand(filePath: string): string {
  // Reject traversal before normalization. The remote realpath check also rejects
  // symlinks escaping the two allowed roots, including absolute record paths.
  if (!/^(~\/|\/)[A-Za-z0-9_./ @+-]+$/.test(filePath) || filePath.split('/').includes('..')) {
    throw new Error('Remote job path is outside the allowed roots');
  }
  if (filePath.startsWith('~/') && !/^~\/(research|\.local\/state)(\/|$)/.test(filePath)) {
    throw new Error('Remote job path is outside the allowed roots');
  }
  return `p=${shellQuote(filePath)}; case "$p" in '~/'*) p="$HOME/\${p#\\~/}";; esac; p=$(realpath -e -- "$p") || exit 1; case "$p" in "$HOME/research/"*|"$HOME/.local/state/"*) tail -c ${MAX_TEXT_BYTES} -- "$p";; *) exit 1;; esac`;
}

async function tailLocal(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Job output must be a regular file');
    const buffer = Buffer.alloc(Math.min(MAX_TEXT_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

/** Used by authenticated background-job routes; reads records and output without managing processes. */
export function createBackgroundJobsService(options: {
  home?: string;
  now?: () => number;
  remoteRead?: (command: string) => Promise<string>;
} = {}) {
  const home = options.home ?? os.homedir();
  const recordsDirectory = path.join(home, '.local/state/agent-jobs');
  const now = options.now ?? Date.now;
  const remoteRead = options.remoteRead ?? (async (command: string) => {
    const { stdout } = await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'archsv', command], {
      timeout: 10_000, maxBuffer: MAX_TEXT_BYTES + 4096,
    });
    return stdout;
  });

  async function list(): Promise<JobRecord[]> {
    const records: JobRecord[] = [];
    const files = await fs.readdir(recordsDirectory).catch(() => [] as string[]);
    await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
      try {
        const location = path.join(recordsDirectory, file);
        if ((await fs.stat(location)).size > MAX_TEXT_BYTES) return;
        const record = parseRecord(JSON.parse(await fs.readFile(location, 'utf8')));
        if (record) records.push(record);
      } catch { /* A writer may be replacing a record; try again on the next poll. */ }
    }));
    // Native exec files are an activity hint, not an authoritative job lifecycle.
    for (const offset of [0, 86_400_000]) {
      const date = new Date(now() - offset).toISOString().slice(0, 10).split('-');
      const directory = path.join(home, '.codex/sessions', ...date);
      for (const file of await fs.readdir(directory).catch(() => [] as string[])) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const location = path.join(directory, file);
          const stat = await fs.stat(location);
          if (now() - stat.mtimeMs > 120_000 || !stat.isFile()) continue;
          const handle = await fs.open(location, 'r');
          let first = '';
          try { const buffer = Buffer.alloc(16_384); const read = await handle.read(buffer, 0, buffer.length, 0); first = buffer.subarray(0, read.bytesRead).toString(); }
          finally { await handle.close(); }
          const metadata = JSON.parse(first.split('\n')[0])?.payload;
          if (metadata?.source !== 'exec' && metadata?.originator !== 'codex_exec') continue;
          const id = `native:${metadata.id ?? file}`;
          if (records.some((record) => record.id === metadata.id)) continue;
          records.push({ id, title: 'Codex exec · recent file activity', tool: 'codex', machine: 'workstation', startedAt: new Date(stat.mtimeMs).toISOString(), status: 'running', logPath: location, inferred: true });
        } catch { /* Ignore incomplete metadata. */ }
      }
    }
    return records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  return {
    list,
    async detail(id: string) {
      const job = (await list()).find((record) => record.id === id);
      if (!job) return null;
      const read = async (filePath?: string) => {
        if (!filePath) return '';
        return job.machine === 'archsv' ? remoteRead(remoteReadCommand(filePath))
          : tailLocal(filePath.startsWith('~/') ? path.join(home, filePath.slice(2)) : filePath);
      };
      const [log, summary] = await Promise.all([read(job.logPath), job.status === 'done' || job.status === 'failed' ? read(job.summaryPath) : Promise.resolve('')]);
      // Output is bounded and treated as plain text by the client.
      return { job, log, summary };
    },
  };
}

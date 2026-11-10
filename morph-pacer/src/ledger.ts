import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LedgerEntry {
  ts: string;
  model: string;
  uncached_in: number;
  cached_in: number;
  out: number;
  reasoning: number;
  status: number;
  wait_ms: number;
  retries: number;
  stream: boolean;
  cache_ttl: string | null;
  run_id_set: boolean;
}

export class Ledger {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {}

  append(entry: LedgerEntry): Promise<void> {
    const run = this.tail.then(() => this.write(entry));
    this.tail = run.catch(() => {});
    return run;
  }

  private async write(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const info = await stat(this.path);
      if (info.size >= this.maxBytes) {
        await rename(this.path, `${this.path}.1`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

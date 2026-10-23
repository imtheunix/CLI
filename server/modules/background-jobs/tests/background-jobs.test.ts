import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createBackgroundJobsService } from '../background-jobs.service.js';

async function fixture(run: (home: string, records: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'background-jobs-'));
  const records = path.join(home, '.local/state/agent-jobs');
  await mkdir(records, { recursive: true });
  try { await run(home, records); } finally { await rm(home, { recursive: true, force: true }); }
}

const record = (id: string, extra = {}) => ({ id, title: `Job ${id}`, tool: 'codex', machine: 'workstation', startedAt: '2026-10-23T10:00:00Z', status: 'running', ...extra });

test('records sort newest first, malformed records are ignored, status and completed summary refresh', async () => {
  await fixture(async (home, records) => {
    const logPath = path.join(home, 'job.log');
    const summaryPath = path.join(home, 'summary.txt');
    await writeFile(logPath, 'x'.repeat(150_000) + '\nlast line');
    await writeFile(summaryPath, 'Finished successfully');
    await writeFile(path.join(records, 'older.json'), JSON.stringify(record('older')));
    await writeFile(path.join(records, 'newer.json'), JSON.stringify(record('newer', { startedAt: '2026-10-23T11:00:00Z', logPath, summaryPath })));
    await writeFile(path.join(records, 'partial.json'), '{');
    await writeFile(path.join(records, 'invalid.json'), JSON.stringify(record('bad', { status: 'unknown' })));
    const service = createBackgroundJobsService({ home });
    assert.deepEqual((await service.list()).map((job) => job.id), ['newer', 'older']);
    const running = await service.detail('newer');
    assert.ok(running?.log.endsWith('last line'));
    assert.ok(Buffer.byteLength(running!.log) <= 128 * 1024);
    assert.equal(running?.summary, '');
    await writeFile(path.join(records, 'newer.json'), JSON.stringify(record('newer', { status: 'done', logPath, summaryPath })));
    assert.equal((await service.detail('newer'))?.summary, 'Finished successfully');
    assert.equal((await service.list()).find((job) => job.id === 'newer')?.status, 'done');
    assert.equal(await service.detail('missing'), null);
  });
});

test('archsv reads use only allowed roots and reject traversal, shell injection and escaping symlinks', async () => {
  await fixture(async (home, records) => {
    await mkdir(path.join(home, 'research'), { recursive: true });
    await writeFile(path.join(home, 'research/job.log'), 'remote output');
    const commands: string[] = [];
    const service = createBackgroundJobsService({ home, remoteRead: async (command) => {
      commands.push(command);
      // Execute the same read-only command locally in a fake remote home to
      // exercise both quoting and canonical-path restrictions without SSH.
      return execFileSync('bash', ['-c', command], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    } });
    const location = path.join(records, 'remote.json');
    for (const logPath of ['~/research/job.log', path.join(home, 'research/job.log')]) {
      await writeFile(location, JSON.stringify(record('remote', { machine: 'archsv', logPath })));
      assert.equal((await service.detail('remote'))?.log, 'remote output');
    }
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc/passwd', path.join(home, 'research/escape'));
    for (const logPath of ['~/research/../secret', '~/other/log', '/etc/passwd', '~/research/escape', '~/research/$(touch pwned)', "~/research/a'; touch pwned; '"]) {
      await writeFile(location, JSON.stringify(record('remote', { machine: 'archsv', logPath })));
      await assert.rejects(service.detail('remote'));
    }
    assert.ok(commands.every((command) => command.includes('realpath -e') && command.includes('tail -c')));
  });
});

test('recent native Codex exec activity is discoverable but old files and interactive sessions are excluded', async () => {
  await fixture(async (home) => {
    const now = Date.now();
    const directory = path.join(home, '.codex/sessions', ...new Date(now).toISOString().slice(0, 10).split('-'));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'recent.jsonl'), JSON.stringify({ payload: { id: 'native-id', source: 'exec' } }) + '\n');
    await writeFile(path.join(directory, 'interactive.jsonl'), JSON.stringify({ payload: { id: 'interactive', source: 'cli' } }) + '\n');
    const service = createBackgroundJobsService({ home, now: () => now });
    const jobs = await service.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 'native:native-id');
    assert.equal(jobs[0].inferred, true);
    assert.equal((await createBackgroundJobsService({ home, now: () => now + 121_000 }).list()).length, 0);
  });
});

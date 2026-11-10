import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  orchestratorJobsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { clearScanCache } from '@/modules/providers/index.js';

import { createJobsService } from '../services/jobs.service.js';

test('orchestrator job view attaches usage from transcript with notional USD', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'orchestrator-job-usage-'));
  const dbPath = path.join(tempDir, 'test.db');
  const transcriptPath = path.join(tempDir, 'transcript.jsonl');

  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  try {
    // Write synthetic transcript with GLM Flash
    await writeFile(filePath(transcriptPath), [
      JSON.stringify({
        type: 'session.updated',
        payload: { modelId: 'GLM-5.3-Flash' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        payload: {
          resultType: 'success',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300 },
        },
      }),
    ].join('\n'));

    // Create session and job rows
    const sessionId = sessionsDb.createSession(
      'sess-usage-1',
      'zcode',
      tempDir,
      'Usage Test Session',
      undefined,
      undefined,
      transcriptPath,
    );
    sessionsDb.setSessionModel(sessionId, 'GLM-5.3-Flash');

    const job = orchestratorJobsDb.create({
      id: 'job-usage-test',
      title: 'Usage Test Job',
      prompt: 'do work',
      repoPath: tempDir,
      baseBranch: 'main',
      branch: 'feature/usage',
      worktreePath: tempDir,
      requestedBackend: 'zcode',
      model: 'GLM-5.3-Flash',
    });
    orchestratorJobsDb.update(job.id, { session_id: sessionId });

    const jobs = createJobsService({
      probeZcode: async () => ({ ok: true }),
      runtime: {
        hasRuntime: () => true,
        run: async () => {},
        abort: async () => true,
        supportsInjection: () => false,
        stopBackgroundTask: async () => true,
        hasBackgroundWork: () => false,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
      config: () => ({
        backends: {
          zcode: { provider: 'zcode', model: 'GLM-5.3-Flash', models: { 'GLM-5.3-Flash': 'GLM Flash' }, cap: 3, label: 'GLM', effort: null },
          claude: { provider: 'claude', model: 'claude-opus-5-5', models: {}, cap: 1, label: 'Claude', effort: null },
          codex: { provider: 'codex', model: 'gpt-6.1-terra', models: {}, cap: 1, label: 'GPT', effort: null },
          glm: { provider: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', models: {}, cap: 3, label: 'GLM', effort: null },
          agy: { provider: 'agy', model: 'gemini-3.8-flash-medium', models: {}, cap: 2, label: 'Agy', effort: null },
          morph: { provider: 'opencode', model: 'morph/morph-dsv41flash', models: {}, cap: 2, label: 'Morph', effort: null },
        },
        fallbackBackend: 'glm',
        glmQuotaFallback: 'wait',
        codexQuotaFallback: 'wait',
        glmProvider: 'zcode',
        worktreesRoot: tempDir,
        workspacesRoot: tempDir,
        conflictResolver: { command: 'agy', model: 'gemini-3.8-flash-medium' },
        checks: {},
        cleanup: { buildDirs: {} },
        jobGuidance: {},
        modelGuidance: {},
        maxConcurrentChecks: 1,
        waitForDeploy: {},
        baseBranches: {},
        forgejo: { apiUrl: '', tokenFile: '' },
        glmPeakHours: { avoid: false, utcOffsetHours: 0, fromHour: 0, toHour: 0 },
        morph: { caps: { kimi: { uncachedIn: 1, out: 1 }, deepseek: { uncachedIn: 1, out: 1 } }, admitBelow: 0.7 },
        review: {
          enabled: true, refuteCap: 2, refuteTimeoutMs: 20 * 60_000, refuteTimeoutMin: 20, maxLines: 400,
          protectedRepos: [], riskyPaths: [], deepPaths: [],
          tiers: { gateMaxLines: 50, docsGlobs: ['**/*.md'], testGlobs: ['**/*.test.ts'] },
          refuteBackendFor: {},
        },
      }),
    });

    const jobView = jobs.get('job-usage-test');
    assert.ok(jobView);
    assert.ok(jobView.usage);
    // Zcode input_tokens already includes cached tokens, never add cacheRead on top
    assert.equal(jobView.usage.inputTokens, 1000);
    assert.equal(jobView.usage.outputTokens, 200);
    assert.equal(jobView.usage.cacheReadTokens, 300);
    assert.equal(jobView.usage.cacheTokens, 300);
    assert.equal(jobView.usage.model, 'GLM-5.3-Flash');
    assert.equal(jobView.usage.costSource, 'notional');
    assert.equal(jobView.usage.isNotional, true);
    assert.ok(typeof jobView.usage.notionalCostUsd === 'number');
    assert.ok(jobView.usage.notionalCostUsd > 0);
  } finally {
    closeConnection();
    delete process.env.DATABASE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  }
});

function filePath(p: string): string {
  return p;
}

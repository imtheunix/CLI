// @vitest-environment node
// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import { afterAll, describe, expect, test } from 'vitest';
import {
  case1AutopilotQuestion,
  case2TouchedTestsGuidance,
  case3HubResumeReattach,
  case4CancelledBranchMerge,
  case5ZcodeReasoningLevel,
} from './index.js';
import { formatSummaryTable, getRecordedSummaries, recordSummary } from './summary.js';

describe('evals/harness: regression evals replayed against live prompt and schemas', () => {
  test('(1) a job asked a blocking question in autopilot', async () => {
    const result = await case1AutopilotQuestion.run();
    recordSummary({
      id: case1AutopilotQuestion.id,
      name: case1AutopilotQuestion.name,
      kind: case1AutopilotQuestion.kind,
      promptHash: result.promptHash,
      tokenCount: result.tokenCount,
      passed: result.pass,
      reason: result.reason,
    });
    expect(result.pass).toBe(true);
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test('(2) a job ran the full test suite instead of only touched tests (jobGuidance rule)', async () => {
    const result = await case2TouchedTestsGuidance.run();
    recordSummary({
      id: case2TouchedTestsGuidance.id,
      name: case2TouchedTestsGuidance.name,
      kind: case2TouchedTestsGuidance.kind,
      promptHash: result.promptHash,
      tokenCount: result.tokenCount,
      passed: result.pass,
      reason: result.reason,
    });
    expect(result.pass).toBe(true);
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test('(3) hub resume while the CLI re-attached the same turn (duplicate instance)', async () => {
    const result = await case3HubResumeReattach.run();
    recordSummary({
      id: case3HubResumeReattach.id,
      name: case3HubResumeReattach.name,
      kind: case3HubResumeReattach.kind,
      promptHash: result.promptHash,
      tokenCount: result.tokenCount,
      passed: result.pass,
      reason: result.reason,
    });
    expect(result.pass).toBe(true);
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test("(4) a branch based on a cancelled job's branch was marked merged", async () => {
    const result = await case4CancelledBranchMerge.run();
    recordSummary({
      id: case4CancelledBranchMerge.id,
      name: case4CancelledBranchMerge.name,
      kind: case4CancelledBranchMerge.kind,
      promptHash: result.promptHash,
      tokenCount: result.tokenCount,
      passed: result.pass,
      reason: result.reason,
    });
    expect(result.pass).toBe(true);
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test('(5) Zcode reasoningLevel missing selected full GLM', async () => {
    const result = await case5ZcodeReasoningLevel.run();
    recordSummary({
      id: case5ZcodeReasoningLevel.id,
      name: case5ZcodeReasoningLevel.name,
      kind: case5ZcodeReasoningLevel.kind,
      promptHash: result.promptHash,
      tokenCount: result.tokenCount,
      passed: result.pass,
      reason: result.reason,
    });
    expect(result.pass).toBe(true);
    expect(result.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  afterAll(() => {
    const summaries = getRecordedSummaries();
    console.log('\n--- EVALS/HARNESS RUN SUMMARY ---');
    console.log(formatSummaryTable(summaries));
    console.log('--------------------------------\n');
  });
});

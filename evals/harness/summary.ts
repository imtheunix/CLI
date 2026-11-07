// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import crypto from 'node:crypto';
import type { CaseSummary } from './types.js';

const recordedSummaries: CaseSummary[] = [];

/** Computes a short 12-hex hash of prompt text. */
export function calculatePromptHash(prompt: string): string {
  return crypto.createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 12);
}

/**
 * Estimates token count from text using standard whitespace and character heuristics
 * (~4 characters per token for English text and code).
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Fallback heuristic: 1 token ~= 4 chars or 0.75 words, whichever is more conservative.
  const byChars = Math.ceil(text.length / 4);
  const words = text.trim().split(/\s+/).length;
  const byWords = Math.ceil(words * 1.3);
  return Math.max(byChars, byWords);
}

/** Records a test case evaluation result for the run summary. */
export function recordSummary(summary: CaseSummary): void {
  const existing = recordedSummaries.findIndex((s) => s.id === summary.id);
  if (existing >= 0) {
    recordedSummaries[existing] = summary;
  } else {
    recordedSummaries.push(summary);
  }
}

/** Returns all recorded summaries for this session. */
export function getRecordedSummaries(): readonly CaseSummary[] {
  return recordedSummaries;
}

/** Clears recorded summaries (useful between test runs). */
export function resetSummaries(): void {
  recordedSummaries.length = 0;
}

/** Formats recorded summaries into a readable Markdown table. */
export function formatSummaryTable(summaries: readonly CaseSummary[] = recordedSummaries): string {
  const rows = [
    '| Case ID | Name | Kind | Prompt Hash | Tokens | Status | Reason |',
    '|---|---|---|---|---|---|---|',
    ...summaries.map((s) =>
      `| \`${s.id}\` | ${s.name} | ${s.kind} | \`${s.promptHash}\` | ${s.tokenCount.toLocaleString()} | ${s.passed ? 'PASS' : 'FAIL'} | ${s.reason.replace(/\|/g, '\\|')} |`
    ),
  ];
  return rows.join('\n');
}

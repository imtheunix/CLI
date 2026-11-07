// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import type { OrchestratorJobRow } from '@/modules/database/index.js';

export type HarnessCaseKind = 'bad' | 'guard' | 'control';

export type SyntheticTurn = {
  role: 'user' | 'assistant' | 'system';
  content?: string;
  toolCalls?: Array<{
    tool: string;
    input?: Record<string, unknown>;
    result?: unknown;
  }>;
};

export type HarnessCaseSetup = {
  job: Partial<OrchestratorJobRow>;
  label?: string;
  projectMapGuidance?: string;
  continuation?: boolean;
  repoGuidance?: string;
  priorTurns?: SyntheticTurn[];
  world?: {
    files?: Record<string, string>;
    branch?: string;
    baseBranch?: string;
    commits?: Array<{ sha: string; subject: string }>;
    touchedFiles?: string[];
  };
  permissionMode?: string;
};

export type CaseResult = {
  pass: boolean;
  reason: string;
  promptHash: string;
  tokenCount: number;
  assembledPrompt: string;
  details?: Record<string, unknown>;
};

export type HarnessCase = {
  id: string;
  name: string;
  kind: HarnessCaseKind;
  experience: string;
  source: string;
  setup: HarnessCaseSetup;
  run: (options?: { model?: string }) => Promise<CaseResult> | CaseResult;
};

export type CaseSummary = {
  id: string;
  name: string;
  kind: HarnessCaseKind;
  promptHash: string;
  tokenCount: number;
  passed: boolean;
  reason: string;
};

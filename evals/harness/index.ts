// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
export * from './types.js';
export * from './summary.js';
export * from './runner.js';
export { case1AutopilotQuestion } from './cases/case-1-autopilot-question.js';
export { case2TouchedTestsGuidance } from './cases/case-2-touched-tests-guidance.js';
export { case3HubResumeReattach } from './cases/case-3-hub-resume-reattach.js';
export { case4CancelledBranchMerge } from './cases/case-4-cancelled-branch-merge.js';
export { case5ZcodeReasoningLevel } from './cases/case-5-zcode-reasoning-level.js';

import { case1AutopilotQuestion } from './cases/case-1-autopilot-question.js';
import { case2TouchedTestsGuidance } from './cases/case-2-touched-tests-guidance.js';
import { case3HubResumeReattach } from './cases/case-3-hub-resume-reattach.js';
import { case4CancelledBranchMerge } from './cases/case-4-cancelled-branch-merge.js';
import { case5ZcodeReasoningLevel } from './cases/case-5-zcode-reasoning-level.js';
import type { HarnessCase } from './types.js';

export const ALL_HARNESS_CASES: readonly HarnessCase[] = [
  case1AutopilotQuestion,
  case2TouchedTestsGuidance,
  case3HubResumeReattach,
  case4CancelledBranchMerge,
  case5ZcodeReasoningLevel,
];

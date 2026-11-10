import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createClaudeTurnLineParser } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { createCodexTurnLineParser } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

type Sent = NormalizedMessage[];

const writerFor = (sent: Sent) => ({
  send: (message: NormalizedMessage) => { sent.push(message); },
  setSessionId: () => {},
  getSessionId: () => null,
});

const tokenBudgets = (sent: Sent) => sent
  .filter((message) => message.kind === 'status' && message.text === 'token_budget')
  .map((message) => message.tokenBudget as Record<string, unknown>);

const claudeAssistant = (outputTokens: number) => JSON.stringify({
  type: 'assistant',
  session_id: 'native-1',
  message: {
    role: 'assistant',
    model: 'claude-x',
    content: [],
    usage: { input_tokens: 10, output_tokens: outputTokens },
  },
});

test('Claude publishes a measured rate from the turn cumulative output', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const sent: Sent = [];
    const parser = createClaudeTurnLineParser(() => []);
    const writer = writerFor(sent);

    mock.timers.tick(1_000);
    parser(claudeAssistant(100), writer as never, 'app-1');
    mock.timers.tick(1_000);
    parser(claudeAssistant(100), writer as never, 'app-1');

    const budgets = tokenBudgets(sent);
    assert.equal(budgets.length, 2);
    assert.equal(budgets[0]?.outputTokensPerSecond, 100, '100 output tokens over the first second');
    assert.equal(budgets[1]?.outputTokensPerSecond, 100, '200 cumulative tokens over two seconds');
    assert.equal(budgets[1]?.outputTokens, 100, 'the context budget still reports the request output');
  } finally {
    mock.timers.reset();
  }
});

test('Claude leaves the rate unavailable in a window too short to measure', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const sent: Sent = [];
    const parser = createClaudeTurnLineParser(() => []);
    const writer = writerFor(sent);

    mock.timers.tick(100);
    parser(claudeAssistant(100), writer as never, 'app-1');

    const [budget] = tokenBudgets(sent);
    assert.ok(budget);
    assert.equal(budget.outputTokensPerSecond, undefined);
  } finally {
    mock.timers.reset();
  }
});

test('Claude starts a fresh rate window when a turn resumes after its result', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const sent: Sent = [];
    const parser = createClaudeTurnLineParser(() => []);
    const writer = writerFor(sent);

    mock.timers.tick(1_000);
    parser(claudeAssistant(100), writer as never, 'app-1');
    parser(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'native-1' }), writer as never, 'app-1');

    // The resumed turn's first row lands immediately: no window yet.
    parser(claudeAssistant(50), writer as never, 'app-1');
    mock.timers.tick(1_000);
    parser(claudeAssistant(50), writer as never, 'app-1');

    const budgets = tokenBudgets(sent);
    assert.equal(budgets.at(-2)?.outputTokensPerSecond, undefined, 'the resumed turn does not inherit the old window');
    assert.equal(budgets.at(-1)?.outputTokensPerSecond, 100, '100 tokens over the resumed turn\'s first second');
  } finally {
    mock.timers.reset();
  }
});

test('Claude falls back to the result bill for the rate when no assistant usage arrived', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const sent: Sent = [];
    const parser = createClaudeTurnLineParser(() => []);
    const writer = writerFor(sent);

    mock.timers.tick(2_000);
    parser(JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'native-1',
      usage: { input_tokens: 10, output_tokens: 300 },
    }), writer as never, 'app-1');

    const [budget] = tokenBudgets(sent);
    assert.ok(budget);
    assert.equal(budget.outputTokens, 300);
    assert.equal(budget.outputTokensPerSecond, 150);
  } finally {
    mock.timers.reset();
  }
});

test('Codex measures the rate over the turn it reports usage for', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const sent: Sent = [];
    const parser = createCodexTurnLineParser(() => []);
    const writer = writerFor(sent);

    parser(JSON.stringify({ type: 'turn.started' }), writer as never, 'app-1');
    mock.timers.tick(2_000);
    parser(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 200, reasoning_output_tokens: 50 },
    }), writer as never, 'app-1');

    const [budget] = tokenBudgets(sent);
    assert.ok(budget);
    assert.equal(budget.outputTokens, 200, 'the provider meter\'s output count, reasoning kept separate');
    assert.equal(budget.outputTokensPerSecond, 100);
  } finally {
    mock.timers.reset();
  }
});

test('Codex leaves the rate unavailable when the turn reports no output', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const sent: Sent = [];
    const parser = createCodexTurnLineParser(() => []);
    const writer = writerFor(sent);

    parser(JSON.stringify({ type: 'turn.started' }), writer as never, 'app-1');
    mock.timers.tick(2_000);
    parser(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 0 } }), writer as never, 'app-1');

    const [budget] = tokenBudgets(sent);
    assert.ok(budget);
    assert.equal(budget.outputTokensPerSecond, undefined);
  } finally {
    mock.timers.reset();
  }
});

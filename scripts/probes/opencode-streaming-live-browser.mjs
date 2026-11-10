#!/usr/bin/env node
/**
 * Live browser probe for the OpenCode streaming path.
 *
 * It drives the deployed CloudCLI build through a real browser, sends one
 * bounded prompt to a real OpenCode/Morph model, and checks:
 *  - a `stream_delta` frame reaches the selected session before completion;
 *  - the assistant text in the browser matches the provider's final text;
 *  - a second session receives no `stream_delta` / assistant `text` frames;
 *  - the selected session's persisted token usage yields a measured tok/s.
 *
 * The probe assumes an isolated instance of the deployed build is already
 * running (see docs/reports/opencode-streaming-live-browser-e9ccb353.md).
 * It never prints or stores the auth token.
 *
 * Required env:
 *   PROBE_ROOT            temp root of the isolated instance
 *   PROBE_PORT            isolated instance port
 *   PROBE_TOKEN           auth token for the isolated instance
 *   PROBE_SESSION_ID      selected CloudCLI session id
 *   PROBE_PROJECT_PATH    project path used by the isolated instance
 *   PROBE_PLAYWRIGHT      path to playwright-core/index.mjs
 *   PROBE_CHROMIUM        path to the Chromium executable
 *   PROBE_OPENCODE_DB     path to the isolated OpenCode sqlite db
 *
 * Optional env:
 *   PROBE_PROMPT          prompt to send (default: Reply with exactly: LIVE_OK)
 *   PROBE_EXPECT          expected final text (default: LIVE_OK)
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const required = [
  'PROBE_ROOT',
  'PROBE_PORT',
  'PROBE_TOKEN',
  'PROBE_SESSION_ID',
  'PROBE_PROJECT_PATH',
  'PROBE_PLAYWRIGHT',
  'PROBE_CHROMIUM',
  'PROBE_OPENCODE_DB',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`missing ${name}`);
}

const root = process.env.PROBE_ROOT;
const port = process.env.PROBE_PORT;
const token = process.env.PROBE_TOKEN;
const sessionId = process.env.PROBE_SESSION_ID;
const projectPath = process.env.PROBE_PROJECT_PATH;
const prompt = process.env.PROBE_PROMPT || 'Reply with exactly: LIVE_OK';
const expected = process.env.PROBE_EXPECT || 'LIVE_OK';
const baseUrl = `http://127.0.0.1:${port}`;

const { chromium } = await import(pathToFileURL(process.env.PROBE_PLAYWRIGHT).href);
const Database = (await import('better-sqlite3')).default;

const t0 = Date.now();
const log = (...args) => console.log(((Date.now() - t0) / 1000).toFixed(3), ...args);

const api = async (method, route, body) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(`${method} ${route} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json.data;
};

const second = await api('POST', '/api/providers/sessions', {
  provider: 'opencode',
  projectPath,
  initialMessage: '',
});
const secondSessionId = second.sessionId;
log('second session', secondSessionId);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PROBE_CHROMIUM,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(([value]) => {
  localStorage.setItem('auth-token', value);
}, [token]);

const pageA = await context.newPage();
const pageB = await context.newPage();

let firstDeltaAt = null;
let firstDeltaContent = null;
let firstAssistantTextAt = null;
let firstAssistantText = null;
const assistantTexts = [];
let deltaCount = 0;
let completedAt = null;
const crossFrames = [];
const crossTexts = [];

pageA.on('websocket', (ws) => {
  ws.on('framereceived', (event) => {
    let frame;
    try { frame = JSON.parse(event.payload); } catch { return; }
    if (frame.kind === 'stream_delta') {
      deltaCount += 1;
      if (firstDeltaAt === null) {
        firstDeltaAt = Date.now() - t0;
        firstDeltaContent = frame.content;
        log('A first stream_delta', JSON.stringify(frame.content).slice(0, 80));
      }
    } else if (frame.kind === 'text' && frame.role === 'assistant') {
      assistantTexts.push(frame.content);
      if (firstAssistantTextAt === null) {
        firstAssistantTextAt = Date.now() - t0;
        firstAssistantText = frame.content;
        log('A first assistant text', JSON.stringify(frame.content).slice(0, 80));
      }
    }
  });
});

pageB.on('websocket', (ws) => {
  ws.on('framereceived', (event) => {
    let frame;
    try { frame = JSON.parse(event.payload); } catch { return; }
    if (frame.kind === 'stream_delta') {
      crossFrames.push(frame);
      log('B CROSS stream_delta', JSON.stringify(frame.content).slice(0, 80));
    } else if (frame.kind === 'text' && frame.role === 'assistant') {
      crossTexts.push(frame);
      log('B CROSS assistant text', JSON.stringify(frame.content).slice(0, 80));
    }
  });
});

await pageA.goto(`${baseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await pageB.goto(`${baseUrl}/session/${secondSessionId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(3000);

const composer = pageA.locator('textarea').first();
await composer.fill(prompt);
log('A filled');
await pageA.getByRole('button', { name: 'Send', exact: true }).click();
log('A clicked send');

for (let i = 0; i < 180; i += 1) {
  await pageA.waitForTimeout(500);
  const state = await pageA.evaluate(() => {
    const send = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Send'
        || button.getAttribute('aria-label') === 'Stop',
    );
    return { send: send?.getAttribute('aria-label') };
  });
  if (state.send === 'Send' && i > 2) {
    completedAt = Date.now() - t0;
    log('A complete', 'deltas=', deltaCount);
    break;
  }
}

const bodyA = await pageA.locator('body').innerText();
const bodyB = await pageB.locator('body').innerText();
const assistantText = assistantTexts.join('');

const providerId = await api('GET', `/api/providers/sessions/${sessionId}/provider-id`);
const providerSessionId = providerId.sessionId ?? null;
const db = new Database(process.env.PROBE_OPENCODE_DB, { readonly: true });
const assistant = providerSessionId
  ? db.prepare(
    "select id, time_created, time_updated, data from message where session_id = ? and data like '%\"role\":\"assistant\"%' order by time_created desc limit 1",
  ).get(providerSessionId)
  : null;
const stepFinish = assistant
  ? db.prepare(
    "select data from part where message_id = ? and data like '%\"type\":\"step-finish\"%' order by time_created desc limit 1",
  ).get(assistant.id)
  : null;
const finalTextPart = assistant
  ? db.prepare(
    "select data from part where message_id = ? and data like '%\"type\":\"text\"%' order by time_created desc limit 1",
  ).get(assistant.id)
  : null;
db.close();

const assistantData = assistant ? JSON.parse(assistant.data) : null;
const stepData = stepFinish ? JSON.parse(stepFinish.data) : null;
const finalTextData = finalTextPart ? JSON.parse(finalTextPart.data) : null;
const tokens = stepData?.tokens ?? assistantData?.tokens ?? null;
const durationMs = assistantData?.time?.completed && assistantData?.time?.created
  ? assistantData.time.completed - assistantData.time.created
  : null;
const generatedTokens = tokens ? (tokens.output ?? 0) + (tokens.reasoning ?? 0) : null;
const outputTokensPerSecond = generatedTokens && durationMs
  ? generatedTokens / (durationMs / 1000)
  : null;
const outputOnlyTokensPerSecond = tokens?.output && durationMs
  ? tokens.output / (durationMs / 1000)
  : null;

const evidence = {
  capturedAt: new Date().toISOString(),
  baseUrl,
  sessionId,
  secondSessionId,
  providerSessionId,
  prompt,
  expected,
  firstDeltaAtMs: firstDeltaAt,
  firstDeltaContent,
  firstAssistantTextAtMs: firstAssistantTextAt,
  firstAssistantText,
  assistantText,
  deltaCount,
  completedAtMs: completedAt,
  firstDeltaBeforeCompletion: firstDeltaAt !== null && completedAt !== null
    ? firstDeltaAt < completedAt
    : null,
  browserHasExpectedText: assistantText.includes(expected),
  browserDomHasExpectedText: bodyA.includes(expected),
  crossSessionFrames: crossFrames.length,
  crossSessionTexts: crossTexts.length,
  secondSessionHasExpectedText: bodyB.includes(expected),
  providerFinalText: finalTextData?.text ?? null,
  providerTokens: tokens,
  providerDurationMs: durationMs,
  generatedTokensPerSecond: outputTokensPerSecond,
  outputTokensPerSecond: outputOnlyTokensPerSecond,
  uiTokenRate: await pageA.locator('[data-testid="token-rate"]').innerText().catch(() => null),
};

await mkdir(root, { recursive: true });
const evidencePath = path.join(root, 'live-browser-evidence.json');
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
log('evidence', evidencePath);

assert.ok(firstDeltaAt !== null, 'no stream_delta reached the selected session');
assert.ok(completedAt !== null, 'the turn did not complete');
assert.ok(firstDeltaAt < completedAt, 'first stream_delta arrived after completion');
assert.ok(assistantText.includes(expected), `browser did not show ${expected}`);
assert.ok(finalTextData?.text?.includes(expected), `provider final text did not contain ${expected}`);
assert.equal(crossFrames.length, 0, 'second session received stream_delta frames');
assert.equal(crossTexts.length, 0, 'second session received assistant text frames');
assert.ok(!bodyB.includes(expected), 'second session DOM contains the selected session text');
assert.ok(tokens, 'no persisted token usage for the selected session');
assert.ok(outputTokensPerSecond > 0, 'no measured tok/s');

console.log('PASS live-browser-streaming', JSON.stringify({
  firstDeltaAtMs: firstDeltaAt,
  completedAtMs: completedAt,
  deltaCount,
  generatedTokensPerSecond: Number(outputTokensPerSecond.toFixed(1)),
  outputTokensPerSecond: Number(outputOnlyTokensPerSecond.toFixed(1)),
  crossSessionFrames: crossFrames.length,
  crossSessionTexts: crossTexts.length,
  uiTokenRate: evidence.uiTokenRate,
}));

await browser.close();

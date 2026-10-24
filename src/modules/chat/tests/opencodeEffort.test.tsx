import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { resetUserPreferences } from '@/shared/userSettings';
import type { ProviderModelsDefinition } from '@/shared/types';

const catalog: ProviderModelsDefinition = {
  DEFAULT: 'zai-coding-plan/glm-5.3',
  OPTIONS: ['glm-5.3', 'glm-5.3-flash'].map((model) => ({
    value: `zai-coding-plan/${model}`,
    label: model,
    effort: { default: 'medium', values: ['low', 'medium', 'high', 'max'].map((value) => ({ value })) },
  })),
};
const rememberedEfforts = new Map<string, string>();
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
vi.mock('@/shared/api', () => ({ api: {
  user: { preferences: () => ok(null), savePreferences: () => ok(null) },
  providers: {
    models: (provider: string) => ok(provider === 'opencode' ? { models: catalog } : null),
    capabilities: () => ok(null),
    sessionActiveModel: (_provider: string, id: string) => ok(rememberedEfforts.has(id)
      ? { provider: 'opencode', sessionId: id, model: catalog.DEFAULT, effort: rememberedEfforts.get(id), source: 'session' }
      : null),
    setSessionActiveEffort: (_provider: string, id: string, effort: string) => {
      rememberedEfforts.set(id, effort);
      return ok({ effort });
    },
  },
} }));

beforeEach(() => {
  localStorage.clear();
  rememberedEfforts.clear();
  resetUserPreferences();
});

test('OpenCode defaults to medium, shows the picker, and retains a chosen effort', async () => {
  const { result, unmount } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  act(() => result.current.setProvider('opencode'));
  await waitFor(() => assert.equal(result.current.currentProviderModel, catalog.DEFAULT));
  await waitFor(() => assert.equal(result.current.currentProviderEffort, 'medium'));
  const menu = render(<ComposerModelMenu
    model={result.current.currentProviderModel}
    modelOptions={result.current.currentProviderModelOptions}
    effort={result.current.currentProviderEffort}
    effortOptions={result.current.currentProviderEffortOptions}
    onSelectEffort={(effort) => { void result.current.selectProviderEffort('opencode', effort); }}
    onSelectModel={() => {}}
    modelsLoading={false}
  />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  assert.equal(screen.getByRole('menuitemradio', { name: 'medium' }).getAttribute('aria-checked'), 'true');
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
  await waitFor(() => assert.equal(result.current.currentProviderEffort, 'high'));
  menu.unmount();
  unmount();
  const reloaded = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  act(() => reloaded.result.current.setProvider('opencode'));
  await waitFor(() => assert.equal(reloaded.result.current.currentProviderEffort, 'high'));
});


test('OpenCode restores a session effort after reopening instead of using the provider default', async () => {
  const selectedSession = { id: 'ses_glm', __provider: 'opencode' as const };
  const args = { selectedSession, selectedProject: null };
  const { result, unmount } = renderHook(() => useChatProviderState(args));
  await waitFor(() => assert.equal(result.current.currentProviderEffort, 'medium'));
  await act(async () => { await result.current.selectProviderEffort('opencode', 'max', selectedSession.id); });
  assert.equal(rememberedEfforts.get(selectedSession.id), 'max');
  unmount();
  localStorage.removeItem('opencode-effort');
  const reopened = renderHook(() => useChatProviderState(args));
  await waitFor(() => assert.equal(reopened.result.current.currentProviderEffort, 'max'));
});

import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui';

test('LLMProviderLogo renders the neutral Antigravity logo for agy provider', () => {
  render(<LLMProviderLogo provider="agy" className="h-6 w-6" />);
  const logo = screen.getByRole('img', { name: 'Antigravity' });
  assert.ok(logo);
  assert.equal(logo.getAttribute('aria-label'), 'Antigravity');
});

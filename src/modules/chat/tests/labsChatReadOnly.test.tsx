import assert from 'node:assert/strict';

import React from 'react';
import { render } from '@testing-library/react';
import { describe, it } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui/LLMProviderLogo';
import { LabsLogo } from '@/shared/ui/LabsLogo';
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea } from '@/modules/chat/composer/PromptInput';

describe('Labs Provider UI and Read-Only Chat Composer', () => {
  it('renders LabsLogo as a neutral badge with LABS title', () => {
    const { container } = render(React.createElement(LabsLogo, { className: 'w-4 h-4' }));
    const svg = container.querySelector('svg');
    assert.ok(svg, 'Expected an SVG element');
    assert.equal(svg.getAttribute('aria-label'), 'LABS');
    const title = container.querySelector('title');
    assert.equal(title?.textContent, 'LABS');
  });

  it('LLMProviderLogo renders LabsLogo when provider is labs', () => {
    const { container } = render(React.createElement(LLMProviderLogo, { provider: 'labs', className: 'w-4 h-4' }));
    const svg = container.querySelector('svg');
    assert.ok(svg, 'Expected an SVG element for labs provider');
    assert.equal(svg.getAttribute('aria-label'), 'LABS');
  });

  it('PromptInputTextarea is disabled and shows metadata only placeholder when isReadOnly is true', () => {
    const { getByPlaceholderText } = render(
      React.createElement(
        PromptInput,
        { status: 'ready' },
        React.createElement(
          PromptInputBody,
          null,
          React.createElement(PromptInputTextarea, {
            value: '',
            onChange: () => {},
            disabled: true,
            placeholder: 'metadata only',
          }),
        ),
      ),
    );

    const textarea = getByPlaceholderText('metadata only') as HTMLTextAreaElement;
    assert.ok(textarea);
    assert.equal(textarea.disabled, true);
  });

  it('PromptInputSubmit is disabled when disabled prop is set for read-only session', () => {
    const { getByLabelText } = render(
      React.createElement(
        PromptInput,
        { status: 'ready' },
        React.createElement(PromptInputSubmit, {
          'aria-label': 'submit',
          disabled: true,
        }),
      ),
    );

    const button = getByLabelText('submit') as HTMLButtonElement;
    assert.ok(button);
    assert.equal(button.disabled, true);
  });
});

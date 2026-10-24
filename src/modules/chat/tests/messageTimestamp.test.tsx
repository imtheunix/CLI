import assert from 'node:assert/strict';

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, it } from 'vitest';

import '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

const AT = '2026-10-24T09:41:07.000Z';
const previous: ChatMessage = { type: 'assistant', content: 'First part.', timestamp: '2026-10-24T09:40:00.000Z' };

const renderReply = (message: ChatMessage, prevMessage: ChatMessage | null = previous) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={prevMessage} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );

describe('tapping a reply shows when it was written', () => {
  it('reveals the date and time of a grouped reply, and hides it on a second tap', () => {
    const { container, getByText } = renderReply({ type: 'assistant', content: 'Second part.', timestamp: AT });
    assert.equal(container.querySelector('[data-testid="message-time-revealed"]'), null);

    fireEvent.click(getByText('Second part.'));
    const time = container.querySelector('[data-testid="message-time-revealed"]');
    assert.ok(time, 'the tap must show the time');
    assert.equal(time?.getAttribute('dateTime'), AT);
    assert.equal(time?.textContent, new Date(AT).toLocaleString());

    fireEvent.click(getByText('Second part.'));
    assert.equal(container.querySelector('[data-testid="message-time-revealed"]'), null);
  });

  it('leaves a tap on a link or a control alone', () => {
    const { container, getByText } = renderReply({ type: 'assistant', content: 'See [the docs](https://example.com).', timestamp: AT });
    fireEvent.click(getByText('the docs'));
    assert.equal(container.querySelector('[data-testid="message-time-revealed"]'), null);

    const copy = container.querySelector('button');
    assert.ok(copy, 'the reply has its copy control');
    fireEvent.click(copy as Element);
    assert.equal(container.querySelector('[data-testid="message-time-revealed"]'), null);
  });

  it('does not toggle when the tap ends a text selection', () => {
    const { container, getByText } = renderReply({ type: 'assistant', content: 'Copy this part.', timestamp: AT });
    const text = getByText('Copy this part.');
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.click(text);
    assert.equal(container.querySelector('[data-testid="message-time-revealed"]'), null);
    window.getSelection()?.removeAllRanges();
  });

  it('shows nothing for a reply without a usable timestamp', () => {
    const { container, getByText } = renderReply({ type: 'assistant', content: 'No time.', timestamp: '' });
    fireEvent.click(getByText('No time.'));
    assert.equal(container.querySelector('[data-testid="message-time-revealed"]'), null);
  });
});

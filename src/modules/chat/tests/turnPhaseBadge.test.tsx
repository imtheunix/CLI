import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import TurnPhaseBadge from '@/modules/chat/TurnPhaseBadge';

test('the chat header badge names the current phase and a tool by its name', () => {
  const streaming = render(<TurnPhaseBadge phase="streaming" />);
  assert.match(streaming.container.textContent ?? '', /streaming/i);
  streaming.unmount();

  const tool = render(<TurnPhaseBadge phase="tool:Read" />);
  assert.match(tool.container.textContent ?? '', /Tool: Read/);
  tool.unmount();

  const idle = render(<TurnPhaseBadge phase={null} />);
  assert.equal(idle.container.textContent, '');
});

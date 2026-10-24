import { act, renderHook } from '@testing-library/react';
import { test, expect, vi } from 'vitest';

import { applyExtraKeyModifiers, controlCodeFor } from '@/modules/shell/utils/extraKeys';
import { useExtraKeys } from '@/modules/shell/hooks/useExtraKeys';

const modifiers = (ctrl: 'off' | 'once' | 'locked' = 'off', alt = false) => ({ ctrl, alt });

test('controlCodeFor maps letters to their control codes and nothing else', () => {
  expect(controlCodeFor('c')).toBe('\x03');
  expect(controlCodeFor('C')).toBe('\x03');
  expect(controlCodeFor('d')).toBe('\x04');
  expect(controlCodeFor('o')).toBe('\x0f');
  expect(controlCodeFor('x')).toBe('\x18');
  expect(controlCodeFor('z')).toBe('\x1a');
  expect(controlCodeFor('1')).toBeNull();
  expect(controlCodeFor('|')).toBeNull();
  expect(controlCodeFor('\r')).toBeNull();
  expect(controlCodeFor('ab')).toBeNull();
  expect(controlCodeFor('')).toBeNull();
});

test('plain passthrough leaves input untouched and consumes nothing', () => {
  expect(applyExtraKeyModifiers('hello', modifiers())).toEqual({
    sequence: 'hello',
    consumedCtrl: false,
    consumedAlt: false,
  });
});

test('one-shot ctrl turns the next typed letter into its control code and disarms', () => {
  const result = applyExtraKeyModifiers('c', modifiers('once'));
  expect(result.sequence).toBe('\x03');
  expect(result.consumedCtrl).toBe(true);

  // The letter after that must be a plain letter again.
  expect(applyExtraKeyModifiers('c', modifiers('off')).sequence).toBe('c');
});

test('locked ctrl keeps producing control codes without disarming', () => {
  const result = applyExtraKeyModifiers('c', modifiers('locked'));
  expect(result.sequence).toBe('\x03');
  expect(result.consumedCtrl).toBe(false);
});

test('ctrl ignores non-letter input and stays armed for the next letter', () => {
  expect(applyExtraKeyModifiers('|', modifiers('once'))).toEqual({
    sequence: '|',
    consumedCtrl: false,
    consumedAlt: false,
  });
  expect(applyExtraKeyModifiers('git status', modifiers('once')).sequence).toBe('git status');
});

test('alt prefixes a single character with escape and disarms', () => {
  expect(applyExtraKeyModifiers('b', modifiers('off', true))).toEqual({
    sequence: '\x1bb',
    consumedCtrl: false,
    consumedAlt: true,
  });
  // Paste-like input is never escaped.
  expect(applyExtraKeyModifiers('ls -la', modifiers('off', true))).toEqual({
    sequence: 'ls -la',
    consumedCtrl: false,
    consumedAlt: false,
  });
});

test('ctrl and alt together send escape plus the control code', () => {
  expect(applyExtraKeyModifiers('c', modifiers('once', true))).toEqual({
    sequence: '\x1b\x03',
    consumedCtrl: true,
    consumedAlt: true,
  });
});

test('useExtraKeys taps cycle ctrl off → once → locked → off', () => {
  const { result } = renderHook(() => useExtraKeys({ sendInput: vi.fn() }));

  expect(result.current.ctrlMode).toBe('off');
  act(() => result.current.toggleCtrl());
  expect(result.current.ctrlMode).toBe('once');
  act(() => result.current.toggleCtrl());
  expect(result.current.ctrlMode).toBe('locked');
  act(() => result.current.toggleCtrl());
  expect(result.current.ctrlMode).toBe('off');
});

test('useExtraKeys turns keyboard letters into control codes after tapping ctrl once', () => {
  const sendInput = vi.fn();
  const { result } = renderHook(() => useExtraKeys({ sendInput }));

  act(() => result.current.toggleCtrl());
  // The phone keyboard input path: the transform returns the bytes to send.
  let sent: string | undefined;
  act(() => {
    sent = result.current.transformKeyboardInput('c');
  });
  expect(sent).toBe('\x03');
  expect(result.current.ctrlMode).toBe('off');
  // The next letter is plain again.
  act(() => {
    sent = result.current.transformKeyboardInput('c');
  });
  expect(sent).toBe('c');
});

test('useExtraKeys locked ctrl survives a letter and applies to panel keys too', () => {
  const sendInput = vi.fn();
  const { result } = renderHook(() => useExtraKeys({ sendInput }));

  act(() => result.current.toggleCtrl());
  act(() => result.current.toggleCtrl());
  expect(result.current.ctrlMode).toBe('locked');

  let sent: string | undefined;
  act(() => {
    sent = result.current.transformKeyboardInput('d');
  });
  expect(sent).toBe('\x04');
  expect(result.current.ctrlMode).toBe('locked');

  act(() => {
    result.current.sendKey('c');
  });
  expect(sendInput).toHaveBeenCalledWith('\x03');
  expect(result.current.ctrlMode).toBe('locked');
});

test('useExtraKeys sends plain panel keys and esc-prefixed alt keys', () => {
  const sendInput = vi.fn();
  const { result } = renderHook(() => useExtraKeys({ sendInput }));

  act(() => {
    result.current.sendKey('\x1b');
  });
  expect(sendInput).toHaveBeenLastCalledWith('\x1b');

  act(() => result.current.toggleAlt());
  act(() => {
    result.current.sendKey('b');
  });
  expect(sendInput).toHaveBeenLastCalledWith('\x1bb');
  expect(result.current.altActive).toBe(false);
});

test('a one-shot ctrl applies to one character even when two arrive in the same tick', () => {
  const { result } = renderHook(() => useExtraKeys({ sendInput: vi.fn() }));

  act(() => result.current.toggleCtrl());
  // An autocorrect replacement or fast typing: two onData calls before React re-renders.
  let first: string | undefined;
  let second: string | undefined;
  act(() => {
    first = result.current.transformKeyboardInput('c');
    second = result.current.transformKeyboardInput('d');
  });
  expect(first).toBe('\x03');
  expect(second).toBe('d');
});

import { useCallback, useRef, useState } from 'react';

import type { ExtraKeyCtrlMode } from '@/modules/shell/utils/extraKeys';
import { applyExtraKeyModifiers } from '@/modules/shell/utils/extraKeys';

type UseExtraKeysOptions = {
  /** Sends raw bytes to the terminal session. */
  sendInput: (data: string) => void;
};

/**
 * Sticky terminal modifiers and their shared key-to-sequence mapping.
 *
 * Owned by Shell because two consumers need the same state at once: the
 * extra-keys row renders it (which modifier is armed) and the terminal's
 * keyboard input passes through it (tap Ctrl, then a letter on the phone
 * keyboard, sends that letter's control code). Tapping Ctrl cycles off →
 * one-shot → locked (double-tap locks); a locked modifier survives use.
 */
export function useExtraKeys({ sendInput }: UseExtraKeysOptions) {
  // Sticky modifier arming; mirrored into a ref because the terminal input
  // path reads it from xterm's onData handler, outside React's render cycle.
  const [ctrlMode, setCtrlMode] = useState<ExtraKeyCtrlMode>('off');
  const [altActive, setAltActive] = useState(false);
  const modifiersRef = useRef({ ctrl: ctrlMode, alt: altActive });
  modifiersRef.current = { ctrl: ctrlMode, alt: altActive };

  const toggleCtrl = useCallback(() => {
    const mode = modifiersRef.current.ctrl;
    const next: ExtraKeyCtrlMode = mode === 'off' ? 'once' : mode === 'once' ? 'locked' : 'off';
    modifiersRef.current = { ...modifiersRef.current, ctrl: next };
    setCtrlMode(next);
  }, []);

  const toggleAlt = useCallback(() => {
    const next = !modifiersRef.current.alt;
    modifiersRef.current = { ...modifiersRef.current, alt: next };
    setAltActive(next);
  }, []);

  // The ref drops a used one-shot at once: two inputs in one tick (an Android
  // autocorrect replacement, fast typing) must not both see it armed before
  // the re-render that would update it.
  const applyConsumption = useCallback((consumed: { consumedCtrl: boolean; consumedAlt: boolean }) => {
    if (consumed.consumedCtrl) {
      modifiersRef.current = { ...modifiersRef.current, ctrl: 'off' };
      setCtrlMode('off');
    }
    if (consumed.consumedAlt) {
      modifiersRef.current = { ...modifiersRef.current, alt: false };
      setAltActive(false);
    }
  }, []);

  /** Sends one extra-key row tap through the armed modifiers. */
  const sendKey = useCallback(
    (sequence: string) => {
      const result = applyExtraKeyModifiers(sequence, modifiersRef.current);
      applyConsumption(result);
      sendInput(result.sequence);
    },
    [applyConsumption, sendInput],
  );

  /**
   * Terminal keyboard input transform: applies the armed modifiers to what the
   * phone (or desktop) keyboard typed into xterm and consumes one-shot arming.
   */
  const transformKeyboardInput = useCallback(
    (data: string) => {
      const result = applyExtraKeyModifiers(data, modifiersRef.current);
      applyConsumption(result);
      return result.sequence;
    },
    [applyConsumption],
  );

  return { ctrlMode, altActive, toggleCtrl, toggleAlt, sendKey, transformKeyboardInput };
}

/**
 * Key-to-sequence mapping for the shell's touch extra-keys row.
 *
 * Phone keyboards cannot produce Ctrl, Alt, Esc, Tab or arrow keys, so the
 * extra-keys row sends those sequences itself and arms sticky modifiers that
 * also apply to the next character typed on the phone keyboard. This module
 * owns that mapping so both paths (panel taps and terminal keyboard input)
 * produce identical sequences, and so the mapping can be tested directly.
 */

/** How the sticky Ctrl modifier is armed: one next key, or locked until tapped off. */
export type ExtraKeyCtrlMode = 'off' | 'once' | 'locked';

/** Which sticky modifiers are currently armed for the next input. */
export type ExtraKeyModifiers = {
  ctrl: ExtraKeyCtrlMode;
  alt: boolean;
};

/** The outcome of pushing one input string through the armed modifiers. */
export type ExtraKeySequence = {
  /** The bytes to send to the terminal session. */
  sequence: string;
  /** The one-shot ctrl modifier produced a control code and was used up. */
  consumedCtrl: boolean;
  /** The one-shot alt modifier prefixed the input and was used up. */
  consumedAlt: boolean;
};

/**
 * The control code for one character, or null when it has none.
 *
 * Only letters map (a→\x01 … z→\x1a, case-insensitive): that covers every
 * control shortcut shells expose (Ctrl-C, Ctrl-D, Ctrl-O/X in nano, …), and
 * inventing codes for other characters would send bytes the CLI never expects.
 */
export function controlCodeFor(character: string): string | null {
  if (character.length !== 1) {
    return null;
  }
  const code = character.toLowerCase().charCodeAt(0);
  if (code < 97 || code > 122) {
    return null;
  }
  return String.fromCharCode(code - 96);
}

/**
 * Applies the armed modifiers to one input string.
 *
 * `data` is a whole `xterm` `onData` payload: a single typed character, or a
 * longer paste. Modifiers only ever apply to a single character — a pasted
 * block or a multi-character IME composition is sent through untouched, and
 * arming is left alone so the modifier survives the paste.
 */
export function applyExtraKeyModifiers(data: string, modifiers: ExtraKeyModifiers): ExtraKeySequence {
  if (modifiers.ctrl !== 'off') {
    const controlCode = controlCodeFor(data);
    if (controlCode !== null) {
      return {
        sequence: modifiers.alt ? `\x1b${controlCode}` : controlCode,
        consumedCtrl: modifiers.ctrl === 'once',
        consumedAlt: modifiers.alt,
      };
    }
  }

  if (modifiers.alt && data.length === 1) {
    return { sequence: `\x1b${data}`, consumedCtrl: false, consumedAlt: true };
  }

  return { sequence: data, consumedCtrl: false, consumedAlt: false };
}

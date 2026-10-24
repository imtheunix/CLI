import type { MouseEvent } from 'react';

// What a click on a reply's text leaves alone: its own controls, links and
// tool cards keep their meaning.
const INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, summary, label, [role="button"], [role="link"]';

/**
 * Whether a click on a reply is a plain click on its text: not on a control,
 * not the end of a text selection (selecting to copy must not toggle anything).
 */
export function isPlainTextClick(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) {
    return false;
  }
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  return !selection || selection.isCollapsed || selection.toString().trim() === '';
}

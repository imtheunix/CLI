import { type MutableRefObject, useCallback } from 'react';
import {
  Clipboard,
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@xterm/xterm';

import { sendSocketMessage } from '@/modules/shell/utils/socket';
import type { ExtraKeyCtrlMode } from '@/modules/shell/utils/extraKeys';

type Shortcut =
  | { type: 'key'; id: string; label: string; sequence: string }
  | { type: 'modifier'; id: 'ctrl' | 'alt'; label: string }
  | { type: 'arrow'; id: string; sequence: string; icon: 'up' | 'down' | 'left' | 'right' };

/**
 * The row, in tap order: Esc/Tab first, the sticky modifiers, arrows, then
 * symbols a phone keyboard reaches only through a long-press sub-menu.
 */
const EXTRA_KEYS: Shortcut[] = [
  { type: 'key', id: 'esc', label: 'Esc', sequence: '\x1b' },
  { type: 'key', id: 'tab', label: 'Tab', sequence: '\t' },
  { type: 'modifier', id: 'ctrl', label: 'Ctrl' },
  { type: 'modifier', id: 'alt', label: 'Alt' },
  { type: 'arrow', id: 'arrow-up', sequence: '\x1b[A', icon: 'up' },
  { type: 'arrow', id: 'arrow-down', sequence: '\x1b[B', icon: 'down' },
  { type: 'arrow', id: 'arrow-left', sequence: '\x1b[D', icon: 'left' },
  { type: 'arrow', id: 'arrow-right', sequence: '\x1b[C', icon: 'right' },
  { type: 'key', id: 'pipe', label: '|', sequence: '|' },
  { type: 'key', id: 'tilde', label: '~', sequence: '~' },
  { type: 'key', id: 'slash', label: '/', sequence: '/' },
  { type: 'key', id: 'dash', label: '-', sequence: '-' },
  { type: 'key', id: 'shift-tab', label: '⇧Tab', sequence: '\x1b[Z' },
  { type: 'key', id: 'ctrl-c', label: 'Ctrl+C', sequence: '\x03' },
];

const ARROW_ICONS = {
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
} as const;

const ARROW_LABEL_KEYS = {
  'arrow-up': 'arrowUp',
  'arrow-down': 'arrowDown',
  'arrow-left': 'arrowLeft',
  'arrow-right': 'arrowRight',
} as const;

type TerminalShortcutsPanelProps = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  isConnected: boolean;
  /** Extra-key modifier state and tap handling owned by Shell's useExtraKeys hook. */
  ctrlMode: ExtraKeyCtrlMode;
  altActive: boolean;
  onToggleCtrl: () => void;
  onToggleAlt: () => void;
  onKey: (sequence: string) => void;
};

/** Touch taps must never steal focus from the terminal: the on-screen keyboard would close. */
const preventFocusSteal = (e: React.PointerEvent) => e.preventDefault();

// 44px minimum on both axes keeps every key inside phone touch-target guidance.
const KEY_BTN =
  'flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors select-none active:border-blue-600 active:bg-blue-600 active:text-white disabled:cursor-not-allowed disabled:opacity-40';
const KEY_BTN_ACTIVE =
  'flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-blue-500 bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Rendered by Shell (full and minimal views) as the Termux-style extra-keys
 * row under the terminal: keys a phone keyboard cannot produce plus the sticky
 * Ctrl/Alt modifiers that also apply to the next keyboard character. Shell
 * only mounts it on touch devices.
 */
export default function TerminalShortcutsPanel({
  wsRef,
  terminalRef,
  isConnected,
  ctrlMode,
  altActive,
  onToggleCtrl,
  onToggleAlt,
  onKey,
}: TerminalShortcutsPanelProps) {
  const { t } = useTranslation('settings');

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
  }, [terminalRef]);

  const pasteFromClipboard = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) {
        sendSocketMessage(wsRef.current, { type: 'input', data: text });
      }
    } catch {
      // Ignore clipboard permission errors.
    }
  }, [wsRef]);

  return (
    <div className="shrink-0 border-t border-border bg-card px-1.5 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
      <div
        className="flex items-center gap-1 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label={t('terminalShortcuts.sectionKeys', { defaultValue: 'Keys' })}
      >
        {EXTRA_KEYS.map((key) => {
          if (key.type === 'modifier') {
            const isActive = key.id === 'ctrl' ? ctrlMode !== 'off' : altActive;
            const toggle = key.id === 'ctrl' ? onToggleCtrl : onToggleAlt;
            return (
              <button
                type="button"
                key={key.id}
                onPointerDown={preventFocusSteal}
                onClick={toggle}
                disabled={!isConnected}
                aria-pressed={isActive}
                className={isActive ? KEY_BTN_ACTIVE : KEY_BTN}
                title={key.id === 'ctrl'
                  ? (ctrlMode === 'locked'
                      ? t('terminalShortcuts.ctrlLocked', { defaultValue: 'Ctrl locked — tap to turn off' })
                      : t('terminalShortcuts.ctrl', { defaultValue: 'Ctrl — tap, then a key; double-tap to lock' }))
                  : t('terminalShortcuts.alt', { defaultValue: 'Alt — tap, then a key' })}
              >
                {key.label}
                {key.id === 'ctrl' && ctrlMode === 'locked' ? ' 🔒' : ''}
              </button>
            );
          }

          if (key.type === 'arrow') {
            const Icon = ARROW_ICONS[key.icon];
            return (
              <button
                type="button"
                key={key.id}
                onPointerDown={preventFocusSteal}
                onClick={() => {
                  onKey(key.sequence);
                }}
                disabled={!isConnected}
                aria-label={t(`terminalShortcuts.${ARROW_LABEL_KEYS[key.id as keyof typeof ARROW_LABEL_KEYS]}`, { defaultValue: key.id })}
                className={KEY_BTN}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          }

          return (
            <button
              type="button"
              key={key.id}
              onPointerDown={preventFocusSteal}
              onClick={() => {
                onKey(key.sequence);
              }}
              disabled={!isConnected}
              className={KEY_BTN}
            >
              {key.label}
            </button>
          );
        })}

        <button
          type="button"
          onPointerDown={preventFocusSteal}
          onClick={() => {
            void pasteFromClipboard();
          }}
          disabled={!isConnected}
          className={KEY_BTN}
          title={t('terminalShortcuts.paste', { defaultValue: 'Paste' })}
          aria-label={t('terminalShortcuts.paste', { defaultValue: 'Paste' })}
        >
          <Clipboard className="h-4 w-4" />
        </button>

        <button
          type="button"
          onPointerDown={preventFocusSteal}
          onClick={scrollToBottom}
          disabled={!isConnected}
          className={KEY_BTN}
          title={t('terminalShortcuts.scrollDown')}
          aria-label={t('terminalShortcuts.scrollDown')}
        >
          <ArrowDownToLine className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

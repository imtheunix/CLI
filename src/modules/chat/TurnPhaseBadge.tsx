import { useTranslation } from 'react-i18next';

import type { TurnPhase } from '@/shared/types';

type TurnPhaseBadgeProps = {
  phase: TurnPhase | null;
};

const PHASE_KEYS: Record<string, string> = {
  queued: 'turnPhase.queued',
  dispatching: 'turnPhase.dispatching',
  prefill: 'turnPhase.prefill',
  streaming: 'turnPhase.streaming',
  'pacer-wait': 'turnPhase.pacerWait',
};

/**
 * The current turn phase, shown in the chat header while a turn runs.
 *
 * A tool phase is rendered as `Tool: <name>`; the rest use the chat
 * translations with an English fallback so a missing locale still reads.
 */
export default function TurnPhaseBadge({ phase }: TurnPhaseBadgeProps) {
  const { t } = useTranslation('chat');

  if (!phase) {
    return null;
  }

  const isTool = phase.startsWith('tool:');
  const label = isTool
    ? t('turnPhase.tool', { name: phase.slice('tool:'.length), defaultValue: 'Tool: {{name}}' })
    : t(PHASE_KEYS[phase] ?? phase, { defaultValue: phase });

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
      title={label}
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
      {label}
    </span>
  );
}

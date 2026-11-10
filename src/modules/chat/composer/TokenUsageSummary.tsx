import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  /** Whether the viewed session is generating, so a live rate is not shown as last. */
  isProcessing?: boolean;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readTokenRate = (usage: Record<string, unknown> | null) => {
  const rate = usage?.rate;
  if (!rate || typeof rate !== 'object') {
    return null;
  }
  const record = rate as Record<string, unknown>;
  const value = Number(record.outputTokensPerSecond);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return { value, live: record.live === true };
};

const formatTokenRate = (value: number) => (
  value >= 100 ? Math.round(value).toString() : value.toFixed(1)
);

/**
 * Rendered by chat's ChatComposer to show the session's context-window usage,
 * the measured output-token rate while a turn generates, and open the detailed
 * token breakdown on click.
 */
function TokenUsageSummary({ usage, isProcessing = false, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const rate = readTokenRate(usage);
  const rateIsLive = Boolean(rate?.live && isProcessing);
  const rateText = rate ? `${formatTokenRate(rate.value)} tok/s` : '— tok/s';
  const rateLabel = rate && !rateIsLive ? `last ${rateText}` : rateText;

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={t('chat:misc.tokensUsed', { count: usedTokens })}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">
        {t('chat:misc.tokensLabel', { count: usedTokens })}
      </span>
      <span className="text-muted-foreground/70" data-testid="token-rate">
        {rateLabel}
      </span>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);

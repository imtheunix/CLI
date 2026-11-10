import { memo, useEffect, useState } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  /** Whether the viewed session is generating, so a live rate is not shown as last. */
  isProcessing?: boolean;
  /** True while this session is producing a response, so a rate is live rather than the last one measured. */
  isGenerating?: boolean;
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

const readOptionalNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
function TokenUsageSummary({ usage, isProcessing = false, isGenerating, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;

  const isGeneratingMode = isGenerating !== undefined;
  const generating = isGenerating ?? isProcessing;

  // A rate belongs to the turn that measured it. When a new turn starts, the
  // previous turn's budget is still in state until the first usage event of
  // the new turn arrives; showing that old rate as live would be a lie.
  const [idleUsage, setIdleUsage] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!generating) {
      setIdleUsage(usage);
    }
  }, [generating, usage]);

  const rateSample = readTokenRate(usage);
  const rawRate = rateSample?.value ?? readOptionalNumber(usage?.outputTokensPerSecond);

  let rateLabel: string;
  if (isGeneratingMode) {
    const rateIsLive = generating && usage !== idleUsage && (rateSample ? rateSample.live : true);
    const showRate = rawRate !== null && rawRate > 0 && (!generating || rateIsLive);
    rateLabel = showRate
      ? t(generating ? 'chat:misc.tokensPerSecond' : 'chat:misc.tokensPerSecondLast', { rate: formatTokenRate(rawRate) })
      : t('chat:misc.tokensPerSecondUnavailable');
  } else {
    const rateIsLive = Boolean(rateSample?.live && isProcessing);
    const rateText = rateSample ? `${formatTokenRate(rateSample.value)} tok/s` : '— tok/s';
    rateLabel = rateSample && !rateIsLive ? `last ${rateText}` : rateText;
  }

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
      <span className="text-muted-foreground/40" aria-hidden>·</span>
      <span
        className="tabular-nums text-muted-foreground/80"
        title={rateLabel}
        aria-label={rateLabel}
        data-testid="token-rate"
      >
        {rateLabel}
      </span>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);

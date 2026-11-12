import * as React from 'react';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Shimmer } from '@/shared/ui';

/* ─── Context ────────────────────────────────────────────────────── */

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
  wordCount: number | undefined;
};

const ReasoningContext = React.createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = React.useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};

/* ─── Reasoning (root) ───────────────────────────────────────────── */

const MS_IN_S = 1000;

export type ReasoningProps = {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  wordCount?: number;
} & React.HTMLAttributes<HTMLDivElement>;

/**
 * Discloses an assistant turn's reasoning text; used by MessageComponent.
 *
 * Reasoning is collapsed by default and never opens itself while streaming:
 * a long chain of thought would otherwise push the answer off screen. The
 * caller decides the initial state (the "Show reasoning expanded" setting).
 */
export const Reasoning = React.memo<ReasoningProps>(
  ({
    className,
    isStreaming = false,
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    wordCount,
    children,
    ...props
  }) => {
    // Controllable open state
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const isOpen = isControlled ? controlledOpen : internalOpen;
    const setIsOpen = React.useCallback(
      (next: boolean) => {
        if (!isControlled) setInternalOpen(next);
        onOpenChange?.(next);
      },
      [isControlled, onOpenChange]
    );

    // Duration tracking
    const [duration, setDuration] = React.useState<number | undefined>(durationProp);
    const startTimeRef = React.useRef<number | null>(null);

    // Sync external duration prop
    React.useEffect(() => {
      if (durationProp !== undefined) setDuration(durationProp);
    }, [durationProp]);

    // Track streaming start/end for duration
    React.useEffect(() => {
      if (isStreaming) {
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming]);

    const contextValue = React.useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen, wordCount }),
      [duration, isOpen, isStreaming, setIsOpen, wordCount]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          open={isOpen}
          onOpenChange={setIsOpen}
          className={cn('not-prose', className)}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);
Reasoning.displayName = 'Reasoning';

/* ─── ReasoningTrigger ───────────────────────────────────────────── */

export type ReasoningTriggerProps = {
  getThinkingMessage?: (isStreaming: boolean, duration?: number, wordCount?: number) => React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

const formatWordCount = (wordCount: number | undefined): string => {
  const count = wordCount ?? 0;
  return `${count} ${count === 1 ? 'word' : 'words'}`;
};

const defaultGetThinkingMessage = (
  isStreaming: boolean,
  duration?: number,
  wordCount?: number,
): React.ReactNode => {
  const words = formatWordCount(wordCount);
  if (isStreaming) {
    return <Shimmer>{`Thinking… (${words})`}</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds ({words})</p>;
  }
  return <p>Thought for {duration} s ({words})</p>;
};

/** Toggle of Reasoning, used by MessageComponent. */
export const ReasoningTrigger = React.memo<ReasoningTriggerProps>(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }) => {
    const { isStreaming, isOpen, duration, wordCount } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="h-4 w-4" />
            {getThinkingMessage(isStreaming, duration, wordCount)}
            <ChevronDownIcon
              className={cn(
                'h-4 w-4 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0'
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);
ReasoningTrigger.displayName = 'ReasoningTrigger';

/* ─── ReasoningContent ───────────────────────────────────────────── */

export type ReasoningContentProps = {
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>;

/** Body of Reasoning, used by MessageComponent. */
export const ReasoningContent = React.memo<ReasoningContentProps>(
  ({ className, children, ...props }) => (
    <CollapsibleContent
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    >
      {children}
    </CollapsibleContent>
  )
);
ReasoningContent.displayName = 'ReasoningContent';

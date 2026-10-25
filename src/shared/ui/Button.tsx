import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';

import { cn } from '@/shared/utils';

// Adapted from EasyUI's Button: layered neutral variants and spring tap feedback.
export const buttonVariants = cva(
  'relative inline-flex touch-manipulation select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:opacity-90',
        destructive:
          'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20',
        outline:
          'border-border bg-transparent text-foreground hover:border-input hover:bg-secondary',
        secondary: 'border-border bg-card text-card-foreground hover:border-input hover:bg-secondary',
        ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        link: 'text-foreground underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-12 rounded-lg px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

/** The application-wide button, used by nearly every feature module and by the shared ActionMenu, Confirmation and PromptInput primitives. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    const reducedMotion = useReducedMotion();
    return (
      <motion.button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        whileTap={props.disabled || reducedMotion ? undefined : { scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.5 }}
        {...(props as HTMLMotionProps<'button'>)}
      />
    );
  }
);

Button.displayName = 'Button';


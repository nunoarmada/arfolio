import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';

const RING =
  'bg-surface text-foreground shadow-[0_0_0_1px_var(--border-strong),var(--elev-xs)] hover:bg-surface-2';

/**
 * Sizes (design system v2, 4): 44px on phones, tablets and any coarse pointer, 36px once a fine
 * pointer has room (lg and up). The tablet band keeps the 44px target on purpose: a 768px window
 * is far more often touched than clicked.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-base font-medium transition-[background-color,box-shadow,color] duration-[120ms] ease-out disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress lg:pointer-fine:text-sm',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[var(--elev-xs),inset_0_1px_0_oklch(1_0_0/0.12)] hover:bg-primary-hover',
        secondary: RING,
        outline: RING,
        ghost: 'text-foreground hover:bg-surface-2',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'h-auto min-h-11 px-1 text-primary-text underline-offset-4 hover:underline lg:pointer-fine:min-h-8',
      },
      size: {
        default: 'h-11 px-4 lg:pointer-fine:h-9 lg:pointer-fine:px-3.5',
        sm: 'h-10 px-3 text-sm lg:pointer-fine:h-8 lg:pointer-fine:px-2.5',
        lg: 'h-12 px-6 lg:pointer-fine:h-10 lg:pointer-fine:px-5',
        icon: 'size-11 lg:pointer-fine:size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and marks the button busy; the click is ignored while loading. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  type = 'button',
  onClick,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      aria-busy={loading || undefined}
      disabled={disabled}
      // A loading button stays focusable (focus is not lost on submit) but ignores clicks.
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

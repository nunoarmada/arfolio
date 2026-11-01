import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, ChevronRight, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The one container of the app. Depth is hierarchy (canvas, card, raised, overlay): the card sits
 * on the canvas with a shadow ring instead of a border, the inset variant nests inside it, the
 * hero carries the single brand glow of a page, and a tone replaces the surface for the few
 * cards that are alerts.
 */
export const cardVariants = cva('relative min-w-0 text-foreground', {
  variants: {
    variant: {
      default: 'rounded-lg bg-surface shadow-card',
      inset: 'rounded-md bg-surface-2',
      // The glow is a radial wash from the top-right corner plus a 1px brand hairline on top.
      hero: 'overflow-hidden rounded-xl bg-surface shadow-card bg-[radial-gradient(120%_140%_at_100%_0%,var(--primary-glow),transparent_60%)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-[inherit] before:bg-primary-border',
      interactive:
        'rounded-lg bg-surface shadow-card transition-[box-shadow,transform] duration-[180ms] ease-out pointer-fine:hover:-translate-y-px pointer-fine:hover:shadow-raised motion-reduce:transition-none motion-reduce:hover:translate-y-0',
    },
    tone: {
      none: '',
      negative:
        'bg-negative-soft shadow-[0_0_0_1px_color-mix(in_oklab,var(--negative)_30%,transparent)]',
      warning:
        'bg-warning-soft shadow-[0_0_0_1px_color-mix(in_oklab,var(--warning)_30%,transparent)]',
    },
    pad: {
      none: '',
      sm: 'p-3 md:p-4',
      md: 'p-4 md:p-5 xl:p-6',
    },
  },
  defaultVariants: { variant: 'default', tone: 'none', pad: 'md' },
});

type CardProps<T extends ElementType> = VariantProps<typeof cardVariants> & {
  as?: T;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'className' | 'children'>;

/** A card is a `div` by default; pass `as="section"` with `aria-labelledby` for a landmark. */
export function Card<T extends ElementType = 'div'>({
  as,
  variant,
  tone,
  pad,
  className,
  children,
  ...props
}: CardProps<T>) {
  const Tag: ElementType = as ?? 'div';
  return (
    <Tag className={cn(cardVariants({ variant, tone, pad }), className)} {...props}>
      {children}
    </Tag>
  );
}

/** "Ver tudo": the card's way to its full page. Chevron, primary-text colour, never wraps. */
export function CardLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        '-my-2 inline-flex min-h-11 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md text-sm font-medium text-primary-text hover:underline md:pointer-fine:min-h-8',
        className,
      )}
    >
      {children}
      <ChevronRight className="size-4" aria-hidden="true" />
    </Link>
  );
}

/**
 * The header lives inside the card: title, optional description, and the card link on the right.
 * `titleId` is what the card's `aria-labelledby` points at.
 */
export function CardHeader({
  title,
  titleId,
  description,
  icon: Icon,
  link,
  actions,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  icon?: LucideIcon;
  link?: { href: string; label: string };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 md:mb-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 basis-32 items-start gap-2.5">
        {Icon ? <IconTile icon={Icon} /> : null}
        <div className="min-w-0">
          <h2 id={titleId} className="text-card-title">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-label font-normal text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {actions}
      {link ? <CardLink href={link.href}>{link.label}</CardLink> : null}
    </div>
  );
}

/** The 28px rounded tile that holds a 16px icon, in the soft brand tint (or a tone's). */
export function IconTile({
  icon: Icon,
  tone = 'primary',
  className,
}: {
  icon: LucideIcon;
  tone?: 'primary' | 'neutral' | 'negative' | 'warning' | 'positive';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md',
        {
          primary: 'bg-primary-soft text-primary-text',
          neutral: 'bg-surface-2 text-muted-foreground',
          negative: 'bg-negative-soft text-negative',
          warning: 'bg-warning-soft text-warning',
          positive: 'bg-positive-soft text-positive',
        }[tone],
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** The alert card: the soft tone, its icon and a single message line plus an action. */
export function ToneCard({
  tone,
  icon: Icon = AlertTriangle,
  label,
  children,
  action,
  className,
}: {
  tone: 'negative' | 'warning';
  icon?: LucideIcon;
  label?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card
      as="section"
      aria-label={label}
      tone={tone}
      pad="sm"
      className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5', className)}
    >
      <p className="flex min-w-0 items-start gap-2.5 text-base font-medium">
        <Icon
          className={cn(
            'mt-0.5 size-5 shrink-0',
            tone === 'negative' ? 'text-negative' : 'text-warning',
          )}
          aria-hidden="true"
        />
        <span>{children}</span>
      </p>
      {action}
    </Card>
  );
}

import { ArrowLeftRight, Check, CircleHelp } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { iconFor, slotColor } from '@/lib/category-visuals';
import { cn } from '@/lib/cn';
import type { CategoryDto } from '@/server/serialize';

const DISC = { 28: 'size-7', 36: 'size-9', 48: 'size-12' } as const;
const GLYPH = { 28: 'size-4', 36: 'size-5', 48: 'size-6' } as const;

/**
 * A round icon in the category's group colour. Uncategorised rows get a dashed outline with a
 * question mark, so the gap is visible without relying on colour alone (the name is always
 * rendered next to it).
 */
export function CategoryIcon({
  category,
  size = 36,
  className,
}: {
  category: CategoryDto | null | undefined;
  size?: keyof typeof DISC;
  className?: string;
}) {
  if (!category) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-dashed border-input text-muted-foreground',
          DISC[size],
          className,
        )}
      >
        <CircleHelp className={GLYPH[size]} />
      </span>
    );
  }
  const Icon = category.groupKind === 'transfer' ? ArrowLeftRight : iconFor(category);
  return (
    <span
      aria-hidden="true"
      style={{ '--cat': slotColor(category.slot, category.groupKind) } as CSSProperties}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--cat)_16%,var(--surface))] text-[var(--cat)]',
        DISC[size],
        className,
      )}
    >
      <Icon className={GLYPH[size]} />
    </span>
  );
}

/** Icon + name. As a tap target (pickers) it is 44px tall; as a label it is 32px. */
export function CategoryChip({
  category,
  uncategorisedLabel,
  selected = false,
  onClick,
  large = false,
  trailing,
  className,
}: {
  category: CategoryDto | null | undefined;
  uncategorisedLabel: string;
  selected?: boolean;
  onClick?: () => void;
  large?: boolean;
  trailing?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <CategoryIcon category={category} size={28} className="size-5 [&>svg]:size-3.5" />
      <span className={cn('min-w-0 text-left', large ? 'break-words leading-tight' : 'truncate')}>
        {category?.name ?? uncategorisedLabel}
      </span>
      {selected ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
      {trailing}
    </>
  );
  const base = cn(
    'inline-flex max-w-full items-center gap-2 rounded-sm px-2 text-sm font-medium',
    large ? 'min-h-11 py-1 px-3 text-base' : 'h-8',
    selected
      ? 'border-[1.5px] border-primary bg-primary-soft text-foreground'
      : 'border border-transparent bg-surface-2 text-foreground',
    className,
  );
  if (!onClick) return <span className={base}>{body}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(base, 'transition-colors duration-[120ms] hover:bg-surface-3')}
    >
      {body}
    </button>
  );
}

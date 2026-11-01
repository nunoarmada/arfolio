import {
  Building2,
  Car,
  CircleDashed,
  CreditCard,
  HandCoins,
  KeyRound,
  Package,
  Receipt,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export const KIND_ICONS: Record<string, LucideIcon> = {
  real_estate: Building2,
  vehicle: Car,
  investment: TrendingUp,
  cash: Wallet,
  other: Package,
  mortgage: KeyRound,
  loan: HandCoins,
  debt: Receipt,
  card: CreditCard,
};

/** A liability of kind "other" is not a package: it gets the dashed circle. */
export function kindIcon(side: 'asset' | 'liability', kind: string): LucideIcon {
  if (side === 'liability' && kind === 'other') return CircleDashed;
  return KIND_ICONS[kind] ?? Package;
}

/**
 * The kind's icon on a neutral disc. Kinds carry no meaning beyond their label, so the icon is
 * `muted-foreground` and never takes a chart colour.
 */
export function KindIcon({
  side,
  kind,
  size = 40,
  className,
}: {
  side: 'asset' | 'liability';
  kind: string;
  size?: 36 | 40 | 48;
  className?: string;
}) {
  const Icon = kindIcon(side, kind);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted-foreground',
        size === 36 ? 'size-9' : size === 48 ? 'size-12' : 'size-10',
        className,
      )}
    >
      <Icon className={size === 48 ? 'size-6' : 'size-5'} />
    </span>
  );
}

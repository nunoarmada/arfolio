import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { StatusIcon, StatusTone } from '@/lib/connection-status';
import { cn } from '@/lib/cn';

const ICONS: Record<StatusIcon, LucideIcon> = {
  spinner: Loader2,
  'x-circle': XCircle,
  dashed: CircleDashed,
  alert: AlertTriangle,
  clock: Clock,
  check: CheckCircle2,
};

export const TONES: Record<StatusTone, string> = {
  muted: 'text-muted-foreground',
  negative: 'text-negative',
  warning: 'text-warning',
  positive: 'text-positive',
};

/** Just the icon (decorative: the adjacent word carries the meaning). */
export function StatusGlyph({
  icon,
  tone,
  className,
}: {
  icon: StatusIcon;
  tone: StatusTone;
  className?: string;
}) {
  const Icon = ICONS[icon];
  return (
    <Icon
      className={cn(
        'size-4 shrink-0',
        TONES[tone],
        icon === 'spinner' && 'animate-spin',
        className,
      )}
      aria-hidden="true"
    />
  );
}

/** Icon plus word, never colour alone. The word is the status; there is no live region here. */
export function SyncStatus({
  icon,
  tone,
  label,
  size = 'md',
  className,
}: {
  icon: StatusIcon;
  tone: StatusTone;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const Icon = ICONS[icon];
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 font-medium',
        size === 'sm' ? 'text-sm' : 'text-sm md:text-base',
        TONES[tone],
        className,
      )}
    >
      <Icon
        className={cn(
          'shrink-0',
          size === 'sm' ? 'size-4' : 'size-5',
          icon === 'spinner' && 'animate-spin',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0">{label}</span>
    </span>
  );
}

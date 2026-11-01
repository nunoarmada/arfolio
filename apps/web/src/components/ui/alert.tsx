import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const tones = {
  error: {
    cls: 'bg-negative-soft text-foreground border-negative/40',
    Icon: XCircle,
    icon: 'text-negative',
  },
  warning: {
    cls: 'bg-warning-soft text-foreground border-warning/40',
    Icon: AlertTriangle,
    icon: 'text-warning',
  },
  success: {
    cls: 'bg-positive-soft text-foreground border-positive/40',
    Icon: CheckCircle2,
    icon: 'text-positive',
  },
  info: {
    cls: 'bg-transfer-soft text-foreground border-transfer/40',
    Icon: Info,
    icon: 'text-transfer',
  },
} as const;

/** Inline message. Errors are announced immediately (role=alert); the rest politely (role=status). */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
  role,
}: {
  tone?: keyof typeof tones;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Override the default role, e.g. 'none' when a surrounding live region does the announcing. */
  role?: 'alert' | 'status' | 'none';
}) {
  const { cls, Icon, icon } = tones[tone];
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={cn('flex gap-3 rounded-lg border p-4 text-sm', cls, className)}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', icon)} aria-hidden="true" />
      <div className="grid grid-cols-1 min-w-0 flex-1 gap-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-foreground">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

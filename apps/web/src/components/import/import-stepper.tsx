import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

/** The wizard's steps; the current one carries aria-current="step". */
export function ImportStepper({
  steps,
  current,
  label,
}: {
  steps: Array<{ id: string; label: string }>;
  current: string;
  label: string;
}) {
  const index = steps.findIndex((s) => s.id === current);
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {steps.map((s, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li
            key={s.id}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm',
              active
                ? 'bg-primary-soft font-semibold text-primary-text'
                : done
                  ? 'text-foreground'
                  : 'text-muted-foreground',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-6 items-center justify-center rounded-full bg-surface-3 text-caption',
                active && 'bg-primary text-primary-foreground',
                done && 'bg-positive-soft text-positive',
              )}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

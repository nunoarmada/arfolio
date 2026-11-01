import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * An in-page view toggle drawn as a segmented control, where each segment is a link (the choice
 * lives in the URL, so Back walks through it). Not for section navigation: that is `PageTabs`.
 * 44px segments on phones, 36px from md.
 */
export function SegmentedNav({
  label,
  items,
  current = 'true',
  className,
}: {
  label: string;
  items: Array<{ href: string; label: string; active: boolean }>;
  /** The `aria-current` value of the active segment. */
  current?: 'true' | 'page';
  className?: string;
}) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="inline-flex rounded-lg bg-surface-2 p-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.active ? current : undefined}
              scroll={false}
              className={cn(
                'flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] md:min-h-8',
                item.active
                  ? 'bg-surface text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

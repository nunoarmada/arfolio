'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { NotificationBell } from '@/components/notifications/notification-bell';
import type { Brand } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { PrivacyToggle } from './privacy-toggle';
import { useShell } from './shell-context';

/**
 * Phone top bar (below md): the brand on the left; "Sync all" (when the household has active
 * connections), privacy mode and the notification bell on the right. It is sticky, translucent over the content, and gains a hairline once the page has scrolled under it.
 */
export function TopBar({
  brand,
  sync,
}: {
  brand: Pick<Brand, 'name' | 'logoUrl'>;
  /** The streamed "Sync all" button, rendered by the server layout (absent for viewers). */
  sync?: ReactNode;
}) {
  const shell = useShell();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 0);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-[var(--topbar-height)] items-center justify-between gap-3 border-b border-transparent bg-background/80 px-4 backdrop-blur-md transition-[border-color] duration-[120ms] md:hidden',
        scrolled && 'border-border',
      )}
    >
      <Link href="/" className="-ml-1 min-w-0 rounded-md p-1 outline-offset-0">
        <BrandMark brand={brand} />
      </Link>
      <div className="flex items-center">
        {sync}
        <PrivacyToggle variant="topbar" />
        {shell ? <NotificationBell unread={shell.unread} variant="topbar" /> : null}
      </div>
    </header>
  );
}

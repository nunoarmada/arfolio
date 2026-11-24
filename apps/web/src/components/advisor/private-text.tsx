'use client';

import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { usePrivacy } from '@/components/privacy';
import { cn } from '@/lib/cn';

/**
 * Text the model wrote. It can hold amounts, so with privacy mode on it is blurred until the
 * member selects or focuses it.
 */
export function PrivateText({ className, children }: { className?: string; children: ReactNode }) {
  const t = useTranslations('advisor');
  const { hidden } = usePrivacy();
  const [revealed, setRevealed] = useState(false);
  const masked = hidden && !revealed;
  return (
    <div
      className={cn(className, masked && 'cursor-pointer select-none blur-sm')}
      {...(masked
        ? {
            tabIndex: 0,
            title: t('privacyReveal'),
            onClick: () => setRevealed(true),
            onFocus: () => setRevealed(true),
          }
        : {})}
    >
      {children}
    </div>
  );
}

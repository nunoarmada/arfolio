'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Copies `text` to the clipboard and says so (polite live region); reports a failed copy. */
export function CopyButton({
  text,
  label,
  copiedLabel,
  variant = 'outline',
  size,
  iconOnly = false,
  className,
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  /** Shows only the icon (the label becomes the accessible name); the button is 44x44. */
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useTranslations('common');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 4000);
  }

  return (
    <>
      <Button
        variant={variant}
        size={iconOnly ? 'icon' : size}
        className={className}
        aria-label={
          iconOnly ? (state === 'copied' ? (copiedLabel ?? t('copied')) : label) : undefined
        }
        onClick={() => void copy()}
      >
        {state === 'copied' ? (
          <Check className="size-4 text-positive" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        {iconOnly ? null : state === 'copied' ? (copiedLabel ?? t('copied')) : label}
      </Button>
      <span className="sr-only" role="status">
        {state === 'copied'
          ? (copiedLabel ?? t('copied'))
          : state === 'failed'
            ? t('copyFailed')
            : ''}
      </span>
      {state === 'failed' ? <span className="text-sm text-negative">{t('copyFailed')}</span> : null}
    </>
  );
}

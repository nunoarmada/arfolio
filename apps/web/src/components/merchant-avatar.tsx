'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { markLogoFailed, merchantLogoUrl, shouldRequestLogo } from '@/lib/merchant-logo';
import type { CategoryDto, TxDto } from '@/server/serialize';
import { CategoryIcon } from './category-icon';

const BOX = { 36: 'size-9', 48: 'size-12' } as const;

/**
 * The leading disc of a movement: always the category icon, with the merchant's logo laid over it
 * once it has loaded. A missing or broken logo simply leaves the category disc in place (no
 * skeleton, no broken image). The logo is decorative: the title next to it carries the name.
 */
export function MerchantAvatar({
  merchant,
  category,
  size = 36,
}: {
  merchant: Pick<NonNullable<TxDto['merchant']>, 'id' | 'hasLogo'> | null | undefined;
  category: CategoryDto | null | undefined;
  size?: keyof typeof BOX;
}) {
  return (
    <span className={cn('relative block shrink-0', BOX[size])}>
      <CategoryIcon category={category} size={size} />
      {shouldRequestLogo(merchant) ? <Logo key={merchant.id} id={merchant.id} /> : null}
    </span>
  );
}

function Logo({ id }: { id: string }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const img = useRef<HTMLImageElement>(null);

  // An image served from cache can finish before React attaches its handlers.
  useEffect(() => {
    const el = img.current;
    if (el?.complete) setState(el.naturalWidth > 0 ? 'loaded' : 'failed');
  }, []);
  useEffect(() => {
    if (state === 'failed') markLogoFailed(id);
  }, [id, state]);

  if (state === 'failed') return null;
  return (
    <img
      ref={img}
      src={merchantLogoUrl(id)}
      width={48}
      height={48}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={() => setState('loaded')}
      onError={() => setState('failed')}
      className={cn(
        'absolute inset-0 size-full rounded-full bg-white object-contain p-1 ring-1 ring-border transition-opacity duration-[120ms] motion-reduce:transition-none',
        state === 'loaded' ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

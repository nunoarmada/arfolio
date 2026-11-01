import { SearchX } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AuthShell } from '@/components/auth-shell';
import { buttonVariants } from '@/components/ui/button';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <AuthShell>
      <span
        aria-hidden="true"
        className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text"
      >
        <SearchX className="size-5" />
      </span>
      <h1 className="mb-2 text-title">{t('notFoundTitle')}</h1>
      <p className="mb-5 max-w-[52ch] text-sm text-muted-foreground">{t('notFoundBody')}</p>
      <Link href="/" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
        {t('goHome')}
      </Link>
    </AuthShell>
  );
}

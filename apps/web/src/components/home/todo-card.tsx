import { CheckCircle2, ListChecks, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardHeader, IconTile } from '@/components/ui/card';
import { cn } from '@/lib/cn';

export interface TodoItem {
  key: string;
  icon: LucideIcon;
  tone?: 'primary' | 'warning';
  text: string;
  /** Action link; viewers get the sentence only. */
  action?: { href: string; label: string };
  testId?: string;
}

function Row({ item }: { item: TodoItem }) {
  return (
    <li
      data-testid={item.testId}
      className="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 md:px-5 xl:px-6"
    >
      <p className="flex min-w-0 flex-1 basis-40 items-center gap-3 text-base font-medium">
        <IconTile
          icon={item.icon}
          tone={item.tone ?? 'primary'}
          className="size-9 rounded-lg [&>svg]:size-[18px]"
        />
        <span className="min-w-0">{item.text}</span>
      </p>
      {item.action ? (
        <Link
          href={item.action.href}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {item.action.label}
        </Link>
      ) : null}
    </li>
  );
}

/** A row that says its data could not be loaded, with the usual retry link. */
export function TodoErrorRow({
  testId,
  text,
  retry,
}: {
  testId: string;
  text: ReactNode;
  retry: string;
}) {
  return (
    <li
      data-testid={testId}
      className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm text-muted-foreground md:px-5 xl:px-6"
    >
      <span>{text}</span>
      <a
        href="/"
        className="inline-flex min-h-11 items-center font-medium text-primary-text underline underline-offset-4"
      >
        {retry}
      </a>
    </li>
  );
}

/**
 * "Para fazer": what is waiting for a decision, in one place: transactions to review, connections
 * that need attention and recurring payments to confirm. With nothing to do it says so, calmly.
 */
export async function TodoCard({
  items,
  errors,
  className,
}: {
  items: TodoItem[];
  /** Rows for the pieces that failed to load. */
  errors: ReactNode[];
  className?: string;
}) {
  const t = await getTranslations('home');
  const open = items.length + errors.length;
  return (
    <Card
      as="section"
      aria-labelledby="home-todo-title"
      data-testid="home-todo"
      className={cn('flex flex-col', className)}
    >
      <CardHeader
        title={t('todo.title')}
        titleId="home-todo-title"
        icon={ListChecks}
        actions={
          items.length > 0 ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
              <span className="sr-only">{t('todo.title')}: </span>
              {items.length}
            </span>
          ) : null
        }
      />
      {open > 0 ? (
        <ul className="-mx-4 flex-1 divide-y border-t md:-mx-5 xl:-mx-6">
          {items.map((item) => (
            <Row key={item.key} item={item} />
          ))}
          {errors}
        </ul>
      ) : (
        <div className="flex flex-1 flex-col items-start justify-center gap-3 py-2">
          <IconTile
            icon={CheckCircle2}
            tone="positive"
            className="size-10 rounded-lg [&>svg]:size-5"
          />
          <div>
            <p className="text-base font-semibold">{t('todo.clear')}</p>
            <p className="mt-0.5 max-w-[52ch] text-sm text-muted-foreground">
              {t('todo.clearBody')}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

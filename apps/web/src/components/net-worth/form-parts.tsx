'use client';

import { Check, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { kindIcon } from './kind-icon';

/**
 * One section of a net worth form, as a Card like the budget line forms. It stays a fieldset
 * with a legend (the group's name for assistive technology); the legend is styled as the card's
 * header, and the first thing inside the card, so nothing is lost visually or for screen readers.
 */
export function FormCard({
  legend,
  description,
  children,
  className,
  fieldsetClassName,
  ...rest
}: {
  legend: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** On the fieldset itself, e.g. a scroll margin for an element that is scrolled to by id. */
  fieldsetClassName?: string;
} & Omit<React.ComponentPropsWithoutRef<'fieldset'>, 'className' | 'children'>) {
  return (
    <Card className={className}>
      <fieldset className={cn('m-0 min-w-0 border-0 p-0', fieldsetClassName)} {...rest}>
        <legend className="p-0 text-card-title">{legend}</legend>
        {description ? (
          <p className="mt-0.5 text-label font-normal text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-3 grid grid-cols-1 gap-4 md:mt-4">{children}</div>
      </fieldset>
    </Card>
  );
}

/**
 * One choice of a radio group, as a card: a native radio in a label, so arrow keys, focus and the
 * group semantics come for free. Chosen: brand tint, a 2px brand ring, brand text and a check.
 * The others are plain cards. The ring is a shadow, so the card does not shift when chosen.
 */
export function RadioCard({
  name,
  value,
  checked,
  onChange,
  icon: Icon,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-base transition-colors duration-[120ms]',
        'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        checked
          ? 'bg-primary-soft font-medium text-primary-text shadow-[0_0_0_2px_var(--primary)]'
          : 'bg-surface shadow-card hover:bg-surface-2',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      {Icon ? (
        <Icon
          className={cn('size-5 shrink-0', checked ? 'text-primary-text' : 'text-muted-foreground')}
          aria-hidden="true"
        />
      ) : null}
      <span className="min-w-0 flex-1">{children}</span>
      {checked ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
    </label>
  );
}

/** Kind choice as radio cards, inside a form card named by the legend. */
export function KindCards({
  legend,
  name,
  side,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  side: 'asset' | 'liability';
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <FormCard legend={legend}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <RadioCard
            key={option.value}
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            icon={kindIcon(side, option.value)}
          >
            {option.label}
          </RadioCard>
        ))}
      </div>
    </FormCard>
  );
}

/** The list of problems after a failed submit, each a button that moves focus to its field. */
export function ErrorSummary({
  title,
  items,
}: {
  title: string;
  items: Array<{ field: string; label: string; message: string }>;
}) {
  if (items.length === 0) return null;
  return (
    <Alert tone="error" title={title}>
      <ul className="grid grid-cols-1 gap-1">
        {items.map((item) => (
          <li key={item.field}>
            <button
              type="button"
              onClick={() =>
                document
                  .querySelector<HTMLElement>(`[name="${item.field}"], #${item.field}`)
                  ?.focus()
              }
              className="min-h-11 text-left underline underline-offset-4"
            >
              {item.label}: {item.message}
            </button>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** Guardar / Cancelar: sticky above the tab bar on phones while the form has unsaved changes. */
export function SaveBar({
  dirty,
  dirtyText,
  pending,
  saveLabel,
  savingLabel,
  cancelLabel,
  onCancel,
  extra,
}: {
  dirty: boolean;
  dirtyText: string;
  pending: boolean;
  saveLabel: string;
  savingLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'sticky bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom))] z-20 -mx-4 flex items-center justify-between gap-3 border-t bg-background px-4 py-3 md:static md:mx-0 md:border-0 md:px-0 md:py-0',
        !dirty && 'max-md:static max-md:border-0 max-md:bg-transparent max-md:px-4 max-md:py-0',
      )}
    >
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {dirty ? dirtyText : ''}
      </p>
      <div className="flex gap-2">
        {extra}
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" loading={pending}>
          {pending ? savingLabel : saveLabel}
        </Button>
      </div>
    </div>
  );
}

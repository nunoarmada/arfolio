'use client';

import { useTranslations } from 'next-intl';
import { AlertDialog } from 'radix-ui';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { CATEGORY_ICON_KEYS, CATEGORY_ICONS, type CategoryIconKey } from '@/lib/category-visuals';
import {
  createCategoryAction,
  createGroupAction,
  deleteCategoryAction,
  updateCategoryAction,
  updateGroupAction,
} from '@/server/actions/categories';
import type { CategoryDto, GroupDto } from '@/server/serialize';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

const KINDS = ['expense', 'income', 'saving'] as const;

/** Name, group and icon of a category (create or edit). */
export function CategoryFormSheet({
  open,
  onOpenChange,
  category,
  groups,
  defaultGroupId,
  onSaved,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: CategoryDto;
  groups: GroupDto[];
  defaultGroupId?: string;
  onSaved: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('categories');
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [icon, setIcon] = useState<CategoryIconKey | ''>('');
  const [error, setError] = useState<string | null>(null);
  const usable = groups.filter((g) => !g.archived);

  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setGroupId(category?.groupId ?? defaultGroupId ?? usable[0]?.id ?? '');
    setIcon(
      category?.icon && category.icon in CATEGORY_ICONS ? (category.icon as CategoryIconKey) : '',
    );
    setError(null);
  }, [open, category, defaultGroupId]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !groupId) return;
    startTransition(async () => {
      const result = category
        ? await updateCategoryAction(category.id, { name, groupId, icon: icon || null })
        : await createCategoryAction({ name, groupId, icon: icon || null });
      if (!result.ok) return setError(failure(result));
      toast.success(category ? t('saved') : t('created'));
      onOpenChange(false);
      onSaved();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={category ? t('editCategory') : t('addCategory')}
      tall
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field label={t('name')}>
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={80}
              required
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('group')}>
          {(p) => (
            <Select {...p} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {usable.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="grid grid-cols-1 gap-1.5">
          <legend className="text-sm font-medium">{t('icon')}</legend>
          <div className="grid grid-cols-6 gap-2">
            <label className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-input text-xs has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
              <input
                type="radio"
                name="icon"
                className="sr-only"
                checked={icon === ''}
                onChange={() => setIcon('')}
              />
              {t('iconAuto')}
            </label>
            {CATEGORY_ICON_KEYS.map((key) => {
              const Icon = CATEGORY_ICONS[key];
              return (
                <label
                  key={key}
                  className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-input has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    name="icon"
                    className="sr-only"
                    checked={icon === key}
                    onChange={() => setIcon(key)}
                  />
                  <Icon className="size-5" aria-hidden="true" />
                  <span className="sr-only">{t(`icons.${key}`)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <Button type="submit" loading={pending} disabled={!name.trim() || !groupId}>
          {t('save')}
        </Button>
      </form>
    </Sheet>
  );
}

/** Name and kind of a category group (create or edit). */
export function GroupFormSheet({
  open,
  onOpenChange,
  group,
  onSaved,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group?: GroupDto;
  onSaved: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('categories');
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('expense');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setKind(group && group.kind !== 'transfer' ? group.kind : 'expense');
    setError(null);
  }, [open, group]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    startTransition(async () => {
      const result = group
        ? await updateGroupAction(group.id, { name, kind })
        : await createGroupAction({ name, kind });
      if (!result.ok) return setError(failure(result));
      toast.success(group ? t('saved') : t('created'));
      onOpenChange(false);
      onSaved();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={group ? t('editGroup') : t('addGroup')}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field label={t('name')}>
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={80}
              required
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('kind')}>
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" loading={pending} disabled={!name.trim()}>
          {t('save')}
        </Button>
      </form>
    </Sheet>
  );
}

/** Deleting a user category: its movements move to another category or go back to review. */
export function DeleteCategoryDialog({
  category,
  groups,
  onOpenChange,
  onDeleted,
  onCloseAutoFocus,
}: {
  category: CategoryDto | null;
  groups: GroupDto[];
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('categories');
  const common = useTranslations('common');
  const toast = useToast();
  const failure = useFailureMessage();
  const [reassignTo, setReassignTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setReassignTo('');
    setError(null);
  }, [category]);

  return (
    <AlertDialog.Root open={category !== null} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <AlertDialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-50 grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <AlertDialog.Title className="text-lg font-semibold">
            {t('deleteTitle', { name: category?.name ?? '' })}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-base text-muted-foreground">
            {t('deleteBody')}
          </AlertDialog.Description>
          <Field label={t('reassign')}>
            {(p) => (
              <Select {...p} value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                <option value="">{t('reassignNone')}</option>
                {groups
                  .filter((g) => !g.archived && g.kind !== 'transfer')
                  .map((g) => (
                    <optgroup key={g.id} label={g.name}>
                      {g.categories
                        .filter((c) => !c.archived && c.id !== category?.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
              </Select>
            )}
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{common('cancel')}</Button>
            </AlertDialog.Cancel>
            <Button
              variant="destructive"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!category) return;
                  const result = await deleteCategoryAction(category.id, reassignTo || undefined);
                  if (!result.ok) return setError(failure(result));
                  toast.success(t('deleted'));
                  onOpenChange(false);
                  onDeleted();
                })
              }
            >
              {t('delete')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

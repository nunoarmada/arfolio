'use client';

import {
  Archive,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import {
  archiveCategoryAction,
  archiveGroupAction,
  deleteGroupAction,
  reorderCategoriesAction,
  reorderGroupsAction,
} from '@/server/actions/categories';
import type { ActionResult } from '@/server/actions/result';
import type { CategoryDto, GroupDto } from '@/server/serialize';
import { CategoryIcon } from '../category-icon';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';
import { CategoryFormSheet, DeleteCategoryDialog, GroupFormSheet } from './category-forms';

const groupMoreId = (id: string) => `group-more-${id}`;
const categoryMoreId = (id: string) => `category-more-${id}`;

const menuItem =
  'flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2';

function moveWithin<T extends { id: string }>(
  list: T[],
  id: string,
  delta: -1 | 1,
): string[] | null {
  const index = list.findIndex((x) => x.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return null;
  const ids = list.map((x) => x.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  return ids;
}

/** Groups and categories: rename, icon, reorder with buttons (no dragging), archive, delete. */
export function CategoriesView({ groups, canWrite }: { groups: GroupDto[]; canWrite: boolean }) {
  const t = useTranslations('categories');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [, startTransition] = useTransition();
  const [editCategory, setEditCategory] = useState<{
    category?: CategoryDto;
    groupId?: string;
  } | null>(null);
  const [editGroup, setEditGroup] = useState<{ group?: GroupDto } | null>(null);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);
  // The sheets and the dialog open from menu items, so they have no Trigger: they hand focus back
  // to the "⋯" button that opened them (or to "Adicionar categoria" once that row is gone).
  const returnTo = useRef<string | null>(null);
  const returnFocus = (e: Event) => {
    const target =
      (returnTo.current ? document.getElementById(returnTo.current) : null) ??
      (returnTo.current ? document.getElementById('category-add') : null);
    if (target) {
      e.preventDefault();
      target.focus();
    }
    returnTo.current = null;
  };

  const visibleGroups = groups.filter((g) => !g.archived && g.kind !== 'transfer');
  const refresh = () => router.refresh();

  function run(action: () => Promise<ActionResult>, success?: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return report(result);
      if (success) toast.success(success);
      refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-5">
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            id="category-add"
            onClick={() => {
              returnTo.current = null;
              setEditCategory({});
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('addCategory')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              returnTo.current = null;
              setEditGroup({});
            }}
          >
            {t('addGroup')}
          </Button>
        </div>
      ) : null}

      {visibleGroups.map((group) => {
        const categories = group.categories.filter((c) => !c.archived);
        return (
          <section
            key={group.id}
            aria-labelledby={`group-${group.id}`}
            className="relative min-w-0 overflow-hidden rounded-lg bg-surface text-foreground shadow-card"
          >
            <div className="flex min-h-14 items-center gap-1 py-1 pl-4 pr-2 md:pl-5">
              <h2 id={`group-${group.id}`} className="text-card-title min-w-0 flex-1 truncate">
                {group.name}
              </h2>
              {canWrite ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-md:hidden"
                    aria-label={t('moveGroupUp', { name: group.name })}
                    disabled={visibleGroups[0]?.id === group.id}
                    onClick={() => {
                      const ids = moveWithin(visibleGroups, group.id, -1);
                      if (ids) run(() => reorderGroupsAction(ids));
                    }}
                  >
                    <ChevronUp className="size-5" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-md:hidden"
                    aria-label={t('moveGroupDown', { name: group.name })}
                    disabled={visibleGroups.at(-1)?.id === group.id}
                    onClick={() => {
                      const ids = moveWithin(visibleGroups, group.id, 1);
                      if (ids) run(() => reorderGroupsAction(ids));
                    }}
                  >
                    <ChevronDown className="size-5" aria-hidden="true" />
                  </Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <Button
                        id={groupMoreId(group.id)}
                        variant="ghost"
                        size="icon"
                        aria-label={t('groupMenu', { name: group.name })}
                      >
                        <MoreHorizontal className="size-5" aria-hidden="true" />
                      </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        sideOffset={4}
                        className="z-50 min-w-48 rounded-lg bg-surface-raised p-1 shadow-raised"
                      >
                        <DropdownMenu.Item
                          className={`${menuItem} md:hidden`}
                          disabled={visibleGroups[0]?.id === group.id}
                          onSelect={() => {
                            const ids = moveWithin(visibleGroups, group.id, -1);
                            if (ids) run(() => reorderGroupsAction(ids));
                          }}
                        >
                          <ChevronUp className="size-5" aria-hidden="true" />
                          {t('menuUp')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={`${menuItem} md:hidden`}
                          disabled={visibleGroups.at(-1)?.id === group.id}
                          onSelect={() => {
                            const ids = moveWithin(visibleGroups, group.id, 1);
                            if (ids) run(() => reorderGroupsAction(ids));
                          }}
                        >
                          <ChevronDown className="size-5" aria-hidden="true" />
                          {t('menuDown')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={menuItem}
                          onSelect={() => {
                            returnTo.current = groupMoreId(group.id);
                            setEditGroup({ group });
                          }}
                        >
                          <Pencil className="size-5" aria-hidden="true" />
                          {t('rename')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={menuItem}
                          onSelect={() =>
                            run(() => archiveGroupAction(group.id), t('archivedDone'))
                          }
                        >
                          <Archive className="size-5" aria-hidden="true" />
                          {t('archive')}
                        </DropdownMenu.Item>
                        {!group.templateKey && categories.length === 0 ? (
                          <DropdownMenu.Item
                            className={`${menuItem} text-negative`}
                            onSelect={() => run(() => deleteGroupAction(group.id), t('deleted'))}
                          >
                            <Trash2 className="size-5" aria-hidden="true" />
                            {t('delete')}
                          </DropdownMenu.Item>
                        ) : null}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </>
              ) : null}
            </div>
            {categories.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground md:px-5">{t('emptyGroup')}</p>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {categories.map((c) => (
                  <li
                    key={c.id}
                    className="flex min-h-14 items-center gap-2 pl-4 pr-1 md:pl-5 md:pr-2"
                  >
                    <CategoryIcon category={c} size={36} />
                    <span className="min-w-0 flex-1 truncate pl-1 text-base">{c.name}</span>
                    {canWrite ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="max-md:hidden"
                          aria-label={t('moveUp', { name: c.name })}
                          disabled={categories[0]?.id === c.id}
                          onClick={() => {
                            const ids = moveWithin(categories, c.id, -1);
                            if (ids) run(() => reorderCategoriesAction(ids));
                          }}
                        >
                          <ChevronUp className="size-5" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="max-md:hidden"
                          aria-label={t('moveDown', { name: c.name })}
                          disabled={categories.at(-1)?.id === c.id}
                          onClick={() => {
                            const ids = moveWithin(categories, c.id, 1);
                            if (ids) run(() => reorderCategoriesAction(ids));
                          }}
                        >
                          <ChevronDown className="size-5" aria-hidden="true" />
                        </Button>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <Button
                              id={categoryMoreId(c.id)}
                              variant="ghost"
                              size="icon"
                              aria-label={t('categoryMenu', { name: c.name })}
                            >
                              <MoreHorizontal className="size-5" aria-hidden="true" />
                            </Button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              align="end"
                              sideOffset={4}
                              className="z-50 min-w-48 rounded-lg bg-surface-raised p-1 shadow-raised"
                            >
                              <DropdownMenu.Item
                                className={`${menuItem} md:hidden`}
                                disabled={categories[0]?.id === c.id}
                                onSelect={() => {
                                  const ids = moveWithin(categories, c.id, -1);
                                  if (ids) run(() => reorderCategoriesAction(ids));
                                }}
                              >
                                <ChevronUp className="size-5" aria-hidden="true" />
                                {t('menuUp')}
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                className={`${menuItem} md:hidden`}
                                disabled={categories.at(-1)?.id === c.id}
                                onSelect={() => {
                                  const ids = moveWithin(categories, c.id, 1);
                                  if (ids) run(() => reorderCategoriesAction(ids));
                                }}
                              >
                                <ChevronDown className="size-5" aria-hidden="true" />
                                {t('menuDown')}
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                className={menuItem}
                                onSelect={() => {
                                  returnTo.current = categoryMoreId(c.id);
                                  setEditCategory({ category: c });
                                }}
                              >
                                <Pencil className="size-5" aria-hidden="true" />
                                {t('edit')}
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                className={menuItem}
                                onSelect={() =>
                                  run(() => archiveCategoryAction(c.id), t('archivedDone'))
                                }
                              >
                                <Archive className="size-5" aria-hidden="true" />
                                {t('archive')}
                              </DropdownMenu.Item>
                              {!c.templateKey ? (
                                <DropdownMenu.Item
                                  className={`${menuItem} text-negative`}
                                  onSelect={() => {
                                    returnTo.current = categoryMoreId(c.id);
                                    setDeleting(c);
                                  }}
                                >
                                  <Trash2 className="size-5" aria-hidden="true" />
                                  {t('delete')}
                                </DropdownMenu.Item>
                              ) : null}
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {canWrite ? (
        <>
          <CategoryFormSheet
            open={editCategory !== null}
            onOpenChange={(o) => !o && setEditCategory(null)}
            category={editCategory?.category}
            groups={groups}
            defaultGroupId={editCategory?.groupId}
            onSaved={refresh}
            onCloseAutoFocus={returnFocus}
          />
          <GroupFormSheet
            open={editGroup !== null}
            onOpenChange={(o) => !o && setEditGroup(null)}
            group={editGroup?.group}
            onSaved={refresh}
            onCloseAutoFocus={returnFocus}
          />
          <DeleteCategoryDialog
            category={deleting}
            groups={groups}
            onOpenChange={(o) => !o && setDeleting(null)}
            onDeleted={refresh}
            onCloseAutoFocus={returnFocus}
          />
        </>
      ) : null}
    </div>
  );
}

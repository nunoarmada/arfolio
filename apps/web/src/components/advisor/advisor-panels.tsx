'use client';

import { ChevronLeft, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { useReportFailure } from '@/components/use-action-error';
import {
  deleteAdvisorNoteAction,
  loadAdvisorPanelAction,
  saveAdvisorSettingsAction,
} from '@/server/actions/advisor';
import type { AdvisorPanel } from '@/server/advisor-data';

export type PanelName = 'chat' | 'settings' | 'notes';

/** The notes and settings of the member, loaded when a panel opens. */
function usePanelData(): {
  data: AdvisorPanel | null;
  failed: boolean;
  set: (next: AdvisorPanel) => void;
  retry: () => void;
} {
  const [data, setData] = useState<AdvisorPanel | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadAdvisorPanelAction().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
        setFailed(false);
      } else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  return {
    data,
    failed,
    set: setData,
    retry: () => {
      setFailed(false);
      setAttempt((n) => n + 1);
    },
  };
}

/** A panel that replaces the conversation inside the same container: a back button and a title. */
function PanelFrame({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const common = useTranslations('common');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        <button
          type="button"
          aria-label={common('back')}
          onClick={onBack}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2"
        >
          <ChevronLeft className="size-6" aria-hidden="true" />
        </button>
        <h3 className="text-card-title">{title}</h3>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

function PanelState({
  data,
  failed,
  retry,
  children,
}: {
  data: AdvisorPanel | null;
  failed: boolean;
  retry: () => void;
  children: (data: AdvisorPanel) => ReactNode;
}) {
  const t = useTranslations('advisor');
  const common = useTranslations('common');
  if (data) return <>{children(data)}</>;
  if (failed) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">{t('loadError')}</p>
        <Button variant="outline" onClick={retry}>
          {common('retry')}
        </Button>
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-3">
      <span className="sr-only">{common('loading')}</span>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

/** Proactive messages on or off, and how many a week. Saved on every change. */
export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const t = useTranslations('advisor.settings');
  const toast = useToast();
  const report = useReportFailure();
  const panel = usePanelData();
  const labelId = useId();
  const helpId = useId();
  const capId = useId();

  async function save(next: AdvisorPanel['settings']) {
    const before = panel.data;
    if (!before) return;
    panel.set({ ...before, settings: next });
    const result = await saveAdvisorSettingsAction(next);
    if (result.ok) {
      toast.success(t('saved'));
    } else {
      panel.set(before);
      report(result);
    }
  }

  return (
    <PanelFrame title={t('title')} onBack={onBack}>
      <PanelState data={panel.data} failed={panel.failed} retry={panel.retry}>
        {({ settings, weeklyCapDefault }) => {
          const cap = settings.weeklyCap ?? weeklyCapDefault;
          const options = Array.from(
            { length: Math.max(weeklyCapDefault, cap, 1) },
            (_, i) => i + 1,
          );
          if (!options.includes(cap)) options.unshift(cap);
          return (
            <div className="grid grid-cols-1 gap-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 pt-2.5">
                  <p id={labelId} className="text-base font-medium">
                    {t('proactive')}
                  </p>
                  <p id={helpId} className="mt-0.5 text-sm text-muted-foreground">
                    {t('proactiveHelp')}
                  </p>
                </div>
                <Switch
                  checked={settings.proactiveEnabled}
                  aria-labelledby={labelId}
                  aria-describedby={helpId}
                  onCheckedChange={(proactiveEnabled) =>
                    void save({ ...settings, proactiveEnabled })
                  }
                />
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                <label htmlFor={capId} className="text-base font-medium">
                  {t('weeklyCap')}
                </label>
                <Select
                  id={capId}
                  value={String(cap)}
                  disabled={!settings.proactiveEnabled}
                  onChange={(event) =>
                    void save({ ...settings, weeklyCap: Number(event.target.value) })
                  }
                >
                  {options.map((n) => (
                    <option key={n} value={n}>
                      {t('weeklyCapOption', { count: n })}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          );
        }}
      </PanelState>
    </PanelFrame>
  );
}

const firstWords = (text: string) => text.split(/\s+/).slice(0, 6).join(' ');

/** What the advisor was asked to remember, each with a delete button. */
export function NotesPanel({ onBack }: { onBack: () => void }) {
  const t = useTranslations('advisor.notes');
  const toast = useToast();
  const report = useReportFailure();
  const panel = usePanelData();
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(id: string) {
    setDeleting(id);
    const result = await deleteAdvisorNoteAction(id);
    setDeleting(null);
    if (result.ok) {
      toast.success(t('deleted'));
      if (panel.data)
        panel.set({ ...panel.data, notes: panel.data.notes.filter((n) => n.id !== id) });
    } else report(result);
  }

  return (
    <PanelFrame title={t('title')} onBack={onBack}>
      <PanelState data={panel.data} failed={panel.failed} retry={panel.retry}>
        {({ notes }) =>
          notes.length === 0 ? (
            <p className="max-w-[40ch] text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="-my-1 divide-y divide-border">
              {notes.map((note) => (
                <li key={note.id} className="flex items-center gap-2 py-1">
                  <p className="min-w-0 flex-1 break-words py-2 text-sm">{note.text}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('delete', { text: firstWords(note.text) })}
                    loading={deleting === note.id}
                    disabled={deleting !== null}
                    onClick={() => void remove(note.id)}
                  >
                    <Trash2 className="size-5 text-muted-foreground" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </PanelState>
    </PanelFrame>
  );
}

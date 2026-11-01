'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CopyButton } from '../copy-button';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { IDENT } from './shared';

/**
 * "Como ligar": the MCP URL, the claude.ai steps and the Claude Code command (with the literal
 * `<token>`: the real one is only ever shown in the reveal dialog). A native <details>, so the
 * summary is keyboard operable; the page decides whether it starts open.
 */
export function ConnectionGuide({
  open,
  onOpenChange,
  url,
  command,
  brandName,
  onToTokens,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  command: string;
  brandName: string;
  onToTokens: () => void;
}) {
  const t = useTranslations('integrations.guide');
  const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;
  return (
    <details
      id="integrations-guide"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className="group rounded-lg bg-surface shadow-card"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 hover:bg-surface-2 md:px-5 [&::-webkit-details-marker]:hidden">
        <h2 className="text-card-title">{t('title')}</h2>
        <ChevronDown
          className="size-5 shrink-0 text-muted-foreground transition-transform duration-[180ms] group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="grid grid-cols-1 gap-5 px-4 pb-4 md:px-5 md:pb-5">
        <Alert tone="info">{t('reachability')}</Alert>

        <div className="grid grid-cols-1 gap-1.5">
          <Field label={t('urlLabel')}>
            {(p) => (
              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-start">
                <Input
                  {...p}
                  readOnly
                  value={url}
                  onFocus={(event) => event.currentTarget.select()}
                  className={`min-w-0 sm:flex-1 ${IDENT}`}
                />
                <CopyButton text={url} label={t('copyUrl')} className="w-full sm:w-auto" />
              </div>
            )}
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <h3 className="text-card-title">{t('claudeAi.title')}</h3>
          <ol className="grid grid-cols-1 list-decimal gap-1 pl-5 text-base">
            <li>{t.rich('claudeAi.step1', { strong })}</li>
            <li>{t.rich('claudeAi.step2', { strong })}</li>
            <li>{t('claudeAi.step3')}</li>
            <li>{t('claudeAi.step4', { brand: brandName })}</li>
          </ol>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <h3 className="text-card-title">{t('claudeCode.title')}</h3>
          <p className="max-w-[68ch] text-base">
            {t('claudeCode.body', { placeholder: '<token>' })}
          </p>
          <div className="rounded-md bg-surface-2 p-3">
            <pre
              className={`whitespace-pre-wrap [overflow-wrap:anywhere] font-[inherit] text-sm ${IDENT}`}
              data-testid="guide-command"
            >
              {command}
            </pre>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={command} label={t('copyCommand')} className="w-full sm:w-auto" />
            <Button variant="link" onClick={onToTokens} className="max-sm:w-full">
              {t('toTokens')}
            </Button>
          </div>
        </div>
      </div>
    </details>
  );
}

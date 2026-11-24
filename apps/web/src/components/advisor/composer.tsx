'use client';

import { ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';

/** The text field grows with what is typed, up to this height (10rem), then scrolls. */
const MAX_HEIGHT = 160;

/**
 * The message box. Enter sends, Shift+Enter adds a line (not while an input method is composing).
 * `onSend` says whether it took the text; only then is the box cleared.
 */
export function Composer({
  onSend,
  disabled,
  inputRef,
  restore,
}: {
  onSend: (text: string) => boolean;
  /** An answer is being written: the member can type, but not send. */
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Text a refused send gives back (the box takes it unless the member already typed). */
  restore: { text: string } | null;
}) {
  const t = useTranslations('advisor');
  const id = useId();
  const [value, setValue] = useState('');
  const empty = value.trim() === '';

  useEffect(() => {
    if (restore) setValue((current) => (current === '' ? restore.text : current));
  }, [restore]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, inputRef]);

  const submit = () => {
    if (disabled || empty) return;
    if (onSend(value)) setValue('');
  };

  return (
    <form
      method="post"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
      className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <label htmlFor={id} className="sr-only">
        {t('composer.label')}
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id={id}
          ref={inputRef}
          rows={1}
          value={value}
          maxLength={4000}
          placeholder={t('composer.placeholder')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className={cn(
            'min-h-11 max-h-40 min-w-0 flex-1 resize-none rounded-xl py-2.5 text-base md:text-[15px]',
          )}
        />
        <button
          type="submit"
          aria-label={t('send')}
          disabled={disabled || empty}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors duration-[120ms] hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-50"
        >
          <ArrowUp className="size-5" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-1.5 hidden text-caption font-normal text-muted-foreground md:block">
        {t('composer.hint')}
      </p>
    </form>
  );
}

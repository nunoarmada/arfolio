'use client';

import { useEffect, useRef, type Ref } from 'react';
import { cn } from '@/lib/cn';

export const OTP_LENGTH = 6;

/** Keeps the digits of a typed or pasted value ("123 456", "123-456") and caps it at six. */
/** A code completes once, on the keystroke that fills it; further input on a full code does not re-fire. */
export function shouldComplete(next: string, previous: string): boolean {
  return next.length === OTP_LENGTH && next !== previous;
}

export function normalizeOtp(value: string): string {
  return value.replace(/\D/g, '').slice(0, OTP_LENGTH);
}

/**
 * Six-digit code entry built on ONE real input (so paste, autofill and screen readers behave
 * natively); the boxes are decorative. Calls `onComplete` as soon as the sixth digit is in.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
  label,
  describedBy,
  autoFocus,
  ref,
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete?: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  label: string;
  describedBy?: string;
  autoFocus?: boolean;
  ref?: Ref<HTMLInputElement>;
}) {
  const inner = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inner.current?.focus();
  }, [autoFocus]);

  const set = (node: HTMLInputElement | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <div className="group relative mx-auto w-full max-w-[19rem]">
      <div aria-hidden="true" className="grid grid-cols-6 gap-2">
        {Array.from({ length: OTP_LENGTH }, (_, i) => (
          <div
            key={i}
            data-active={i === Math.min(value.length, OTP_LENGTH - 1)}
            className={cn(
              'flex h-12 items-center justify-center rounded-md border bg-surface text-xl font-semibold tabular-nums group-focus-within:data-[active=true]:border-ring group-focus-within:data-[active=true]:outline-2 group-focus-within:data-[active=true]:outline-ring',
              invalid ? 'border-negative' : 'border-input',
            )}
          >
            {value[i] ?? ''}
          </div>
        ))}
      </div>
      <input
        ref={set}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        spellCheck={false}
        onChange={(e) => {
          const next = normalizeOtp(e.target.value);
          onChange(next);
          if (shouldComplete(next, value)) onComplete?.(next);
        }}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 focus:opacity-0"
      />
    </div>
  );
}

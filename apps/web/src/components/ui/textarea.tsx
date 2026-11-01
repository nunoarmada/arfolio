import type { Ref, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { inputClass } from './field';

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(inputClass, 'h-auto min-h-24 resize-y py-2.5 leading-6', className)}
      {...props}
    />
  );
}

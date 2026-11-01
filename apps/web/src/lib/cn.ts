import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `twMerge` that knows the v2 design tokens: without this `text-kpi` would be read as a text
 * colour and silently drop (or be dropped by) `text-foreground`, and `shadow-card` as a shadow
 * colour that fights `shadow-[...]`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['display', 'kpi', 'title', 'heading', 'card-title', 'label', 'caption'] },
      ],
      shadow: [{ shadow: ['xs', 'card', 'raised', 'overlay'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

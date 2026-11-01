import { Link2, Plus } from 'lucide-react';

/**
 * What the import does with a row of the sheet: it matches something the household already has
 * (icon, then the sentence naming it) or it is new (a filled chip with its own icon and word).
 */
export function MatchChip({
  matchLabel,
  newLabel,
}: {
  matchLabel: string | null;
  newLabel: string;
}) {
  return matchLabel !== null ? (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
      <Link2 className="size-4 shrink-0" aria-hidden="true" />
      {matchLabel}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-sm bg-primary-soft px-2 py-1 text-sm font-medium">
      <Plus className="size-4 shrink-0" aria-hidden="true" />
      {newLabel}
    </span>
  );
}

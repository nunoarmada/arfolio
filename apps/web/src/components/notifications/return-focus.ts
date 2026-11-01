/**
 * Returns focus to the bell once its panel has closed, unless something else already has it.
 *
 * Radix runs `onCloseAutoFocus` when the panel unmounts, which is after its exit animation. A
 * panel link that navigates closes the panel at once, so the page it leads to (a budget line that
 * focuses its own row, for instance) can claim focus before that moment. Taking focus back then
 * would steal it from the destination. After Escape or the close button nothing has focus
 * (`document.body`), and the bell gets it.
 */
export function returnFocusToTrigger(
  trigger: { focus: () => void } | null,
  doc: { body: unknown; activeElement: unknown },
): void {
  if (doc.activeElement && doc.activeElement !== doc.body) return;
  trigger?.focus();
}

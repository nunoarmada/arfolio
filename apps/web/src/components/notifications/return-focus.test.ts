import { describe, expect, it, vi } from 'vitest';
import { returnFocusToTrigger } from './return-focus';

const body = { tag: 'body' };
const doc = (activeElement: object | null) => ({ body, activeElement });

describe('returnFocusToTrigger', () => {
  it('focuses the trigger when nothing holds focus (Escape or the close button)', () => {
    const trigger = { focus: vi.fn() };
    returnFocusToTrigger(trigger, doc(body));
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('focuses the trigger when there is no active element at all', () => {
    const trigger = { focus: vi.fn() };
    returnFocusToTrigger(trigger, doc(null));
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('leaves focus alone when the destination of a link has already claimed it', () => {
    const trigger = { focus: vi.fn() };
    returnFocusToTrigger(trigger, doc({ id: 'line-1' }));
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it('does nothing without a trigger', () => {
    expect(() => returnFocusToTrigger(null, doc(body))).not.toThrow();
  });
});

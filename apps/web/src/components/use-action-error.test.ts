import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import type { ActionFailure } from '@/server/actions/result';
import { failureText, type FailureT } from './use-action-error';

const t = createTranslator({
  locale: 'en',
  messages,
  namespace: 'actionErrors',
}) as unknown as FailureT;

describe('failureText', () => {
  it('fills the PDF row limit from the failure parameters into the copy', () => {
    const failure: ActionFailure = {
      ok: false,
      code: 'validation',
      reason: 'pdf_too_long',
      fields: [],
      detail: { code: 'pdf_too_long', params: { max: 321 } },
    };
    const text = failureText(t, failure);
    expect(text).toContain('321');
    expect(text).not.toContain('{max}');
  });

  it('keeps plain reasons working without parameters', () => {
    const failure: ActionFailure = {
      ok: false,
      code: 'validation',
      reason: 'not_a_pdf',
      fields: [],
    };
    expect(failureText(t, failure)).toBe(messages.actionErrors.reason.not_a_pdf);
  });
});

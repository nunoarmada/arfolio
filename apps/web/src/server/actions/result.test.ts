import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@arfolio/services';
import { ForbiddenError as SessionForbiddenError, StaleSessionError } from '../session';
import { run, validationReason } from './result';

describe('run', () => {
  it('wraps a value', async () => {
    expect(await run(async () => 42)).toEqual({ ok: true, data: 42 });
  });

  it('turns NotFound into the 404 page (a Next control-flow error)', async () => {
    const error = await run(async () => {
      throw new NotFoundError('Transaction');
    }).catch((e: unknown) => e);
    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('reports Forbidden from the services and from the session guard as 403', async () => {
    expect(
      await run(async () => {
        throw new ForbiddenError();
      }),
    ).toEqual({ ok: false, code: 'forbidden' });
    expect(
      await run(async () => {
        throw new SessionForbiddenError();
      }),
    ).toEqual({ ok: false, code: 'forbidden' });
  });

  it('asks for a new sign-in when the session is stale', async () => {
    expect(
      await run(async () => {
        throw new StaleSessionError();
      }),
    ).toEqual({ ok: false, code: 'reauth' });
  });

  it('maps Validation to a reason code and the offending fields, never English text', async () => {
    const result = await run(async () => {
      throw new ValidationError('Invalid input (name: Too small)', [
        { path: ['name'], message: 'Too small' },
        { path: ['name'], message: 'Too short' },
        { path: ['openingBalance'], message: 'Expected integer' },
      ]);
    });
    expect(result).toEqual({
      ok: false,
      code: 'validation',
      reason: 'invalid_input',
      fields: ['name', 'openingBalance'],
    });
    const layout = await run(async () => {
      throw new ValidationError('Could not recognise the file layout: choose which columns');
    });
    expect(layout).toMatchObject({ code: 'validation', reason: 'unrecognised_layout', fields: [] });
  });

  it('passes on the services code and parameters of a coded validation failure', async () => {
    const result = await run(async () => {
      throw new ValidationError('Too many rows in Despesas (maximum 500)', [], 'too_many_rows', {
        section: 'Despesas',
        max: 500,
      });
    });
    expect(result).toEqual({
      ok: false,
      code: 'validation',
      reason: 'too_many_rows',
      fields: [],
      detail: { code: 'too_many_rows', params: { section: 'Despesas', max: 500 } },
    });
    const bare = await run(async () => {
      throw new ValidationError('A budget already exists', [], 'budget_exists');
    });
    expect(bare).toMatchObject({ detail: { code: 'budget_exists' } });
    expect((bare as { detail: object }).detail).not.toHaveProperty('params');
  });

  it('reports a conflict by its code', async () => {
    expect(
      await run(async () => {
        throw new ConflictError('category_already_linked', 'linked elsewhere');
      }),
    ).toEqual({ ok: false, code: 'conflict', conflict: 'category_already_linked' });
  });

  it('lets redirects and other control-flow errors through', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;/sign-in',
    });
    await expect(
      run(async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
  });

  it('logs and reports anything else as a generic error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await run(async () => {
        throw new Error('boom');
      }),
    ).toEqual({ ok: false, code: 'error' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('validationReason', () => {
  it.each([
    ['The file is too large (maximum 10 MB)', 'file_too_large'],
    ['Unsupported file type: use CSV, OFX or XLSX', 'unsupported_type'],
    ['The file has no rows to import', 'no_rows'],
    ['The statement is in USD but the account is in EUR', 'currency_mismatch'],
    ['Account is archived', 'account_archived'],
    ['This import was already undone', 'already_undone'],
    ['Column "Date" was not found in the file header', 'column_missing'],
    ['The file is not a valid XLSX workbook', 'invalid_file'],
    ['Template categories cannot be deleted, archive them instead', 'template_protected'],
    ['The file has too many rows (maximum 50000 rows)', 'too_many_rows'],
    ['Something unforeseen', 'invalid_input'],
  ])('%s -> %s', (message, reason) => {
    expect(validationReason(message)).toBe(reason);
  });
});

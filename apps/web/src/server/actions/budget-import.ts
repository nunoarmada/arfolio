'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  commitBudgetImport,
  MAX_IMPORT_BYTES,
  NotFoundError,
  previewBudgetImport,
  ValidationError,
  type BudgetImportChoices,
  type BudgetImportPreview,
  type BudgetImportResult,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionResult } from './result';

/** The upload as the services want it; a file that is too big or empty never reaches them. */
async function readUpload(form: FormData): Promise<{ fileName: string; bytes: Uint8Array }> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new ValidationError('The file is empty', [], 'unreadable_file');
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ValidationError('The file is larger than 10 MB', [], 'unreadable_file');
  }
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Reads the workbook and returns what importing it would do. Nothing is written. */
export async function previewBudgetImportAction(
  form: FormData,
): Promise<ActionResult<BudgetImportPreview>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    return previewBudgetImport(ctx, await readUpload(form));
  });
}

/** Imports what the preview showed, in one transaction (or not at all). */
export async function commitBudgetImportAction(
  token: string,
  choices: BudgetImportChoices,
): Promise<ActionResult<BudgetImportResult>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    try {
      const result = await commitBudgetImport(ctx, token, choices);
      revalidatePath('/', 'layout');
      return result;
    } catch (error) {
      if (error instanceof NotFoundError) {
        // A preview that was purged is "expired" for the person, not a page that does not exist.
        if (error.message === 'Preview token not found') {
          throw new ValidationError('This preview has expired', [], 'preview_expired');
        }
        // Anything else missing is something the commit was told to link to.
        throw new ValidationError('A linked record no longer exists', [
          { path: ['accountLinks'], message: error.message },
        ]);
      }
      throw error;
    }
  });
}

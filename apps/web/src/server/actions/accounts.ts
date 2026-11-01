'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  updateAccount,
  type CreateAccountInput,
  type UpdateAccountPatch,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { toAccountDto, type AccountDto } from '../serialize';
import { run, type ActionResult } from './result';

export async function createAccountAction(
  input: CreateAccountInput,
): Promise<ActionResult<AccountDto>> {
  return run(async () => {
    const account = await createAccount(await getServiceCtx(await headers()), input);
    revalidatePath('/', 'layout');
    return toAccountDto(account);
  });
}

export async function updateAccountAction(
  id: string,
  patch: UpdateAccountPatch,
): Promise<ActionResult<AccountDto>> {
  return run(async () => {
    const account = await updateAccount(await getServiceCtx(await headers()), id, patch);
    revalidatePath('/', 'layout');
    return toAccountDto(account);
  });
}

export async function archiveAccountAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await archiveAccount(await getServiceCtx(await headers()), id);
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function deleteAccountAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteAccount(await getServiceCtx(await headers()), id);
    revalidatePath('/', 'layout');
    return null;
  });
}

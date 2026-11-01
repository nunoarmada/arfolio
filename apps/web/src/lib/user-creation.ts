import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Account creation is closed to the public: the only ways in are the first-owner setup flow and
 * accepting an invitation. Those flows run their createUser call inside `withUserCreation`, and
 * the Better Auth before-create hook refuses any user creation that is not inside a scope (or
 * that is for another email than the invited one).
 */
export type UserCreationScope = { kind: 'setup' } | { kind: 'invitation'; email: string };

const storage = new AsyncLocalStorage<UserCreationScope>();

export function withUserCreation<T>(scope: UserCreationScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

export function currentUserCreationScope(): UserCreationScope | undefined {
  return storage.getStore();
}

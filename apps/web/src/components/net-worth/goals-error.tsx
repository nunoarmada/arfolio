'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { ErrorState } from '../error-state';

/** Objetivos could not be loaded: what failed, and a retry that asks the server again. */
export function GoalsLoadError() {
  const router = useRouter();
  const [, start] = useTransition();
  return <ErrorState onRetry={() => start(() => router.refresh())} />;
}

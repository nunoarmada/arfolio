import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { HouseholdFormatProvider } from '@/components/household-format';
import { PrivacyProvider } from '@/components/privacy';
import { readPrivacy } from '@/lib/privacy-cookie';
import { loadHouseholdFormat } from '@/server/household-format';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';

/**
 * A full-screen flow: no tab bar or sidebar. Only members and owners may import (a viewer gets
 * a 404, the services refuse writes on their own as well).
 */
export default async function ImportLayout({ children }: { children: ReactNode }) {
  const session = await requireMember(await headers(), { roles: ['owner', 'member'] });
  const [format, hidden] = await Promise.all([
    loadHouseholdFormat(toServiceCtx(session)),
    readPrivacy(),
  ]);
  return (
    <HouseholdFormatProvider value={format}>
      <PrivacyProvider initialHidden={hidden}>
        <main
          id="main"
          tabIndex={-1}
          className="min-h-dvh w-full min-w-0 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4 outline-none md:px-6 md:py-8 xl:px-8 2xl:px-10"
        >
          {children}
        </main>
      </PrivacyProvider>
    </HouseholdFormatProvider>
  );
}

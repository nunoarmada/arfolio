import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { ac, roles } from './access';
import { oauthSearch } from './oauth-continue';

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        // An OAuth authorization in progress (signed query) continues after the second factor.
        window.location.href = `/two-factor${oauthSearch(window.location.search)}`;
      },
    }),
    organizationClient({ ac, roles }),
    // Adds the page's signed OAuth query to POSTs, so sign-in and 2FA continue an authorization.
    oauthProviderClient(),
  ],
});

import {
  DEFAULT_VALUATION_PORTALS,
  type IntegrationConfig,
  type Resolved,
} from '@arfolio/services';

const resolved = <T>(value: T | undefined, source: Resolved<T>['source'] = 'db'): Resolved<T> => ({
  value,
  source: value === undefined ? 'unset' : source,
  unreadable: false,
  invalid: false,
});

/** An integration config for tests: nothing configured except the defaults. */
export function makeConfig(
  over: {
    anthropicApiKey?: string;
    unreadableKey?: boolean;
    categorisationModel?: string;
    reportModel?: string;
    valuationModel?: string;
    portals?: IntegrationConfig['valuationPortals']['value'];
    enableBanking?: { appId?: string; privateKey?: string; apiUrl?: string };
  } = {},
): IntegrationConfig {
  const key = resolved(over.anthropicApiKey);
  if (over.unreadableKey) key.unreadable = true;
  return {
    anthropicApiKey: key,
    models: {
      categorisation: resolved(over.categorisationModel ?? 'cat-model', 'default'),
      report: resolved(over.reportModel ?? 'report-model', 'default'),
      valuation: resolved(over.valuationModel ?? 'valuation-model', 'default'),
    },
    valuationPortals: resolved(over.portals ?? DEFAULT_VALUATION_PORTALS, 'default'),
    enableBanking: {
      appId: resolved(over.enableBanking?.appId),
      privateKey: resolved(over.enableBanking?.privateKey),
      apiUrl: resolved(over.enableBanking?.apiUrl ?? 'https://api.enablebanking.com', 'default'),
    },
    smtpUrl: resolved<string>(undefined),
    mailFrom: resolved<string>(undefined),
  };
}

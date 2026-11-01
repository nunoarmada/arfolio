export const QUEUES = {
  heartbeat: 'heartbeat',
  syncScheduler: 'sync-scheduler',
  syncConnection: 'sync-connection',
  consentCheck: 'consent-check',
  pruneSyncData: 'prune-sync-data',
  aiCategorise: 'ai-categorise',
  aiSweep: 'ai-categorise-sweep',
  aiCheck: 'ai-categorise-check',
  merchantEnrich: 'merchant-enrich',
  merchantSweep: 'merchant-enrich-sweep',
  aiReport: 'ai-report',
  assetValuation: 'asset-valuation',
  recurringScheduler: 'recurring-detect-scheduler',
  recurringDetect: 'recurring-detect',
  budgetAlertsScheduler: 'budget-alerts-scheduler',
  budgetAlerts: 'budget-alerts',
  netWorthSnapshotScheduler: 'net-worth-snapshot-scheduler',
  netWorthSnapshot: 'net-worth-snapshot',
  pushDeliver: 'push-deliver',
  t212Export: 't212-export',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * `short` allows one queued job per `singletonKey`: the scheduler keys sync jobs by connection,
 * so a slow queue never piles up duplicates of the same connection.
 */
export const SYNC_QUEUE_OPTIONS = { policy: 'short' } as const;

/** One queued step per connection (`singletonKey`); the running step may queue the next one. */
export const T212_EXPORT_QUEUE_OPTIONS = { policy: 'short' } as const;

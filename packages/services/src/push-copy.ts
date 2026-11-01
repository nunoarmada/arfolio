import { resolveAppLocale, type AppLocale } from '@arfolio/core';
import { notificationPath, type NotificationKind } from './notification-links.js';

export type PushKind = NotificationKind;
export type PushCopy = { title: string; body: string };

/**
 * Lock-screen text. It is deliberately generic: no amounts, no merchant, category, account, line
 * or connection names (all user-defined and financial), only what kind of thing happened. The
 * tone is formal (usted, vous, Lei) or impersonal.
 */
const COPY: Record<PushKind, Record<AppLocale, PushCopy>> = {
  consent_expiring: {
    'pt-PT': {
      title: 'Acesso bancário a expirar',
      body: 'Renove o acesso para manter os movimentos atualizados.',
    },
    'es-ES': {
      title: 'Acceso bancario a punto de caducar',
      body: 'Renueve el acceso para mantener los movimientos al día.',
    },
    'fr-FR': {
      title: 'Accès bancaire bientôt expiré',
      body: 'Renouvelez l’accès pour garder vos opérations à jour.',
    },
    'it-IT': {
      title: 'Accesso bancario in scadenza',
      body: 'Rinnovi l’accesso per mantenere aggiornati i movimenti.',
    },
    en: { title: 'Bank access expiring', body: 'Renew access to keep your movements up to date.' },
  },
  consent_expired: {
    'pt-PT': { title: 'Acesso bancário expirado', body: 'Os movimentos deixaram de atualizar.' },
    'es-ES': {
      title: 'Acceso bancario caducado',
      body: 'Los movimientos han dejado de actualizarse.',
    },
    'fr-FR': { title: 'Accès bancaire expiré', body: 'Vos opérations ne sont plus mises à jour.' },
    'it-IT': { title: 'Accesso bancario scaduto', body: 'I movimenti non vengono più aggiornati.' },
    en: { title: 'Bank access expired', body: 'Your movements are no longer updating.' },
  },
  sync_failing: {
    'pt-PT': { title: 'Falha na sincronização', body: 'Uma ligação não está a sincronizar.' },
    'es-ES': { title: 'Fallo de sincronización', body: 'Una conexión no se está sincronizando.' },
    'fr-FR': { title: 'Échec de la synchronisation', body: 'Une connexion ne se synchronise pas.' },
    'it-IT': {
      title: 'Sincronizzazione non riuscita',
      body: 'Una connessione non si sta sincronizzando.',
    },
    en: { title: 'Sync failing', body: 'A connection is not syncing.' },
  },
  recurring_missed: {
    'pt-PT': {
      title: 'Pagamento recorrente em falta',
      body: 'Um pagamento esperado não apareceu.',
    },
    'es-ES': { title: 'Pago recurrente pendiente', body: 'Un pago esperado no ha aparecido.' },
    'fr-FR': {
      title: 'Paiement récurrent manquant',
      body: 'Un paiement attendu n’est pas apparu.',
    },
    'it-IT': {
      title: 'Pagamento ricorrente mancante',
      body: 'Un pagamento previsto non è comparso.',
    },
    en: { title: 'Recurring payment missing', body: 'An expected payment did not show up.' },
  },
  recurring_price_change: {
    'pt-PT': {
      title: 'Pagamento recorrente alterado',
      body: 'Um pagamento recorrente mudou de valor.',
    },
    'es-ES': {
      title: 'Pago recurrente modificado',
      body: 'Un pago recurrente ha cambiado de importe.',
    },
    'fr-FR': {
      title: 'Paiement récurrent modifié',
      body: 'Un paiement récurrent a changé de montant.',
    },
    'it-IT': {
      title: 'Pagamento ricorrente modificato',
      body: 'Un pagamento ricorrente ha cambiato importo.',
    },
    en: { title: 'Recurring payment changed', body: 'A recurring payment changed price.' },
  },
  budget_line_threshold: {
    'pt-PT': { title: 'Alerta de orçamento', body: 'Uma rubrica do orçamento chegou ao limite.' },
    'es-ES': {
      title: 'Alerta de presupuesto',
      body: 'Una partida del presupuesto ha llegado al límite.',
    },
    'fr-FR': { title: 'Alerte budget', body: 'Une ligne du budget a atteint sa limite.' },
    'it-IT': { title: 'Avviso di budget', body: 'Una voce del budget ha raggiunto il limite.' },
    en: { title: 'Budget alert', body: 'A budget line has reached its limit.' },
  },
  budget_unallocated_negative: {
    'pt-PT': {
      title: 'Plano de transferências',
      body: 'O plano do mês não bate certo. Reveja-o.',
    },
    'es-ES': { title: 'Plan de transferencias', body: 'El plan del mes no cuadra. Revíselo.' },
    'fr-FR': {
      title: 'Plan de virements',
      body: 'Le plan du mois ne tombe pas juste. Veuillez le vérifier.',
    },
    'it-IT': {
      title: 'Piano dei trasferimenti',
      body: 'Il piano del mese non quadra. Lo controlli.',
    },
    en: { title: 'Transfer plan', body: 'This month’s plan does not add up. Take a look.' },
  },
  ai_report_ready: {
    'pt-PT': {
      title: 'Relatório mensal pronto',
      body: 'O seu relatório do mês já está disponível.',
    },
    'es-ES': { title: 'Informe mensual listo', body: 'Su informe del mes ya está disponible.' },
    'fr-FR': { title: 'Rapport mensuel prêt', body: 'Votre rapport du mois est disponible.' },
    'it-IT': { title: 'Report mensile pronto', body: 'Il suo report del mese è disponibile.' },
    en: { title: 'Monthly report ready', body: 'Your report for the month is ready.' },
  },
  push_test: {
    'pt-PT': {
      title: 'Notificações ativas',
      body: 'Este dispositivo vai receber os seus alertas.',
    },
    'es-ES': { title: 'Notificaciones activas', body: 'Este dispositivo recibirá sus alertas.' },
    'fr-FR': { title: 'Notifications activées', body: 'Cet appareil recevra vos alertes.' },
    'it-IT': { title: 'Notifiche attive', body: 'Questo dispositivo riceverà i suoi avvisi.' },
    en: { title: 'Notifications are on', body: 'This device will receive your alerts.' },
  },
};

/** The copy in the locale's language (any `pt*` is pt-PT, `fr-CA` is fr-FR…), English otherwise. */
export function pushCopy(kind: PushKind, locale: string): PushCopy {
  return COPY[kind][resolveAppLocale(locale)];
}

// --- target url --------------------------------------------------------------------------------

/** What a push url needs to know about the current state of its target. */
export type PushLinkLookups = {
  budgets: ReadonlyMap<string, { startMonth: string }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A payload id is jsonb written by us, but never trusted to build a url: uuids only. */
export const payloadId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A payload month (`yyyy-mm`) is jsonb written by us, but never trusted to build a url. */
export const payloadMonth = (value: unknown): string | null =>
  typeof value === 'string' && MONTH.test(value) ? value : null;

/**
 * The page a push opens: `notificationPath`, the same function the in-app list uses, fed with
 * uuid-validated payload ids. Existence of a line, item or connection is not checked (a stale hash
 * is harmless); the budget is looked up because its start month is needed.
 */
export function pushUrl(
  kind: PushKind,
  payload: Record<string, unknown>,
  lookups: PushLinkLookups,
): string {
  const budgetId = payloadId(payload.budgetId);
  return notificationPath(kind, {
    budgetStart: (budgetId ? lookups.budgets.get(budgetId) : undefined)?.startMonth ?? null,
    monthIndex: payload.monthIndex,
    lineId: payloadId(payload.lineId),
    recurringId: payloadId(payload.recurringId),
    connectionId: payloadId(payload.connectionId),
    reportMonth: payloadMonth(payload.month),
  });
}

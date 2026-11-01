import { createTranslator } from 'next-intl';
import nodemailer from 'nodemailer';
import { smtpTransportOptions } from '@arfolio/services';
import en from '../../messages/en.json';
import es from '../../messages/es-ES.json';
import fr from '../../messages/fr-FR.json';
import it from '../../messages/it-IT.json';
import pt from '../../messages/pt-PT.json';
import { isLocale, FALLBACK_LOCALE, type Locale } from '../i18n/locales';
import type { Role } from '../lib/access';
import { getEnv } from '../lib/env';
import { getIntegrationConfig } from './integration-config';

/** The slice of a nodemailer transport the app uses (so tests can pass a fake). */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface InvitationMail {
  to: string;
  /** Absolute registration link, token included. */
  link: string;
  role: Role;
  householdName: string;
  inviterName: string;
  locale: string;
}

const MESSAGES: Record<Locale, typeof en> = {
  'pt-PT': pt,
  'es-ES': es,
  'fr-FR': fr,
  'it-IT': it,
  en,
};

/** Builds the localized invitation email (subject and plain-text body). */
export function renderInvitationMail(
  mail: InvitationMail,
  brandName: string,
): { subject: string; text: string } {
  const locale = isLocale(mail.locale) ? mail.locale : FALLBACK_LOCALE;
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'mail' });
  const roles = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'roles' });
  const vars = {
    brand: brandName,
    household: mail.householdName,
    inviter: mail.inviterName,
    role: roles(mail.role).toLowerCase(),
    link: mail.link,
  };
  return { subject: t('invitationSubject', vars), text: t('invitationBody', vars) };
}

/** Returns a sender for invitation emails, or null when SMTP is not configured. */
export function createInvitationMailer(opts: {
  transport: MailTransport;
  from: string;
  brandName: string;
}): (mail: InvitationMail) => Promise<void> {
  return async (mail) => {
    const { subject, text } = renderInvitationMail(mail, opts.brandName);
    await opts.transport.sendMail({ from: opts.from, to: mail.to, subject, text });
  };
}

/** The app's mailer from the resolved SMTP URL and sender; null (no email is sent) when no SMTP URL is set. */
export async function getInvitationMailer(): Promise<
  ((mail: InvitationMail) => Promise<void>) | null
> {
  const cfg = await getIntegrationConfig();
  const smtpUrl = cfg.smtpUrl.value;
  if (smtpUrl === undefined) return null;
  const { BRAND_NAME: brandName } = getEnv();
  return createInvitationMailer({
    transport: nodemailer.createTransport(smtpTransportOptions(smtpUrl)),
    from: cfg.mailFrom.value ?? `${brandName} <no-reply@localhost>`,
    brandName,
  });
}

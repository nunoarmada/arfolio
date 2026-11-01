import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationConfigFixture } from '../test-utils';
import {
  createInvitationMailer,
  getInvitationMailer,
  renderInvitationMail,
  type MailTransport,
} from './mail';

const getIntegrationConfig = vi.hoisted(() => vi.fn());
vi.mock('./integration-config', () => ({ getIntegrationConfig }));

const mail = {
  to: 'sam@example.com',
  link: 'https://pfm.example/invite/abc?t=secret',
  role: 'member' as const,
  householdName: 'Example Home',
  inviterName: 'Alex',
  locale: 'pt-PT',
};

describe('invitation email', () => {
  it('renders pt-PT with household, brand, role and the link', () => {
    const { subject, text } = renderInvitationMail(mail, 'Finanças');
    expect(subject).toContain('Example Home');
    expect(text).toContain('Alex');
    expect(text).toContain('membro');
    expect(text).toContain('Finanças');
    expect(text).toContain(mail.link);
  });

  it('renders English for an en household and falls back to English for unknown locales', () => {
    expect(renderInvitationMail({ ...mail, locale: 'en' }, 'Arfolio').text).toContain(
      'invited you',
    );
    expect(renderInvitationMail({ ...mail, locale: 'fr' }, 'Arfolio').text).toContain(
      'invited you',
    );
  });

  it('sends through the transport with the configured sender', async () => {
    const sent: unknown[] = [];
    const transport: MailTransport = { sendMail: async (m) => void sent.push(m) };
    await createInvitationMailer({ transport, from: 'Arfolio <a@b.c>', brandName: 'Arfolio' })(
      mail,
    );
    expect(sent).toEqual([
      expect.objectContaining({ from: 'Arfolio <a@b.c>', to: 'sam@example.com' }),
    ]);
  });
});

describe('getInvitationMailer', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://x');
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
    vi.stubEnv('BETTER_AUTH_URL', 'https://pfm.example.test');
    vi.stubEnv('APP_URL', 'https://pfm.example.test');
    vi.stubEnv('SETUP_TOKEN', 'y'.repeat(24));
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    getIntegrationConfig.mockReset();
  });

  it('returns a mailer once an SMTP URL is stored, and null after it is removed', async () => {
    getIntegrationConfig.mockResolvedValue(integrationConfigFixture());
    expect(await getInvitationMailer()).toBeNull();
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ smtpUrl: 'smtp://127.0.0.1:2525' }),
    );
    expect(typeof (await getInvitationMailer())).toBe('function');
    getIntegrationConfig.mockResolvedValue(integrationConfigFixture());
    expect(await getInvitationMailer()).toBeNull();
  });
});

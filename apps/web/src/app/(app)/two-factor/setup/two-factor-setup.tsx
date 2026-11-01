'use client';

import { Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CopyButton } from '@/components/copy-button';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, PasswordInput } from '@/components/ui/field';
import { OtpInput } from '@/components/ui/otp-input';
import { authClient } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';

const TOTAL_STEPS = 3;

/** "Casa Exemplo" becomes "casa-exemplo", for file names. */
function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

/** `JBSWY3DP…` becomes `JBSW Y3DP …` so it can be typed from a phone screen. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export function TwoFactorSetup({ isOwner, brandName }: { isOwner: boolean; brandName: string }) {
  const t = useTranslations('twoFactorSetup');
  const errors = useTranslations('errors');
  const common = useTranslations('common');
  const router = useRouter();
  const hydrated = useHydrated();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [password, setPassword] = useState('');
  const [qr, setQr] = useState<{ dataUrl: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Move focus to the step heading when the step changes, so screen readers announce it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  // Leaving step 3 before the codes are saved would lose them for good: ask first.
  useEffect(() => {
    if (step !== 3 || saved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [step, saved]);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      const { data, error } = await authClient.twoFactor.enable({ password, method: 'totp' });
      if (error || data?.method !== 'totp') {
        setProblem(
          error?.code === 'INVALID_PASSWORD'
            ? t('wrongPassword')
            : error?.status
              ? t('generateError')
              : errors('network'),
        );
        return;
      }
      const secret = new URL(data.totpURI).searchParams.get('secret') ?? '';
      // A white tile with a quiet zone, also in dark mode, so scanners read it reliably.
      const dataUrl = await QRCode.toDataURL(data.totpURI, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      setQr({ dataUrl, secret });
      setCodes(data.backupCodes);
      setPassword('');
    } catch {
      setProblem(errors('network'));
    } finally {
      setPending(false);
    }
  }

  async function confirm(value: string) {
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code: value });
      if (error) {
        setProblem(error.status ? t('invalidCode') : errors('network'));
        setCode('');
        return;
      }
      setStep(3);
    } catch {
      setProblem(errors('network'));
    } finally {
      setPending(false);
    }
  }

  function download() {
    const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(brandName)}-recovery-codes.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const titles = { 1: t('step1Title'), 2: t('step2Title'), 3: t('step3Title') } as const;

  return (
    <div className="mt-2 grid grid-cols-1 gap-5">
      {isOwner ? <p className="text-base text-muted-foreground">{t('ownersNote')}</p> : null}
      <p className="text-sm font-medium text-muted-foreground" aria-live="polite">
        {isOwner
          ? `${t('outerStep')} · ${t('part', { step, total: TOTAL_STEPS })}`
          : t('step', { step, total: TOTAL_STEPS })}
      </p>
      <h2 ref={heading} tabIndex={-1} className="text-heading outline-none">
        {titles[step]}
      </h2>
      {problem ? <Alert tone="error">{problem}</Alert> : null}

      {step === 1 ? (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-base text-muted-foreground">{t('step1Intro')}</p>
          {qr ? (
            <>
              <div className="grid grid-cols-1 justify-items-start gap-3">
                <img
                  src={qr.dataUrl}
                  alt={t('qrAlt')}
                  width={200}
                  height={200}
                  className="rounded-lg bg-white shadow-[0_0_0_1px_var(--border-strong)]"
                />
                <p className="text-sm text-muted-foreground">{t('secretLabel')}</p>
                <p
                  data-testid="totp-secret"
                  className="break-all rounded-md bg-surface-2 px-3 py-2 slashed-zero text-base font-medium tabular-nums"
                >
                  {groupSecret(qr.secret)}
                </p>
                <CopyButton text={qr.secret} label={t('copySecret')} />
              </div>
              <Button size="lg" onClick={() => setStep(2)}>
                {common('continue')}
              </Button>
            </>
          ) : (
            <form method="post" onSubmit={generate} className="grid grid-cols-1 gap-4">
              <Field label={t('password')}>
                {(p) => (
                  <PasswordInput
                    {...p}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    readOnly={pending}
                    showLabel={t('showPassword')}
                    hideLabel={t('hidePassword')}
                  />
                )}
              </Field>
              <Button type="submit" size="lg" loading={pending} disabled={!hydrated}>
                {pending ? t('generating') : t('generate')}
              </Button>
            </form>
          )}
        </div>
      ) : null}

      {step === 2 ? (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-base text-muted-foreground">{t('step2Intro')}</p>
          <OtpInput
            value={code}
            onChange={setCode}
            onComplete={(v) => void confirm(v)}
            invalid={problem === t('invalidCode')}
            disabled={pending}
            label={t('codeLabel')}
            autoFocus
          />
          <Button
            size="lg"
            loading={pending}
            onClick={() => void confirm(code)}
            disabled={code.length < 6}
          >
            {pending ? t('confirming') : t('confirm')}
          </Button>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-base text-muted-foreground">{t('step3Intro')}</p>
          <ul
            aria-label={t('step3Title')}
            className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-surface-2 p-4 slashed-zero text-base font-medium tabular-nums"
          >
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={codes.join('\n')} label={t('copyCodes')} />
            <Button variant="outline" onClick={download}>
              <Download className="size-4" aria-hidden="true" />
              {t('downloadCodes')}
            </Button>
          </div>
          <label className="flex min-h-11 items-center gap-3 text-base">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="size-5 accent-[var(--primary)]"
            />
            {t('saved')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              disabled={!saved}
              onClick={() => {
                router.replace('/');
                router.refresh();
              }}
            >
              {t('finish')}
            </Button>
            {isOwner ? (
              <Button
                size="lg"
                variant="outline"
                disabled={!saved}
                onClick={() => {
                  router.replace('/settings/services');
                  router.refresh();
                }}
              >
                {t('configureServices')}
              </Button>
            ) : null}
          </div>
          {isOwner ? (
            <p className="text-sm text-muted-foreground">{t('configureServicesHint')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

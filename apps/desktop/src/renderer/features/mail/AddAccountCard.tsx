import { ChevronDown, Mail } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { isMailError, type MailDiscovery, type MailErrorCode, type MailProvider, type MailSecurity, type MailServerSettings } from '../../../shared/mail';
import { Button, Field, Input, PasswordInput, Select, cx } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { ALL_INBOXES, mailApi, selectBox, useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { APP_PASSWORD_URL, mailErrorText, providerOf } from './format';
import { isEmail } from './mailLink';
import { resolveLogin } from './compose';

type Phase = 'idle' | 'discover' | 'login';

interface Manual {
  imap: MailServerSettings;
  smtp: MailServerSettings;
  login: string;
}


const manualFrom = (d: MailDiscovery, email: string): Manual => ({ imap: { ...d.imap }, smtp: { ...d.smtp }, login: resolveLogin(d.loginTemplate, email) });

const PROVIDER_LINKS: Array<[MailProvider, () => string]> = [
  ['gmail', () => 'Gmail'],
  ['yandex', () => t('mbox.provider.yandex')],
  ['mailru', () => 'Mail.ru'],
  ['icloud', () => 'iCloud'],
];

/**
 * «Добавьте почту» (ADR-0088 §4, §8): the address and the password, «Добавить». The engine finds
 * the servers (progress «Ищем настройки…»), then logs in; nothing found — the manual form, filled
 * with its best guesses. A deep link (§12) pre-fills the form and focuses «Добавить»: nothing is
 * submitted by itself. The password lives in this form only until the call (§10).
 */
export function AddAccountCard({ first }: { first: boolean }): ReactNode {
  const prefill = useMailUi((s) => s.prefill);
  const [email, setEmail] = useState(prefill?.email ?? '');
  const [password, setPassword] = useState(prefill?.password ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ code: MailErrorCode | 'EMAIL' | 'ALREADY'; help: string | null } | null>(null);
  const [manual, setManual] = useState<Manual | null>(null);
  const [showManual, setShowManual] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const already = useMail((s) => {
    const e = email.trim().toLowerCase();
    return !!e && s.accountIds.some((id) => s.accounts[id]?.email === e);
  });

  // A new deep link while the form is open replaces its values (never submits).
  const [seenSeq, setSeenSeq] = useState(prefill?.seq ?? 0);
  if (prefill && prefill.seq !== seenSeq) {
    setSeenSeq(prefill.seq);
    setEmail(prefill.email);
    setPassword(prefill.password);
    setManual(null);
    setShowManual(false);
    setError(null);
  }
  useEffect(() => {
    if (prefill?.password) submitRef.current?.focus();
    else if (prefill?.email) passwordRef.current?.focus();
    else emailRef.current?.focus();
  }, [prefill]);

  const busy = phase !== 'idle';
  const domain = email.slice(email.lastIndexOf('@') + 1);

  const fail = (code: MailErrorCode, d?: MailDiscovery | null): void => {
    const provider = d?.provider ?? providerOf(email);
    const help = code === 'AUTH_FAILED' ? (d?.appPasswordUrl ?? APP_PASSWORD_URL[provider] ?? null) : null;
    setError({ code, help });
    setPhase('idle');
  };

  const submit = async (e?: SyntheticEvent): Promise<void> => {
    e?.preventDefault();
    const api = mailApi();
    const address = email.trim().toLowerCase();
    if (!api || busy) return;
    if (!isEmail(address)) {
      setError({ code: 'EMAIL', help: null });
      emailRef.current?.focus();
      return;
    }
    if (already) {
      setError({ code: 'ALREADY', help: null });
      return;
    }
    setError(null);
    let settings = showManual ? manual : null;
    let discovered: MailDiscovery | null = null;
    if (!settings) {
      setPhase('discover');
      try {
        discovered = await api.accounts.discover(address);
        settings = manualFrom(discovered, address);
      } catch (err) {
        const code = isMailError(err) ? err.code : 'ENGINE_DOWN';
        if (code === 'DISCOVERY_FAILED' && isMailError(err) && err.discovery) {
          setManual(manualFrom(err.discovery, address));
          setShowManual(true);
        }
        fail(code, isMailError(err) ? err.discovery : null);
        return;
      }
    }
    setPhase('login');
    try {
      // Discovered settings are found again by the engine (it keeps the provider and the app-password
      // page with them); only the manual form's values are passed as they are.
      const account = await api.accounts.add(showManual ? { email: address, password, settings } : { email: address, password });
      setPassword('');
      toast.success(t('mbox.add.added', { email: account.email }));
      useMailUi.getState().closeAdd();
      selectBox(ALL_INBOXES);
    } catch (err) {
      const code = isMailError(err) ? err.code : 'ENGINE_DOWN';
      if (code === 'DISCOVERY_FAILED' && isMailError(err) && err.discovery) {
        setManual(manualFrom(err.discovery, address));
        setShowManual(true);
      } else if ((code === 'NETWORK' || code === 'TLS') && !showManual) {
        // Found servers that do not answer: the manual form, filled with what was found.
        setManual(settings);
      }
      // AUTH_FAILED carries the settings that were tried: their provider names the app-password page.
      fail(code, (isMailError(err) ? err.discovery : undefined) ?? discovered);
    }
  };

  const errorText =
    error?.code === 'EMAIL' ? t('mbox.add.invalidEmail') : error?.code === 'ALREADY' || already ? t('mbox.add.already') : error ? mailErrorText(error.code) : null;

  return (
    <div className="m-auto flex w-full max-w-[460px] flex-col gap-5 px-6 py-10" data-testid="mail-add-account-card">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-hover text-muted">
          <Mail className="size-7" strokeWidth={1.5} aria-hidden />
        </span>
        <h1 className="text-title font-semibold text-fg">{first ? t('mbox.add.title') : t('mbox.addAccount')}</h1>
        <p className="text-body text-muted">{t('mbox.add.text')}</p>
      </div>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
        <Field label={t('mbox.add.email')}>
          <Input
            ref={emailRef}
            type="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            disabled={busy}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="name@example.com"
            data-testid="mail-add-email"
          />
        </Field>
        <Field label={t('mbox.add.password')}>
          <PasswordInput
            ref={passwordRef}
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            data-testid="mail-add-password"
          />
        </Field>
        {manual ? (
          <button type="button" className="flex items-center gap-1 self-start text-caption text-muted hover:text-fg" onClick={() => setShowManual((v) => !v)} aria-expanded={showManual}>
            <ChevronDown className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', !showManual && '-rotate-90')} aria-hidden />
            {t('mbox.add.servers')}
          </button>
        ) : null}
        {manual && showManual ? <ManualForm value={manual} onChange={setManual} disabled={busy} /> : null}
        {errorText ? (
          <p className="text-caption text-danger-text" role="alert" data-testid="mail-add-error">
            {errorText}
            {error?.code === 'DISCOVERY_FAILED' ? ` ${t('mbox.add.manualHint')}` : ''}
            {error?.help ? (
              <>
                {`. ${t('mbox.add.needAppPassword')} `}
                <button type="button" className="text-accent-text underline" onClick={() => error.help && void platform.app.openExternal(error.help)}>
                  {t('mbox.add.appPasswordHow')}
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {phase !== 'idle' ? (
          <p className="text-caption text-muted" role="status" data-testid="mail-add-progress">
            {phase === 'discover' ? t('mbox.add.discovering', { domain }) : t('mbox.add.checking')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          {first ? null : (
            <Button variant="secondary" onClick={() => useMailUi.getState().closeAdd()} disabled={busy}>
              {t('common.cancel')}
            </Button>
          )}
          <Button ref={submitRef} type="submit" busy={busy} disabled={already} data-testid="mail-add-submit">
            {t('mbox.add.submit')}
          </Button>
        </div>
      </form>
      <p className="text-center text-caption text-faint">
        {t('mbox.add.appPassword')}{' '}
        {PROVIDER_LINKS.map(([p, label], i) => (
          <span key={p}>
            {i > 0 ? ' · ' : ''}
            <button type="button" className="text-accent-text hover:underline" onClick={() => void platform.app.openExternal(APP_PASSWORD_URL[p] ?? '')}>
              {label()}
            </button>
          </span>
        ))}
      </p>
    </div>
  );
}

/** Servers by hand (§4 step 6): IMAP and SMTP host / port / security, the login. */
function ManualForm({ value, onChange, disabled }: { value: Manual; onChange: (m: Manual) => void; disabled: boolean }): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] p-3" data-testid="mail-add-manual">
      <ServerFields title={t('mbox.add.imap')} value={value.imap} onChange={(imap) => onChange({ ...value, imap })} disabled={disabled} defaults={[993, 143]} />
      <ServerFields title={t('mbox.add.smtp')} value={value.smtp} onChange={(smtp) => onChange({ ...value, smtp })} disabled={disabled} defaults={[465, 587]} />
      <Field label={t('mbox.add.login')}>
        <Input value={value.login} disabled={disabled} spellCheck={false} onChange={(e) => onChange({ ...value, login: e.target.value })} data-testid="mail-add-login" />
      </Field>
    </div>
  );
}

function ServerFields({
  title,
  value,
  onChange,
  disabled,
  defaults,
}: {
  title: string;
  value: MailServerSettings;
  onChange: (v: MailServerSettings) => void;
  disabled: boolean;
  /** Default ports: implicit TLS, STARTTLS — switching the security moves a default port along. */
  defaults: [number, number];
}): ReactNode {
  const id = useId();
  const setSecurity = (security: MailSecurity): void => {
    const port = value.port === defaults[0] || value.port === defaults[1] ? (security === 'tls' ? defaults[0] : defaults[1]) : value.port;
    onChange({ ...value, security, port });
  };
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="pb-1 text-caption font-semibold text-muted">{title}</legend>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1" htmlFor={`${id}-host`}>
          <span className="sr-only">{t('mbox.add.host')}</span>
          <Input id={`${id}-host`} value={value.host} spellCheck={false} placeholder={t('mbox.add.host')} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} />
        </label>
        <label className="w-20 shrink-0" htmlFor={`${id}-port`}>
          <span className="sr-only">{t('mbox.add.port')}</span>
          <Input
            id={`${id}-port`}
            inputMode="numeric"
            value={String(value.port || '')}
            placeholder={t('mbox.add.port')}
            onChange={(e) => onChange({ ...value, port: Math.min(65535, Number(e.target.value.replace(/\D/g, '')) || 0) })}
          />
        </label>
        <label className="w-32 shrink-0" htmlFor={`${id}-sec`}>
          <span className="sr-only">{t('mbox.add.security')}</span>
          <Select id={`${id}-sec`} value={value.security} onChange={(e) => setSecurity(e.target.value as MailSecurity)}>
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
          </Select>
        </label>
      </div>
    </fieldset>
  );
}

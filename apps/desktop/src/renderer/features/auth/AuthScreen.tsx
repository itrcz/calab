import { CorporateLogin } from '../identity/SignIn';
import { useEffect, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { SIMILAR_ACCOUNT_CODE, type ApiErrorJson } from '../../../shared/ipc';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, PasswordInput, cx } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { toast } from '../../stores/toasts';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { beginSession } from '../../services/session';
import { useSession } from '../../stores/session';
import { markSignedUpByInvite, useInvite } from '../../stores/invite';
import { workspaceInitials } from '../../lib/initials';
import { platform } from '../../platform';
import { useRoomLink } from '../people/roomLink';
import { INSECURE_SERVER_CODE } from '../../../shared/serverUrl';
import { GuestScreen } from './GuestScreen';
import { AuthLegalFooter } from '../legal/Legal';
import { ForgotPassword } from './ForgotPassword';
import { logoutBannerKey } from '../../services/logoutNotice';

function authError(e: ApiErrorJson): { text: string; field?: string } {
  switch (e.code) {
    case 'ERROR_CODE_REGISTRATION_CLOSED':
      return { text: t('auth.err.inviteOnly'), field: 'inviteCode' };
    case 'ERROR_CODE_INVITE_INVALID':
      return { text: t('auth.err.inviteInvalid'), field: 'inviteCode' };
    case 'ERROR_CODE_INVITE_EMAIL_MISMATCH':
      return { text: t('mail.inv.emailMismatch'), field: 'email' };
    case 'ERROR_CODE_CONFLICT':
      return { text: t('auth.err.emailTaken'), field: 'email' };
    case 'ERROR_CODE_RATE_LIMITED':
      return { text: t('auth.err.rate') };
    case INSECURE_SERVER_CODE:
      return { text: t('auth.err.insecure'), field: 'serverUrl' };
    case 'ERROR_CODE_UNAVAILABLE':
      return { text: e.status === 0 ? t('auth.err.unreachable') : t('err.unavailable') };
    default: {
      // Everything else through the shared mapping (lib/api/errors.ts): never the raw message.
      const h = describeError(new ApiError(e.code, e.message, e.status, e.field));
      return { text: h.text, ...(h.field ? { field: h.field } : {}) };
    }
  }
}

export function AuthScreen(): ReactNode {
  const roomLink = useRoomLink((s) => (s.preferLogin ? null : s.code));
  // A room link without a session (ADR-0016): the guest screen first.
  if (roomLink) return <GuestScreen code={roomLink} />;
  return <LoginScreen />;
}

function LoginScreen(): ReactNode {
  const pendingRoom = useRoomLink((s) => s.code);
  const settings = useSession((s) => s.settings);
  const banner = logoutBannerKey(useSession((s) => s.loggedOutReason));
  // An invitation link (docs/09 #36) — also one that arrives while this form is on screen.
  const invite = useInvite((s) => s.code) ?? '';
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(invite ? 'register' : 'login');
  const [serverUrl, setServerUrl] = useState(settings?.serverUrl ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState(invite);
  const [linkInvite, setLinkInvite] = useState(invite);
  if (invite && invite !== linkInvite) {
    // A new link: the sign-up form with its code (render-time sync, no effect round trip).
    setLinkInvite(invite);
    setInviteCode(invite);
    setMode('register');
  }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  // A 401 on sign-in: «Забыли пароль?» turns into the way out (docs/09 #119).
  const [loginFailed, setLoginFailed] = useState(false);
  // The server saw the same login at a sibling domain (kv@x.ai vs kv@x.ru): ask before creating.
  const [similar, setSimilar] = useState(false);
  // Web: the API is the page's own origin — nothing to configure.
  const [showCorporate, setShowCorporate] = useState(false);
  const [showServer, setShowServer] = useState(platform.kind === 'electron' && !settings?.serverUrl);
  // The link's workspace (public preview, ADR-0023): a card on top instead of a code field. An
  // invitation sent by email works only with its address: prefilled and locked.
  const [preview, setPreview] = useState<{ code: string; ws: string; email: string } | null>(null);
  const [invitedEmail, setInvitedEmail] = useState('');
  useEffect(() => {
    if (!invite) return;
    let live = true;
    api.invites.get(invite).then(
      (r) => {
        if (!live) return;
        setPreview({ code: invite, ws: r.workspace?.name ?? '', email: r.email });
        if (!r.email) return;
        setInvitedEmail(r.email);
        setEmail(r.email);
      },
      () => undefined, // unknown / expired, or a server that needs a session: the code field shows
    );
    return () => {
      live = false;
    };
  }, [invite]);
  const emailLocked = !!invitedEmail && mode === 'register';
  // The code from the link goes along unseen while it is the one the preview resolved; the field
  // comes back when the server rejects it (so it can be corrected) or the user types another one.
  const codeFromLink = !!preview && !!preview.ws && preview.code === inviteCode && err?.field !== 'inviteCode';

  const serverOk = (): boolean => {
    if (/^https?:\/\/.+/.test(serverUrl.trim())) return true;
    setShowServer(true);
    setErr({ text: t('auth.err.server'), field: 'serverUrl' });
    return false;
  };

  const submit = async (e: { preventDefault(): void }, createAnyway = false): Promise<void> => {
    e.preventDefault();
    setErr(null);
    setLoginFailed(false);
    setSimilar(false);
    if (!serverOk()) return;
    setBusy(true);
    const args = { serverUrl: serverUrl.trim(), email: email.trim(), password };
    const code = inviteCode.trim();
    const res =
      mode === 'login'
        ? await platform.auth.login(args)
        : await platform.auth.register({ ...args, displayName: name.trim(), inviteCode: code, locale: getLocale(), checkSimilar: !createAnyway });
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === SIMILAR_ACCOUNT_CODE) setSimilar(true);
      else if (mode === 'login' && res.error.code === 'ERROR_CODE_INVALID_CREDENTIALS') setLoginFailed(true);
      else setErr(authError(res.error));
      return;
    }
    // The sign-up used the code (joined, or joins once the address is confirmed): no join dialog
    // afterwards and no «Присоединиться» step. A sign-in hands the pending code to the dialog.
    if (mode === 'register' && code) markSignedUpByInvite();
    beginSession(res.data);
  };

  const fieldErr = (f: string): string | null => (err?.field === f ? err.text : null);
  const toForgot = (): void => {
    setErr(null);
    setLoginFailed(false);
    setMode('forgot');
  };
  const desktop = platform.kind === 'electron';

  if (mode === 'forgot') {
    /** Without a session the desktop API proxy needs the server of the form. */
    const prepare = async (): Promise<boolean> => {
      if (!serverOk()) {
        setMode('login');
        return false;
      }
      const url = serverUrl.trim().replace(/\/+$/, '');
      if (desktop && settings?.serverUrl !== url) useSession.getState().set({ settings: await platform.app.setSettings({ serverUrl: url }) });
      return true;
    };
    return (
      <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+24px)] mobile:pt-[calc(var(--safe-top)+16px)]">
        <div className="no-drag my-auto flex w-full max-w-[380px] shrink-0 flex-col items-stretch">
          <div className="mb-6 flex flex-col items-center text-center">
            <Logo size={72} className="mb-3" />
          </div>
          <ForgotPassword
            initialEmail={email}
            prepare={prepare}
            onBack={() => {
              setMode('login');
              setErr(null);
              setLoginFailed(false);
            }}
            onReset={async (em, pw) => {
              // The server revoked every session: sign in with the new password right away.
              setEmail(em);
              setPassword('');
              toast.success(t('mail.forgot.done'));
              const res = await platform.auth.login({ serverUrl: serverUrl.trim(), email: em, password: pw });
              if (res.ok) beginSession(res.data);
              else {
                setMode('login');
                setErr(authError(res.error));
              }
            }}
          />
        </div>
        <AuthLegalFooter className="no-drag mt-6 w-full max-w-[380px] shrink-0 gap-2 mobile:gap-0" />
      </div>
    );
  }

  return (
    <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+24px)] mobile:pt-[calc(var(--safe-top)+16px)]">
      <form onSubmit={(e) => void submit(e)} className="no-drag my-auto flex w-full max-w-[380px] shrink-0 flex-col items-stretch">
        <div className="mb-6 flex flex-col items-center text-center mobile:mb-4">
          <Logo size={72} className="mb-3 mobile:mb-2 mobile:size-14" />
          <h1 className="text-body text-muted">{mode === 'login' ? t('auth.welcomeSub') : t('auth.createSub')}</h1>
        </div>
        <div className="mat-popover flex flex-col gap-5 rounded-[var(--radius-panel)] p-6">
          {codeFromLink ? (
            <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2.5" data-testid="auth-invite-card">
              <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-card)] bg-accent-strong text-caption font-semibold text-accent-fg" aria-hidden>
                {workspaceInitials(preview.ws)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold" title={preview.ws}>
                  {t('mail.inv.title', { ws: preview.ws })}
                </p>
                <p className="text-caption text-muted">
                  {mode === 'login' ? t('mail.inv.login') : preview.email ? t('mail.inv.registerEmail') : t('mail.inv.register')}
                </p>
              </div>
            </div>
          ) : null}
          {banner ? <p className="rounded-[var(--radius-row)] bg-mention px-3 py-2 text-body">{t(banner)}</p> : null}
          <Field label={t('auth.email')} error={fieldErr('email')} hint={emailLocked ? t('mail.invitedHint') : undefined}>
            <Input
              type="email"
              autoFocus={!emailLocked}
              required
              readOnly={emailLocked}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSimilar(false);
              }}
              autoComplete="username"
              className={cx('h-8', emailLocked && 'text-muted')}
            />
          </Field>
          {mode === 'register' ? (
            <Field label={t('auth.name')} error={fieldErr('displayName')}>
              <Input required value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className="h-8" />
            </Field>
          ) : null}
          <div className="flex flex-col gap-3">
            <Field label={t('auth.password')} error={fieldErr('password')} hint={mode === 'register' ? t('auth.passwordHint') : undefined}>
              <PasswordInput
                required
                minLength={mode === 'register' ? 8 : 1}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setLoginFailed(false);
                }}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="h-8"
              />
            </Field>
            {/* «Забыли пароль?» right under the password, next in tab order (docs/09 #119); after a
                wrong password — the error line with the recovery as its action. */}
            {mode === 'login' && loginFailed ? (
              <p className="text-body text-danger-text" role="alert" data-testid="auth-login-failed">
                {t('mail.forgot.failed')}{' '}
                <button type="button" className="rounded-[var(--radius-control)] font-semibold text-accent-text hover:underline" onClick={toForgot}>
                  {t('mail.forgot.recover')}
                </button>
              </p>
            ) : mode === 'login' ? (
              <button type="button" className="self-start rounded-[var(--radius-control)] text-body text-accent-text hover:underline" onClick={toForgot}>
                {t('mail.forgot.link')}
              </button>
            ) : null}
          </div>
          {mode === 'register' && !codeFromLink ? (
            <Field label={t('auth.invite')} hint={t('auth.inviteHint')} error={fieldErr('inviteCode')}>
              <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} spellCheck={false} className="h-8" />
            </Field>
          ) : null}
          {desktop && showServer ? (
            <Field label={t('auth.server')} hint={t('auth.serverHint')} error={fieldErr('serverUrl')}>
              <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://app.example.com" spellCheck={false} className="h-8" />
            </Field>
          ) : null}
          {err && !err.field ? (
            <p className="text-body text-danger-text" role="alert">
              {err.text}
            </p>
          ) : null}
          {similar ? (
            // Non-blocking hint (docs/09 #119): the other address is never shown.
            <div className="flex flex-col gap-2.5 rounded-[var(--radius-row)] bg-mention px-3 py-2.5 text-body" role="alert" data-testid="auth-similar">
              <p className="flex gap-2">
                <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
                <span>{t('mail.similar.text')}</span>
              </p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" busy={busy} onClick={(e) => void submit(e, true)}>
                  {t('mail.similar.create')}
                </Button>
                <Button
                  type="button"
                  autoFocus
                  onClick={() => {
                    setSimilar(false);
                    setMode('login');
                  }}
                >
                  {t('mail.similar.login')}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" busy={busy} className="mt-1 h-9 w-full text-body font-semibold">
              {mode === 'login' ? t('auth.login') : t('auth.register')}
            </Button>
          )}
          {mode === 'login' ? (
            <Button
              type="button"
              variant="secondary"
              className="h-9 w-full"
              aria-expanded={showCorporate}
              aria-controls={showCorporate ? 'corporate-login' : undefined}
              onClick={() => setShowCorporate(!showCorporate)}
            >
              {t('identity.signIn')}
            </Button>
          ) : null}
        </div>
        <div className="mt-5 flex flex-col items-center gap-3 text-body text-muted">
          <p className="flex flex-wrap items-center justify-center gap-x-1 gap-y-2 text-center">
            {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
            <button
              type="button"
              className="rounded-[var(--radius-control)] text-accent-text hover:underline"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setErr(null);
                setLoginFailed(false);
                setSimilar(false);
              }}
            >
              {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}
            </button>
          </p>
          {pendingRoom ? (
            <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={() => useRoomLink.setState({ preferLogin: false })}>
              {t('guest.back')}
            </button>
          ) : null}
        </div>
        {showCorporate && mode === 'login' ? (
          <div id="corporate-login" className="mt-6">
            <CorporateLogin serverUrl={serverUrl} />
          </div>
        ) : null}
      </form>
      {/* NOTICE: the «Powered by GPTunneL» attribution is required in the UI (BUSL-1.1 grant). */}
      <AuthLegalFooter className="no-drag mt-6 w-full max-w-[380px] shrink-0 gap-2 mobile:gap-0" />
    </div>
  );
}

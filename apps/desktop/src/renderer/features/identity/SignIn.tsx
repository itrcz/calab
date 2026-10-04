import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PublicSSOWorkspace } from '@calaba/protocol';
import type { SsoStart } from '../../../shared/ipc';
import { Button, Card, Field, Input, PasswordInput } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { platform } from '../../platform';
import { beginSession, retryConnect } from '../../services/session';
import { queryClient } from '../../lib/queryClient';
import { identityApi } from './api';
import { useSession } from '../../stores/session';

export function SsoButton({ workspaceId, purpose, onDone }: SsoStart & { onDone?: () => void }): ReactNode {
  const [pending, setPending] = useState<{ attemptId: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(pending);
  useEffect(() => {
    current.current = pending;
  }, [pending]);
  const generationRef = useRef(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    const generation = generationRef;
    const off = platform.auth.onSsoResult((r) => {
      if (r.workspaceId !== workspaceId || r.purpose !== purpose || !current.current) return;
      setPending(null);
      if (r.ok) {
        if (r.session) beginSession(r.session);
        else {
          done.current?.();
          void retryConnect();
        }
      } else setError(r.error ? errorText(new ApiError(r.error.code, '', r.error.status)) : t('identity.unavailable'));
    });
    return () => {
      off();
      generation.current++;
      if (current.current) void platform.auth.ssoCancel(current.current.attemptId);
    };
  }, [workspaceId, purpose]);
  useEffect(() => {
    const check = (): void => {
      if (current.current && current.current.expiresAt <= Date.now()) {
        void platform.auth.ssoCancel(current.current.attemptId);
        setPending(null);
        setError(t('identity.expired'));
      }
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  const cancel = (): void => {
    generationRef.current++;
    void platform.auth.ssoCancel(pending?.attemptId ?? 'pending');
    current.current = null;
    setPending(null);
    setBusy(false);
  };
  const start = async (): Promise<void> => {
    const run = ++generationRef.current;
    setBusy(true);
    setError('');
    try {
      const r = await platform.auth.ssoBegin({ workspaceId, purpose });
      if (run !== generationRef.current) {
        if (r.ok) void platform.auth.ssoCancel(r.data.attemptId);
        return;
      }
      if (r.ok) {
        current.current = r.data;
        setPending(r.data);
      } else setError(errorText(new ApiError(r.error.code, '', r.error.status)));
    } finally {
      if (run === generationRef.current) setBusy(false);
    }
  };
  const label =
    purpose === 'login'
      ? 'identity.signIn'
      : purpose === 'link'
        ? 'identity.link'
        : purpose === 'test'
          ? 'identity.test'
          : 'identity.stepUp';
  return (
    <div className="flex flex-col gap-2" data-testid={`sso-${purpose}`}>
      {error ? (
        <p role="alert" className="text-body text-danger-text">
          {error}
        </p>
      ) : null}
      {pending ? (
        <>
          <p role="status" className="text-body text-muted">
            {t('identity.waiting')}
          </p>
          <Button className="self-end mobile:self-stretch" variant="secondary" onClick={cancel}>
            {t('identity.cancel')}
          </Button>
        </>
      ) : (
        <Button className={purpose === 'login' ? 'w-full' : 'self-end mobile:self-stretch'} busy={busy} onClick={() => void start()}>
          {t(label)}
        </Button>
      )}
      {busy ? (
        <Button className="self-end mobile:self-stretch" variant="ghost" onClick={cancel}>
          {t('identity.cancel')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * «Подтвердить пароль»: a fresh local password proof (POST /api/auth/local/reauth, 5 minutes,
 * ADR-0054/0055). `open` starts with the password field shown (a screen that is blocked on
 * RECENT_AUTH_REQUIRED); `onConfirmed` retries what needed the proof.
 */
export function LocalReauth({
  embedded = false,
  open: initiallyOpen = false,
  onConfirmed,
}: { embedded?: boolean; open?: boolean; onConfirmed?: () => void } = {}): ReactNode {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(initiallyOpen);
  const sessionId = useSession((s) => s.sessionId);
  const [confirmedSession, setConfirmedSession] = useState<string | null>(null);
  const confirmed = confirmedSession !== null && confirmedSession === sessionId;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    setConfirmedSession(null);
    try {
      await identityApi.reauth(password);
      await queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0].startsWith('identity') || q.queryKey[0] === 'oauth-clients'),
      });
      if (useSession.getState().sessionId === sessionId) {
        setConfirmedSession(sessionId);
        setOpen(false);
        onConfirmed?.();
      }
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  const content = (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium" role={confirmed ? 'status' : undefined}>
            {t(confirmed ? 'identity.passwordConfirmed' : 'identity.reauth')}
          </p>
          <p className="mt-1 text-caption text-muted">{t('identity.reauthHelp')}</p>
        </div>
        <Button variant="secondary" disabled={busy} aria-expanded={open} onClick={() => {
          setOpen(!open);
          setPassword('');
          setMessage('');
        }}>
          {t(open ? 'identity.cancel' : confirmed ? 'identity.confirmAgain' : 'identity.reauth')}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 mobile:basis-full">
            <Field label={t('identity.password')}>
              <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <Button busy={busy} disabled={!password} onClick={() => void submit()}>{t('identity.reauth')}</Button>
        </div>
      ) : null}
      {message ? <p role="alert" className="text-body text-danger-text">{message}</p> : null}
    </div>
  );
  return embedded ? content : <Card>{content}</Card>;
}

export function CorporateLogin({ serverUrl }: { serverUrl: string }): ReactNode {
  const [slug, setSlug] = useState('');
  const [workspace, setWorkspace] = useState<PublicSSOWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const find = async (): Promise<void> => {
    setBusy(true);
    setWorkspace(null);
    setError('');
    try {
      if (platform.kind === 'electron') await platform.app.setSettings({ serverUrl });
      setWorkspace(await identityApi.descriptor(slug.trim()));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('identity.title')}>
      <div className="flex flex-col gap-3 p-4">
        <Field label={t('identity.slug')}>
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setWorkspace(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void find();
              }
            }}
          />
        </Field>
        <Button className="self-end mobile:self-stretch" variant="secondary" busy={busy} disabled={!slug.trim()} onClick={() => void find()}>
          {t('identity.find')}
        </Button>
        {error ? (
          <p role="alert" className="text-danger-text">
            {error}
          </p>
        ) : null}
        {workspace ? (
          <>
            <p className="text-headline font-semibold">{workspace.displayName}</p>
            {workspace.loginEnabled ? (
              <SsoButton workspaceId={workspace.workspaceId} purpose="login" />
            ) : (
              <p className="text-muted">{t('identity.unavailable')}</p>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}

export function SsoComplete(): ReactNode {
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void platform.finishSso?.().then((r) => {
      if (!r.ok) setError(errorText(new ApiError(r.error.code, '', r.error.status)));
      else {
        if (r.data.returnTo) {
          location.replace(r.data.returnTo);
          return;
        }
        if (r.data.session) beginSession(r.data.session);
        else void retryConnect();
        setComplete(true);
      }
    });
  }, []);
  return (
    <div className="mat-content grid h-full place-items-center overflow-auto p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-title font-semibold">{t('identity.title')}</h1>
        <p role={error ? 'alert' : 'status'}>{error || t(complete ? 'identity.done' : 'identity.waiting')}</p>
        <Button
          className="self-end mobile:self-stretch"
          onClick={() => {
            history.replaceState(null, '', '/');
            location.reload();
          }}
        >
          {t(error ? 'identity.restart' : 'identity.done')}
        </Button>
      </div>
    </div>
  );
}

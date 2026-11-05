import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError, callJson } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { useSession } from '../../stores/session';
import { AuthScreen } from '../auth/AuthScreen';
import { localAuthority } from '../identity/model';
import { mcpReturnTarget, type McpConsent } from './model';

/**
 * «Подключить MCP-клиент» (ADR-0158): the page an MCP client's OAuth request lands on
 * (/mcp/connect#<handle>, web only). Signed out → the sign-in screen, then the consent. The
 * request is bound to this browser (the server's cookie) and to this session; «Разрешить» sends
 * the one-time code back to the client, «Отказать» — access_denied.
 */
export function McpConnect({ handle }: { handle: string }): ReactNode {
  const status = useSession((s) => s.status);
  const sessionId = useSession((s) => s.sessionId);
  const local = useSession((s) => localAuthority(s.authority));
  if (status === 'anon') return <AuthScreen />;
  if (status !== 'authed')
    return (
      <Centered>
        <Spinner className="size-8" />
      </Centered>
    );
  if (!local)
    return (
      <Centered>
        <p role="alert">{t('mcpConnect.localOnly')}</p>
      </Centered>
    );
  return <BoundConnect key={`${handle}:${sessionId}`} handle={handle} sessionId={sessionId} />;
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return <div className="mat-content grid h-full place-items-center overflow-auto p-6">{children}</div>;
}

const path = (handle: string, what: 'bind' | 'decision'): string => `/api/mcp/oauth/requests/${encodeURIComponent(handle)}/${what}`;

function reasonText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.reason === 'MCP_OTHER_BROWSER') return t('mcpConnect.otherBrowser');
    if (e.reason === 'MCP_REQUEST_EXPIRED') return t('mcpConnect.expired');
    if (e.reason === 'MCP_LOCAL_ONLY') return t('mcpConnect.localOnly');
  }
  return errorText(e);
}

function BoundConnect({ handle, sessionId }: { handle: string; sessionId: string }): ReactNode {
  const [consent, setConsent] = useState<McpConsent | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'allowed' | 'denied' | null>(null);
  const bound = useRef('');
  useEffect(() => {
    const controller = new AbortController();
    bound.current = sessionId;
    void callJson<McpConsent>('POST', path(handle, 'bind'), {}, controller.signal).then(
      (c) => {
        if (!controller.signal.aborted && useSession.getState().sessionId === sessionId) setConsent(c);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(reasonText(e));
      },
    );
    return () => controller.abort();
  }, [handle, sessionId]);
  const decide = async (allow: boolean): Promise<void> => {
    if (!consent || busy) return;
    if (bound.current !== useSession.getState().sessionId || new Date(consent.expiresAt).getTime() <= Date.now()) {
      setConsent(null);
      setError(t('mcpConnect.expired'));
      return;
    }
    setBusy(true);
    try {
      const r = await callJson<{ redirectUrl: string }>('POST', path(handle, 'decision'), { csrfToken: consent.csrfToken, allow });
      setConsent(null);
      setDone(allow ? 'allowed' : 'denied');
      location.replace(r.redirectUrl);
    } catch (e) {
      setConsent(null);
      setError(reasonText(e));
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <Centered>
        <p role="status" data-testid="mcp-connect-done" className="max-w-md text-center">
          {done === 'allowed' ? t('mcpConnect.allowed') : t('mcpConnect.denied')}
        </p>
      </Centered>
    );
  if (error)
    return (
      <Centered>
        <p role="alert" data-testid="mcp-connect-error" className="max-w-md text-center">
          {error}
        </p>
      </Centered>
    );
  if (!consent)
    return (
      <Centered>
        <Spinner className="size-8" />
      </Centered>
    );
  const target = mcpReturnTarget(consent);
  return (
    <Centered>
      <div className="flex w-full max-w-md flex-col gap-6" data-testid="mcp-connect">
        <h1 className="text-title font-semibold">{t('mcpConnect.title')}</h1>
        <Card title={consent.clientName}>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-body text-muted">{t('mcpConnect.selfNamed')}</p>
            <p>{t('mcpConnect.what')}</p>
            <p className="text-body text-muted">{t('mcpConnect.mark')}</p>
            <p className="text-body">
              {t('mcpConnect.account')}: <span className="font-medium">{consent.displayName}</span>
              {consent.email ? <span className="text-muted"> · {consent.email}</span> : null}
            </p>
            <p className="break-all text-body" data-testid="mcp-connect-target">
              {target.local ? t('mcpConnect.toLocal', { port: target.where }) : t('mcpConnect.toHost', { host: target.where })}
            </p>
            <p className="text-body text-warn" data-testid="mcp-connect-warn">
              {t('mcpConnect.warn', {
                time: new Date(consent.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              })}
            </p>
            <p className="text-body text-muted">{t('mcpConnect.revoke')}</p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button className="self-end mobile:self-stretch" variant="secondary" busy={busy} onClick={() => void decide(false)}>
                {t('mcpConnect.deny')}
              </Button>
              <Button className="self-end mobile:self-stretch" busy={busy} onClick={() => void decide(true)}>
                {t('mcpConnect.allow')}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </Centered>
  );
}

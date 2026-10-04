import { useQuery } from '@tanstack/react-query';
import {
  OAuthClientType,
  type OAuthClient,
  type OAuthGrant,
  type OAuthConsentSnapshot,
  type OAuthClientSecretResponse,
} from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Field, Input, Modal, Select, Spinner, Switch as Toggle } from '../../components/ui';
import { confirmIdentity as confirmAction } from './confirm';
import { t } from '../../i18n';
import { errorText, identityNotConfigured } from '../../lib/api/errors';
import { PlanLock } from '../../components/PlanLock';
import { planHasIdentity } from '../../lib/plan';
import { useWorkspaces } from '../../stores/workspaces';
import { IdentityAbout, IdentityNotConfigured } from './IdentityGate';
import { useSession } from '../../stores/session';
import { AuthScreen } from '../auth/AuthScreen';
import { identityApi } from './api';
import { lines } from './model';
import { identityDate, OneTimeSecret, useIdentityAction } from './IdentitySettings';
import { useIdentity } from '../../stores/identity';
import { localAuthority } from './model';
import { LocalReauth, SsoButton } from './SignIn';
import { consentWorkspaceCandidates } from './consentWorkspaces';

export function OAuthClients({ workspaceId }: { workspaceId: string }): ReactNode {
  const clients = useQuery({
    queryKey: ['oauth-clients', workspaceId],
    queryFn: () => identityApi.clients(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [edit, setEdit] = useState<OAuthClient | 'new' | null>(null);
  const [secret, setSecret] = useState<OAuthClientSecretResponse | null>(null);
  const [rotation, setRotation] = useState<OAuthClient | null>(null);
  const [revokeOld, setRevokeOld] = useState(false);
  const action = useIdentityAction();
  const { run } = action;
  const { refetch } = clients;
  const removeClient = useCallback(
    (client: OAuthClient): void => {
      void run(async () => {
        if (await confirmAction({ title: t('identity.delete'), body: client.name, confirm: t('identity.delete'), danger: true })) {
          await identityApi.deleteClient(workspaceId, client.clientId);
          await refetch();
        }
      });
    },
    [run, workspaceId, refetch],
  );
  const rotateClient = useCallback((client: OAuthClient): void => {
    setRevokeOld(false);
    setRotation(client);
  }, []);
  return (
    <div className="flex flex-col gap-6" data-testid="oauth-clients">
      <LocalReauth />
      <section className="flex flex-col gap-2" aria-label={t('identity.oauth')}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <h3 className="text-caption font-semibold text-muted">{t('identity.oauth')}</h3>
          <Button onClick={() => setEdit('new')}>{t('identity.create')}</Button>
        </div>
        <Card>
          <div className="flex flex-col gap-3 p-4">
            {clients.data?.clients.map((c) => (
              <ClientRow key={c.id} client={c} busy={action.busy} onEdit={setEdit} onDelete={removeClient} onRotate={rotateClient} />
            ))}
            {clients.data?.clients.length === 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-body font-medium">{t('identity.noApps')}</p>
                <p className="text-body text-muted">{t('identity.oauthEmptyHelp')}</p>
              </div>
            ) : null}
            {clients.error || action.error ? (
              <p role="alert" className="text-danger-text">
                {action.error || errorText(clients.error)}
              </p>
            ) : null}
            <Button className="self-end mobile:self-stretch" variant="secondary" busy={clients.isFetching} onClick={() => void clients.refetch()}>
              {t('identity.refresh')}
            </Button>
          </div>
        </Card>
      </section>
      {rotation ? (
        <Modal
          open
          title={t('identity.rotate')}
          onClose={() => setRotation(null)}
          footer={
            <div className="flex w-full flex-wrap justify-end gap-2 pt-3">
              <Button variant="secondary" onClick={() => setRotation(null)}>{t('identity.cancel')}</Button>
              <Button variant="destructive" busy={action.busy} onClick={() => void action.run(async () => {
                setSecret(await identityApi.rotateClient(workspaceId, rotation.clientId, revokeOld));
                setRotation(null);
                await refetch();
              })}>{t('identity.rotate')}</Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="text-body font-medium">{rotation.name}</p>
            <p className="text-body text-muted">{t('identity.oauthRotationHelp')}</p>
            <Toggle label={t('identity.revokeOld')} checked={revokeOld} onChange={setRevokeOld} />
            {action.error ? <p role="alert" className="text-body text-danger-text">{action.error}</p> : null}
          </div>
        </Modal>
      ) : null}
      {edit ? (
        <ClientForm
          workspaceId={workspaceId}
          {...(edit === 'new' ? {} : { client: edit })}
          onClose={() => setEdit(null)}
          onSaved={(result) => {
            setSecret(result);
            setEdit(null);
            void clients.refetch();
          }}
        />
      ) : null}
      {secret?.secretOnce ? (
        <OneTimeSecret
          value={secret.secretOnce}
          {...(secret.oldSecretValidUntil ? { deadline: secret.oldSecretValidUntil } : {})}
          onClose={() => setSecret(null)}
        />
      ) : null}
    </div>
  );
}
const ClientRow = memo(function ClientRow({
  client,
  busy,
  onEdit,
  onDelete,
  onRotate,
}: {
  client: OAuthClient;
  busy: boolean;
  onEdit: (c: OAuthClient) => void;
  onDelete: (c: OAuthClient) => void;
  onRotate: (c: OAuthClient) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-hover p-3">
      <div>
        <h3 className="text-headline font-semibold">{client.name}</h3>
        <p className="break-all text-body text-muted">
          {t('identity.clientId')}: {client.clientId}
        </p>
        {client.disabledAt ? <p>{t('identity.off')}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="self-end mobile:self-stretch" variant="secondary" disabled={busy} onClick={() => onEdit(client)}>
          {t('identity.edit')}
        </Button>
        {client.type === OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB ? (
          <Button className="self-end mobile:self-stretch" variant="secondary" disabled={busy} onClick={() => onRotate(client)}>
            {t('identity.rotate')}
          </Button>
        ) : null}
        <Button className="self-end mobile:self-stretch" variant="destructive" disabled={busy} onClick={() => onDelete(client)}>
          {t('identity.delete')}
        </Button>
      </div>
    </div>
  );
});
function ClientForm({
  workspaceId,
  client,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  client?: OAuthClient;
  onClose: () => void;
  onSaved: (result: OAuthClientSecretResponse | null) => void;
}): ReactNode {
  const [name, setName] = useState(client?.name ?? '');
  const [type, setType] = useState(client?.type ?? OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB);
  const [redirects, setRedirects] = useState(client?.redirectUris.join('\n') ?? '');
  const [origins, setOrigins] = useState(client?.allowedOrigins.join('\n') ?? '');
  const [profile, setProfile] = useState(client?.scopes.includes('profile') ?? true);
  const [email, setEmail] = useState(client?.scopes.includes('email') ?? false);
  const [refresh, setRefresh] = useState(client?.refreshEnabled ?? false);
  const action = useIdentityAction();
  const save = async (): Promise<void> => {
    const init = {
      name,
      redirectUris: lines(redirects),
      allowedOrigins: lines(origins),
      scopes: ['openid', ...(profile ? ['profile'] : []), ...(email ? ['email'] : [])],
      refreshEnabled: refresh,
    };
    if (client) {
      await identityApi.updateClient(workspaceId, client.clientId, { ...init, version: client.version });
      onSaved(null);
    } else onSaved(await identityApi.createClient(workspaceId, { ...init, type }));
  };
  return (
    <Modal
      open
      title={t(client ? 'identity.edit' : 'identity.create')}
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2 pt-3">
          <Button className="self-end mobile:self-stretch" variant="secondary" onClick={onClose}>
            {t('identity.cancel')}
          </Button>
          <Button
            className="self-end mobile:self-stretch"
            busy={action.busy}
            disabled={!name.trim() || !lines(redirects).length || lines(redirects).length > 10 || lines(origins).length > 10}
            onClick={() => void action.run(save)}
          >
            {t('identity.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <h3 className="text-body font-semibold">{t('identity.appDetails')}</h3>
        <Field label={t('identity.name')}>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('identity.type')}>
          <Select disabled={!!client} value={type} onChange={(e) => setType(Number(e.target.value))}>
            <option value={OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB}>{t('identity.clientWeb')}</option>
            <option value={OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_NATIVE}>{t('identity.clientNative')}</option>
            <option value={OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_SPA}>{t('identity.clientSpa')}</option>
          </Select>
        </Field>
        <h3 className="mt-2 text-body font-semibold">{t('identity.callbackSection')}</h3>
        <Field label={t('identity.redirects')} hint={t(type === OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_NATIVE ? 'identity.nativeRedirectHelp' : 'identity.redirectHelp')}>
          <textarea
            className="w-full rounded-[var(--radius-card)] border border-line bg-hover p-3"
            rows={3}
            placeholder="https://app.example.com/auth/callback"
            spellCheck={false}
            value={redirects}
            onChange={(e) => setRedirects(e.target.value)}
          />
        </Field>
        <Field label={t('identity.origins')} hint={t('identity.originsHelp')}>
          <textarea
            className="w-full rounded-[var(--radius-card)] border border-line bg-hover p-3"
            rows={2}
            placeholder="https://app.example.com"
            spellCheck={false}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
          />
        </Field>
        <h3 className="mt-2 text-body font-semibold">{t('identity.accessSection')}</h3>
        <Toggle label={t('identity.scopes')} checked={profile} onChange={setProfile} />
        <Toggle label={t('auth.email')} checked={email} onChange={setEmail} />
        <Toggle label={t('identity.refreshAccess')} checked={refresh} onChange={setRefresh} />
        {action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
/** Some workspace of mine can have the OAuth provider (Business): otherwise «OAuth-приложения» is PlanLock'ed. */
export const useOAuthAppsAvailable = (): boolean => useWorkspaces((s) => Object.values(s.byId).some((e) => planHasIdentity(e.ws.plan)));

/**
 * Settings → «OAuth-приложения»: the apps I signed in to with Calab, and revoking them. Business
 * only in the cloud (ADR-0054 §5): with no Business workspace PlanLock dims a description. The
 * list is still requested — an on-prem Enterprise workspace is entitled on any plan, and an
 * existing grant must stay revocable — and shown whenever it has an active grant. A server
 * without identity configuration says so instead of an error.
 */
export function AuthorizedApps(): ReactNode {
  const available = useOAuthAppsAvailable();
  const grants = useQuery({
    queryKey: ['oauth-grants', useSession((s) => s.sessionId)],
    queryFn: identityApi.grants,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const action = useIdentityAction();
  const { run } = action;
  const { refetch } = grants;
  const revokeGrant = useCallback(
    (id: string): void => {
      void run(async () => {
        await identityApi.revoke(id);
        await refetch();
      });
    },
    [run, refetch],
  );
  const active = grants.data?.grants.filter((g) => !g.revokedAt);
  if (!available && !active?.length)
    return (
      <PlanLock plan="business" testId="oauth-grants-lock">
        <IdentityAbout title="identity.grants" text="identity.grantsHelp" />
      </PlanLock>
    );
  if (identityNotConfigured(grants.error)) return <IdentityNotConfigured />;
  return (
    <Card title={t('identity.grants')}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-body text-muted">{t('identity.grantsHelp')}</p>
        {grants.isPending ? <Spinner className="mx-auto" /> : null}
        {active?.map((g) => (
          <GrantRow key={g.id} grant={g} busy={action.busy} onRevoke={revokeGrant} />
        ))}
        {active?.length === 0 ? <p className="text-body font-medium" data-testid="oauth-grants-empty">{t('identity.noApps')}</p> : null}
        {grants.error || action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error || errorText(grants.error)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
const GrantRow = memo(function GrantRow({
  grant,
  busy,
  onRevoke,
}: {
  grant: OAuthGrant;
  busy: boolean;
  onRevoke: (id: string) => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] bg-hover p-3">
      <div>
        <h3 className="font-semibold">{grant.clientName}</h3>
        <p className="break-all text-body text-muted">
          {grant.workspaceId} · {grant.scopes.join(', ')}
          <br />
          {t('identity.deadline')}: {identityDate(grant.expiresAt)}
        </p>
      </div>
      <Button className="self-end mobile:self-stretch" variant="destructive" busy={busy} onClick={() => onRevoke(grant.id)}>
        {t('identity.revoke')}
      </Button>
    </div>
  );
});
export function OAuthConsent({ handle }: { handle: string }): ReactNode {
  const sessionId = useSession((s) => s.sessionId);
  const status = useSession((s) => s.status);
  if (status === 'anon') return <AuthScreen />;
  if (status !== 'authed') return <p role="status">{t('identity.waiting')}</p>;
  return <BoundConsent key={`${handle}:${sessionId}`} handle={handle} sessionId={sessionId} />;
}
function BoundConsent({ handle, sessionId }: { handle: string; sessionId: string }): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const scopedWorkspace = useSession((s) => s.authority?.workspaceId ?? '');
  const workspaceIds = useIdentity((s) =>
    consentWorkspaceCandidates(Object.values(s.access), scopedWorkspace).join('|'),
  );
  const [workspaceId, setWorkspaceId] = useState(scopedWorkspace);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<OAuthConsentSnapshot | null>(null);
  const [refresh, setRefresh] = useState(false);
  const action = useIdentityAction();
  const boundSession = useRef('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    boundSession.current = sessionId;
    void identityApi.bind(handle, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted && useSession.getState().sessionId === sessionId) setSnapshot(result);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      },
    );
    return () => controller.abort();
  }, [handle, sessionId, attempt]);
  const decide = async (allow: boolean): Promise<void> => {
    if (
      !snapshot ||
      boundSession.current !== sessionId ||
      (snapshot.expiresAt && timestampDate(snapshot.expiresAt).getTime() <= Date.now())
    ) {
      setSnapshot(null);
      setError(t('identity.expired'));
      return;
    }
    const result = await identityApi.decide(handle, snapshot.csrfToken, allow, allow && refresh);
    setSnapshot(null);
    if (useSession.getState().sessionId !== sessionId) {
      setError(t('identity.changed'));
      return;
    }
    location.replace(result.redirectUrl);
  };
  return (
    <div className="mat-content flex h-full items-center justify-center overflow-auto p-6">
      <div className="flex w-full max-w-md flex-col gap-6" data-testid="oauth-consent">
        <h1 className="text-title font-semibold">{t('identity.consent')}</h1>
        {snapshot ? (
          <Card title={snapshot.clientName}>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-headline">{snapshot.workspaceName}</p>
              <p>{snapshot.displayName}</p>
              <p className="text-body text-muted">{t('identity.consentHelp')}</p>
              <p className="break-all text-body">
                {t('identity.scopes')}: {snapshot.scopes.join(', ')}
              </p>
              <p className="break-all text-body text-muted">{snapshot.redirectUri}</p>
              <p className="text-body text-muted">
                {t('identity.deadline')}: {identityDate(snapshot.expiresAt)}
              </p>
              {snapshot.refreshRequested ? <Toggle label={t('identity.refreshAccess')} checked={refresh} onChange={setRefresh} /> : null}
              <div className="flex flex-wrap justify-end gap-3">
                <Button className="self-end mobile:self-stretch" variant="secondary" busy={action.busy} onClick={() => void action.run(() => decide(false))}>
                  {t('identity.deny')}
                </Button>
                <Button className="self-end mobile:self-stretch" busy={action.busy} onClick={() => void action.run(() => decide(true))}>
                  {t('identity.allow')}
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-4" data-testid="consent-auth-repair">
            <p role={error ? 'alert' : 'status'}>{error || t('identity.waiting')}</p>
            {error ? (
              <>
                {local ? <LocalReauth /> : null}
                <Field label={t('identity.slug')}>
                  <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                    <option value="">—</option>
                    {workspaceIds.split('|').filter(Boolean).map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </Select>
                </Field>
                {workspaceId ? (
                  <SsoButton
                    workspaceId={workspaceId}
                    purpose="step_up"
                    onDone={() => {
                      setError('');
                      setAttempt((n) => n + 1);
                    }}
                  />
                ) : null}
                <Button
                  className="self-end mobile:self-stretch"
                  variant="secondary"
                  onClick={() => {
                    setError('');
                    setAttempt((n) => n + 1);
                  }}
                >
                  {t('identity.refresh')}
                </Button>
              </>
            ) : null}
          </div>
        )}
        {action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

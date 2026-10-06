import { useQuery } from '@tanstack/react-query';
import { errorText } from '../../lib/api/errors';
import { useState, type ReactNode } from 'react';
import { IdentityAccessReason, IdentityPolicyMode, IdentityConnectionStatus } from '@calaba/protocol';
import { Button, Card, Field, PasswordInput } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { ApiError } from '../../lib/api/client';
import { useIdentity } from '../../stores/identity';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { localAuthority, lockTitleKey, reasonKey } from './model';
import { identityApi } from './api';
import { LocalReauth, SsoButton } from './SignIn';
import { useIdentityAction } from './IdentitySettings';
export function WorkspaceLock({ workspaceId }: { workspaceId: string }): ReactNode {
  const access = useIdentity((s) => s.access[workspaceId]);
  const local = useSession((s) => localAuthority(s.authority));
  const status = useQuery({
    queryKey: ['identity', workspaceId],
    queryFn: () => identityApi.status(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const action = useIdentityAction();
  const connection = status.data?.connection;
  const [code, setCode] = useState('');
  const [recoveryUntil, setRecoveryUntil] = useState(0);
  return (
    <div className="mat-content flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6" data-testid="workspace-identity-lock">
        <h1 className="text-title font-semibold">{t(lockTitleKey(access?.reason))}</h1>
        <p className="text-body text-muted">{t(reasonKey(access?.reason ?? IdentityAccessReason.SSO_REQUIRED))}</p>
        <p className="break-all text-caption text-muted">{workspaceId}</p>
        {local ? (
          <>
            <LocalReauth />
            <p className="text-body text-muted">{t('identity.linkHelp')}</p>
            <SsoButton workspaceId={workspaceId} purpose="link" />
            <SsoButton workspaceId={workspaceId} purpose="step_up" />
            {connection ? (
              <Card title={t('identity.connection')}>
                <div className="flex flex-col gap-3 p-4" data-testid="locked-owner-repair">
                  <h2 className="text-headline font-semibold">{connection.name}</h2>
                  <p className="break-all text-body text-muted">{connection.issuer}</p>
                  <SsoButton
                    workspaceId={workspaceId}
                    purpose="test"
                    onDone={() => {
                      void status.refetch();
                    }}
                  />
                  <Button
                    variant="secondary"
                    busy={action.busy}
                    disabled={connection.status !== IdentityConnectionStatus.TESTED}
                    onClick={() =>
                      void action.run(async () => {
                        await identityApi.activate(workspaceId, connection);
                        await status.refetch();
                      })
                    }
                  >
                    {t('identity.activate')}
                  </Button>
                </div>
              </Card>
            ) : null}
            <Button variant="secondary" busy={status.isFetching} onClick={() => void status.refetch()}>
              {t('identity.refresh')}
            </Button>
            {status.error ? <p role="alert">{errorText(status.error)}</p> : null}
            <Card title={t('identity.recovery')}>
              <div className="flex flex-col gap-3 p-4">
                <p className="text-body text-muted">{t('identity.recoveryOnly')}</p>
                {recoveryUntil > 0 ? (
                  <Button
                    busy={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        if (recoveryUntil <= Date.now()) {
                          setRecoveryUntil(0);
                          throw new ApiError('ERROR_CODE_RECENT_AUTH_REQUIRED', '', 403);
                        }
                        await identityApi.policy(workspaceId, access?.policyVersion ?? 0n, IdentityPolicyMode.OPTIONAL);
                        setRecoveryUntil(0);
                      })
                    }
                  >
                    {t('identity.optional')}
                  </Button>
                ) : (
                  <>
                    <Field label={t('identity.recoveryCode')}>
                      <PasswordInput autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
                    </Field>
                    <Button
                      busy={action.busy}
                      disabled={!code}
                      onClick={() =>
                        void action.run(async () => {
                          try {
                            const r = await platform.auth.recover(workspaceId, code);
                            if (!r.ok) throw new ApiError(r.error.code, '', r.error.status);
                            setRecoveryUntil(r.data.expiresAt);
                          } finally {
                            setCode('');
                          }
                        })
                      }
                    >
                      {t('identity.recovery')}
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </>
        ) : (
          <SsoButton workspaceId={workspaceId} purpose="step_up" />
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
export function LockedWorkspacePicker(): ReactNode {
  // A primitive `id:reason|…` key: the picker re-renders only when the set or a reason changes.
  const ids = useIdentity((s) =>
    Object.entries(s.access)
      .filter(([, a]) => a.reason !== IdentityAccessReason.ALLOWED)
      .map(([id, a]) => `${id}:${a.reason}`)
      .join('|'),
  );
  return ids ? (
    <div className="flex flex-col gap-3 p-4">
      {ids.split('|').map((entry) => {
        const [id = '', reason] = entry.split(':');
        return (
          <Button key={id} variant="secondary" onClick={() => useUi.getState().setWorkspace(id)}>
            {t(lockTitleKey(Number(reason)))} · {id.slice(0, 8)}
          </Button>
        );
      })}
    </div>
  ) : null;
}

import { useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Field, Modal, PasswordInput } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { logout } from '../../services/session';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { deleteAccountError, ownedWorkspaceNames, type DeleteAccountErrors } from './deleteAccount';

/**
 * «Удалить аккаунт» (Настройки → Профиль, ADR-0153): what goes, what stays, the blockers (owned
 * workspaces), the current password, a red «Удалить навсегда». After 204 the app signs out: the
 * server has already revoked every session.
 */
export function DeleteAccountDialog({ onClose }: { onClose: () => void }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const owned = useWorkspaces(useShallow((s) => ownedWorkspaceNames(s.order, s.byId, me)));
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<DeleteAccountErrors>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const blocked = owned.length > 0 || errors.owner === true;

  const submit = async (): Promise<void> => {
    if (blocked) return;
    if (!password) {
      setErrors({ password: t('cred.err.currentRequired') });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.me.deleteAccount({ currentPassword: password });
    } catch (e) {
      setErrors(deleteAccountError(e));
      setBusy(false);
      return;
    }
    toast.success(t('account.delete.done'));
    onClose();
    void logout();
  };

  const formId = 'delete-account-form';
  return (
    <Modal
      open
      onClose={onClose}
      title={t('account.delete.title')}
      description={t('account.delete.text')}
      initialFocus={blocked ? cancel : first}
      footer={
        <>
          <Button ref={cancel} variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="destructive" busy={busy} disabled={blocked}>
            {t('account.delete.confirm')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3 text-body"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <section aria-labelledby="delete-account-gone" className="flex flex-col gap-1">
          <h3 id="delete-account-gone" className="text-caption font-semibold text-muted">
            {t('account.delete.goneTitle')}
          </h3>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>{t('account.delete.goneProfile')}</li>
            <li>{t('account.delete.goneSessions')}</li>
            <li>{t('account.delete.gonePersonal')}</li>
          </ul>
        </section>
        <section aria-labelledby="delete-account-stays" className="flex flex-col gap-1">
          <h3 id="delete-account-stays" className="text-caption font-semibold text-muted">
            {t('account.delete.staysTitle')}
          </h3>
          <p>{t('account.delete.stays')}</p>
        </section>
        {blocked ? (
          <div className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2.5" role="alert" data-testid="delete-account-blocked">
            <p className="font-semibold text-danger-text">{t('account.delete.ownerTitle')}</p>
            {owned.length > 0 ? (
              <ul className="list-disc pl-5">
                {owned.map((name, i) => (
                  <li key={`${i}:${name}`} className="break-words">
                    {name}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-caption text-muted">{t('account.delete.ownerText')}</p>
          </div>
        ) : (
          <Field label={t('cred.current')} error={errors.password}>
            <PasswordInput
              ref={first}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={errors.password ? true : undefined}
            />
          </Field>
        )}
        {errors.form ? (
          <p className="text-caption text-danger-text" role="alert">
            {errors.form}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

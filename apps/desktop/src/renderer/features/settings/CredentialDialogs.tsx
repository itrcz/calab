import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Field, Input, Modal, PasswordInput } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { resendVerification, verifyEmail } from '../../services/email';
import { CodeInput, CodeNote, ResendButton, useCodeFlow } from '../auth/VerifyEmail';
import { credentialError, hasErrors, validateEmailChange, validatePasswordChange, type CredentialErrors } from './credentials';

/**
 * «Изменить пароль / email» sheets (Настройки → Профиль). The one place in settings with an
 * explicit «Сохранить» (docs/08: changes apply at once, except password / email). Errors are
 * inline next to their field; a wrong current password never signs the user out (a 403 is not
 * an auth failure: only a 401 triggers refresh, lib/api + platform apiFetch).
 */
function CredentialSheet({
  title,
  description,
  busy,
  error,
  onClose,
  onSubmit,
  first,
  children,
}: {
  first: RefObject<HTMLInputElement | null>;
  title: string;
  description: string;
  busy: boolean;
  error: string | undefined;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}): ReactNode {
  const formId = 'credential-form';
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      initialFocus={first}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} busy={busy}>
            {t('cred.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
        {error ? (
          <p className="text-caption text-danger-text" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const submit = async (): Promise<void> => {
    const local = validatePasswordChange({ current, next, confirm });
    setErrors(local);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      await api.me.changePassword({ currentPassword: current, newPassword: next });
      toast.success(t('cred.passwordDone'));
      onClose();
    } catch (e) {
      setErrors(credentialError(e, 'password'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CredentialSheet first={first} title={t('cred.passwordTitle')} description={t('cred.passwordText')} busy={busy} error={errors.form} onClose={onClose} onSubmit={() => void submit()}>
      <Field label={t('cred.newPassword')} hint={t('cred.newPasswordHint')} error={errors.next}>
        <PasswordInput ref={first} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={errors.next ? true : undefined} />
      </Field>
      <Field label={t('cred.confirm')} error={errors.confirm}>
        <PasswordInput autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={errors.confirm ? true : undefined} />
      </Field>
      <Field label={t('cred.current')} error={errors.current}>
        <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-invalid={errors.current ? true : undefined} />
      </Field>
    </CredentialSheet>
  );
}

/**
 * «Смена email» (ADR-0023): the new address gets a code and waits in `me.pendingEmail`; login
 * stays on the old one until the code is entered (step «code», also opened from the profile row
 * by «Ввести код»). `cancel` drops the pending change: the server cancels it on a change to the
 * current address, which needs the password like any change. `verify` confirms the current,
 * unconfirmed address (profile row «Не подтверждена» · «Подтвердить», ADR-0065): a code is sent
 * when the sheet opens.
 */
export function ChangeEmailDialog({
  onClose,
  mode = 'change',
}: {
  onClose: () => void;
  mode?: 'change' | 'confirm' | 'cancel' | 'verify';
}): ReactNode {
  const currentEmail = useSession((s) => s.me?.email ?? '');
  const pending = useSession((s) => s.me?.pendingEmail ?? '');
  const verifyOnly = mode === 'verify';
  const [step, setStep] = useState<'form' | 'code'>(mode === 'confirm' || verifyOnly ? 'code' : 'form');
  const [email, setEmail] = useState('');
  const [current, setCurrent] = useState('');
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const flow = useCodeFlow(verifyEmail, resendVerification, () => {
    if (!verifyOnly) toast.success(t('cred.emailDone')); // verifyEmail says «Почта подтверждена» itself
    onClose();
  });
  // `verify`: the code goes out once, when the sheet opens (a 429 shows inline with its timer).
  const sent = useRef(false);
  useEffect(() => {
    if (!verifyOnly || sent.current) return;
    sent.current = true;
    flow.resend();
  }, [verifyOnly, flow]);
  const cancel = mode === 'cancel';

  const submit = async (): Promise<void> => {
    const local = cancel ? (current ? {} : { current: t('cred.err.currentRequired') }) : validateEmailChange({ email, current, currentEmail });
    setErrors(local);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      const r = await api.me.changeEmail({ newEmail: cancel ? currentEmail : email.trim(), currentPassword: current });
      if (r.me) useSession.getState().set({ me: r.me });
      if (cancel) {
        toast.success(t('mail.change.cancelled'));
        onClose();
      } else if (r.me?.pendingEmail) {
        // A code went to the new address: the second step of the same sheet.
        flow.markSent();
        setStep('code');
      } else {
        toast.success(t('cred.emailDone')); // a server without mail changes it at once
        onClose();
      }
    } catch (e) {
      setErrors(credentialError(e, 'email'));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'code')
    return (
      <Modal
        open
        onClose={onClose}
        title={verifyOnly ? t('mail.verify.title') : t('mail.change.codeTitle')}
        description={verifyOnly ? t('mail.verify.text', { email: currentEmail }) : t('mail.change.codeText', { email: pending || email.trim() })}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('mail.change.later')}
            </Button>
            <Button busy={flow.state.busy === 'verify'} onClick={flow.submit}>
              {t('mail.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <span className="flex items-center justify-between gap-2 text-caption font-medium text-muted">
            {t('mail.code')}
            <ResendButton flow={flow} />
          </span>
          <CodeInput flow={flow} autoFocus label={t('mail.code')} describedBy={noteId} />
          <CodeNote flow={flow} id={noteId} />
        </div>
      </Modal>
    );

  return (
    <CredentialSheet
      first={first}
      title={cancel ? t('mail.change.cancelTitle') : t('cred.emailTitle')}
      description={cancel ? t('mail.change.cancelText', { email: pending }) : t('cred.emailText', { email: currentEmail })}
      busy={busy}
      error={errors.form}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {cancel ? null : (
        <Field label={t('cred.newEmail')} error={errors.next}>
          <Input ref={first} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={errors.next ? true : undefined} spellCheck={false} />
        </Field>
      )}
      <Field label={t('cred.current')} error={errors.current}>
        <PasswordInput
          ref={cancel ? first : undefined}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          aria-invalid={errors.current ? true : undefined}
        />
      </Field>
    </CredentialSheet>
  );
}

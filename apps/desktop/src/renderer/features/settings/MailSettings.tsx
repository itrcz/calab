import { TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { isMailError, type MailAccount, type MailCertInfo } from '../../../shared/mail';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Field, Modal, PasswordInput, Row, Segmented, Select, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { mailApi, updateSettings, useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { accountCertIssues, CertNotice, certTitle, pinTail, unpin } from '../mail/CertNotice';
import { mailErrorText } from '../mail/format';
import { openSection } from '../shell/sectionNav';
import { CommitInput } from './CommitInput';

const GB = 1024 * 1024 * 1024;
const CACHE_LIMITS = [256 * 1024 * 1024, 512 * 1024 * 1024, GB, 2 * GB, 5 * GB, 10 * GB];

const errText = (e: unknown): string => mailErrorText(isMailError(e) ? e.code : 'ENGINE_DOWN');

/**
 * Settings → «Почта» (ADR-0088 §8; desktop only): the accounts (add, remove, password, sender
 * name, signature), new-mail notifications, remote images, the body cache size.
 */
export function MailTab(): ReactNode {
  const ids = useMail((s) => s.accountIds);
  const notify = useMail((s) => s.settings.notify);
  const images = useMail((s) => s.settings.remoteImages);
  const cache = useMail((s) => s.settings.cacheLimitBytes);
  const addAccount = (): void => {
    useUi.getState().openDialog(null);
    openSection('mail');
    useMailUi.getState().openAdd();
  };
  return (
    <>
      <Card title={t('mbox.settings.accounts')} footer={t('mbox.settings.accountsHint')}>
        {ids.length ? ids.map((id) => <AccountRows key={id} id={id} />) : <Row label={t('mbox.settings.noAccounts')} />}
        <Row label={t('mbox.addAccount')}>
          <Button size="sm" variant="secondary" onClick={addAccount} data-testid="settings-mail-add">
            {t('mbox.add.submit')}
          </Button>
        </Row>
      </Card>
      <Card title={t('mbox.settings.reading')}>
        <Row label={t('mbox.settings.notify')} hint={t('mbox.settings.notifyHint')}>
          <Toggle checked={notify} onChange={(v) => void updateSettings({ notify: v })} label={t('mbox.settings.notify')} />
        </Row>
        <Row label={t('mbox.settings.images')} hint={t('mbox.settings.imagesHint')}>
          <Segmented
            value={images}
            onChange={(v) => void updateSettings({ remoteImages: v })}
            label={t('mbox.settings.images')}
            options={[
              { value: 'ask', label: t('mbox.settings.imagesAsk') },
              { value: 'always', label: t('mbox.settings.imagesAlways') },
            ]}
          />
        </Row>
        <SendersRow />
      </Card>
      <Card title={t('mbox.settings.cache')} footer={t('mbox.settings.cacheHint')}>
        <Row label={t('mbox.settings.cacheLimit')}>
          <Select value={cache} onChange={(e) => void updateSettings({ cacheLimitBytes: Number(e.target.value) })} aria-label={t('mbox.settings.cacheLimit')} className="w-36">
            {[...new Set([...CACHE_LIMITS, cache])]
              .sort((a, b) => a - b)
              .map((v) => (
                <option key={v} value={v}>
                  {fmt.size(v)}
                </option>
              ))}
          </Select>
        </Row>
        <Row label={t('mbox.settings.clearCache')} hint={t('mbox.settings.clearCacheHint')}>
          <ClearCacheButton />
        </Row>
      </Card>
    </>
  );
}

/** «Очистить»: drops cached bodies and attachments of every account (headers, drafts, outbox stay). */
function ClearCacheButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const clear = async (): Promise<void> => {
    const api = mailApi();
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.settings.clearCache();
      toast.success(t('mbox.settings.cacheCleared'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" busy={busy} onClick={() => void clear()} data-testid="settings-mail-clear-cache">
      {t('mbox.settings.clear')}
    </Button>
  );
}

/** «Всегда для этого отправителя»: the list, each removable. */
function SendersRow(): ReactNode {
  const senders = useMail((s) => s.settings.remoteImageSenders);
  if (!senders.length) return null;
  return (
    <Row label={t('mbox.settings.senders')} hint={senders.join(', ')}>
      <Button size="sm" variant="ghost" onClick={() => void updateSettings({ remoteImageSenders: [] })}>
        {t('mbox.settings.clear')}
      </Button>
    </Row>
  );
}

function stateText(a: MailAccount): string | null {
  if (a.state === 'auth_failed') return t('mbox.state.authFailed');
  if (a.state === 'offline') return t('mbox.state.offline');
  if (a.state === 'error') return a.error ? mailErrorText(a.error.code) : t('mbox.state.error');
  if (a.state === 'syncing') return t('mbox.state.syncing');
  return null;
}

function AccountRows({ id }: { id: string }): ReactNode {
  const account = useMail((s) => s.accounts[id]);
  const signature = useMail((s) => s.settings.signatures[id] ?? '');
  const [password, setPassword] = useState(false);
  const [certOpen, setCertOpen] = useState<{ kind: 'imap' | 'smtp'; cert: MailCertInfo } | null>(null);
  if (!account) return null;
  const api = mailApi();
  const state = stateText(account);
  const remove = async (): Promise<void> => {
    if (!api) return;
    const ok = await confirmAction(t('mbox.settings.removeTitle', { email: account.email }), t('mbox.settings.removeText'), t('mbox.settings.remove'));
    if (!ok) return;
    try {
      await api.accounts.remove(id);
      toast.success(t('mbox.settings.removed'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div data-testid="settings-mail-account">
      <Row label={account.email} hint={state ?? `${account.imap.host} · ${account.smtp.host}`}>
        {account.state === 'auth_failed' ? <TriangleAlert className="size-4 text-warn" aria-hidden /> : null}
        <Button size="sm" variant={account.state === 'auth_failed' ? 'primary' : 'secondary'} onClick={() => setPassword(true)}>
          {t('mbox.settings.password')}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => void remove()}>
          {t('mbox.settings.remove')}
        </Button>
      </Row>
      <CertRows account={account} onShow={setCertOpen} />
      <Row label={t('mbox.settings.name')} hint={t('mbox.settings.nameHint')}>
        <CommitInput
          value={account.name}
          label={t('mbox.settings.name')}
          maxLength={120}
          onCommit={async (name) => {
            if (!api) return;
            await api.accounts.update(id, { name });
          }}
        />
      </Row>
      <Row label={t('mbox.settings.signature')}>
        <SignatureField id={id} value={signature} />
      </Row>
      {password ? <PasswordDialog account={account} onClose={() => setPassword(false)} /> : null}
      {certOpen ? <CertDialog account={account} kind={certOpen.kind} cert={certOpen.cert} onClose={() => setCertOpen(null)} /> : null}
    </div>
  );
}

/**
 * Certificates of an account (ADR-0088 §4): «Сертификат: закреплён ⋯ab12 · Сбросить» per pinned
 * server, and a certificate that stopped the sync / the last send («Сертификат сервера изменился»
 * · «Показать и доверять новому»): the account stays in `error` until it is accepted.
 */
function CertRows({ account, onShow }: { account: MailAccount; onShow: (v: { kind: 'imap' | 'smtp'; cert: MailCertInfo }) => void }): ReactNode {
  const issues = accountCertIssues(account);
  const reset = async (kind: 'imap' | 'smtp'): Promise<void> => {
    const api = mailApi();
    if (!api) return;
    try {
      await api.accounts.update(account.id, { [kind]: unpin(account[kind]) });
      toast.success(t('mbox.cert.resetDone'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const [now] = useState(() => Date.now());
  return (
    <>
      {issues.map((i) => (
        <Row key={`issue-${i.kind}`} label={i.cert.reason === 'changed' ? t('mbox.cert.changed') : certTitle(i.cert, now)} hint={`${i.cert.host}:${String(i.cert.port)}`}>
          <TriangleAlert className="size-4 text-warn" aria-hidden />
          <Button size="sm" variant="primary" onClick={() => onShow(i)} data-testid="settings-mail-cert-show">
            {i.cert.reason === 'changed' ? t('mbox.cert.showTrust') : t('mbox.cert.show')}
          </Button>
        </Row>
      ))}
      {(['imap', 'smtp'] as const).map((kind) => {
        const pin = account[kind].pinnedCert;
        if (!pin) return null;
        return (
          <Row key={`pin-${kind}`} label={t('mbox.cert.pinned', { fp: pinTail(pin) })} hint={`${account[kind].host}:${String(account[kind].port)}`}>
            <Button size="sm" variant="ghost" onClick={() => void reset(kind)} data-testid="settings-mail-cert-reset">
              {t('mbox.cert.reset')}
            </Button>
          </Row>
        );
      })}
    </>
  );
}

/** The trust prompt for an existing account: pins the shown certificate (no new login, §4). */
function CertDialog({ account, kind, cert, onClose }: { account: MailAccount; kind: 'imap' | 'smtp'; cert: MailCertInfo; onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const trust = async (): Promise<void> => {
    const api = mailApi();
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.accounts.update(account.id, { [kind]: { ...unpin(account[kind]), pinnedCert: cert.fingerprint256 } });
      toast.success(t('mbox.cert.trusted'));
      onClose();
    } catch (e) {
      setBusy(false);
      toast.error(errText(e));
    }
  };
  return (
    <Modal open onClose={onClose} title={t('mbox.cert.dialog', { server: `${cert.host}:${String(cert.port)}` })}>
      <CertNotice cert={cert} busy={busy} onTrust={() => void trust()} />
    </Modal>
  );
}

/** The plain-text signature (§8), saved on blur. */
function SignatureField({ id, value }: { id: string; value: string }): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  return (
    <textarea
      value={v}
      rows={3}
      maxLength={2000}
      aria-label={t('mbox.settings.signature')}
      placeholder={t('mbox.settings.signaturePlaceholder')}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === value) return;
        void updateSettings({ signatures: { ...useMail.getState().settings.signatures, [id]: v } });
      }}
      className="selectable w-60 resize-y rounded-[8px] border border-line bg-elev px-2 py-1 text-body text-fg shadow-[var(--shadow-card)]"
    />
  );
}

/** «Сменить пароль» (and the answer to `auth_failed`): checked by logging in, then stored by main (§3). */
function PasswordDialog({ account, onClose }: { account: MailAccount; onClose: () => void }): ReactNode {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const api = mailApi();
    if (!api || !value || busy) return;
    setBusy(true);
    try {
      await api.accounts.setPassword(account.id, value);
      toast.success(t('mbox.settings.passwordSaved'));
      onClose();
    } catch (e) {
      setBusy(false);
      setError(errText(e));
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('mbox.settings.passwordTitle', { email: account.email })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} busy={busy} disabled={!value}>
            {t('mbox.settings.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t('mbox.add.password')} error={error}>
          <PasswordInput autoFocus autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

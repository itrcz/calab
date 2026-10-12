import { Paperclip, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { isMailError, type MailAddress, type MailDraft, type MailDraftAttachment, type MailMessage } from '../../../shared/mail';
import { Button, IconButton, Input, Modal, Select, Spinner, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { mailApi, seenAddresses, useMail } from '../../stores/mail';
import { useMailUi, type ComposeRequest } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { MAIL_KEYS } from './actions';
import { AddressField } from './AddressField';
import { attachmentsSize, forwardAttachments, forwardSubject, initialText, MAX_ATTACH_BYTES, quoteLines, replyRecipients, replySubject } from './compose';
import { addressFull, addressLabel, mailErrorText, mailHeaderTime } from './format';

/** What the composer edits: a `MailDraft` plus what only the sheet needs. */
interface Form {
  id?: string;
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  ref?: MailDraft['ref'];
  attachments: MailDraftAttachment[];
}

/** The message a reply / forward quotes: the body already loaded in the thread, else fetched. */
async function original(id: string): Promise<MailMessage> {
  const have = useMail.getState().bodies[id];
  if (have) return have;
  const api = mailApi();
  if (!api) throw new Error('no mail api');
  return api.messages.get(id);
}

function defaultAccount(): string {
  const s = useMail.getState();
  return s.box.scope !== 'all' && s.accounts[s.box.scope] ? s.box.scope : (s.accountIds[0] ?? '');
}

const signatureOf = (accountId: string): string => useMail.getState().settings.signatures[accountId] ?? '';

/** The form a request opens with (Apple Mail rules, compose.ts) and the quoted original, if any. */
async function initForm(req: ComposeRequest): Promise<{ form: Form; orig: MailMessage | null }> {
  if (req.kind === 'draft') {
    const d = req.draft;
    const orig = d.ref ? await original(d.ref.messageId).catch(() => null) : null;
    return { form: { ...(d.id ? { id: d.id } : {}), accountId: d.accountId, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text, ...(d.ref ? { ref: d.ref } : {}), attachments: d.attachments }, orig };
  }
  if (req.kind === 'new') {
    const accountId = req.accountId ?? defaultAccount();
    return {
      form: { accountId, to: req.to ?? [], cc: req.cc ?? [], bcc: [], subject: req.subject ?? '', text: initialText(signatureOf(accountId), req.text ?? ''), attachments: [] },
      orig: null,
    };
  }
  const orig = await original(req.messageId);
  const s = useMail.getState();
  const mine = s.accountIds.map((id) => s.accounts[id]?.email ?? '').filter(Boolean);
  const accountId = s.accounts[orig.accountId] ? orig.accountId : defaultAccount();
  const ref = { messageId: orig.id, kind: req.kind, quote: true };
  if (req.kind === 'forward') {
    return { form: { accountId, to: [], cc: [], bcc: [], subject: forwardSubject(orig.subject), text: initialText(signatureOf(accountId)), ref, attachments: forwardAttachments(orig) }, orig };
  }
  const { to, cc } = replyRecipients(orig, mine, req.kind === 'replyAll');
  return { form: { accountId, to, cc, bcc: [], subject: replySubject(orig.subject), text: initialText(signatureOf(accountId)), ref, attachments: [] }, orig };
}

const toDraft = (f: Form): MailDraft => ({
  ...(f.id ? { id: f.id } : {}),
  accountId: f.accountId,
  to: f.to,
  cc: f.cc,
  bcc: f.bcc,
  subject: f.subject,
  text: f.text,
  ...(f.ref ? { ref: f.ref } : {}),
  attachments: f.attachments,
});

const sameForm = (a: Form, b: Form): boolean => JSON.stringify(toDraft({ ...a, attachments: [] })) === JSON.stringify(toDraft({ ...b, attachments: [] })) && a.attachments.length === b.attachments.length;

/**
 * New message / reply / forward (ADR-0088 §8): a sheet over the centre like the meeting sheet —
 * no scrim, the thread stays readable. From, To / Cc / Bcc chips, Subject, plain text with the
 * signature, the quoted original (the engine appends it on send, §6), attachments by button or drop.
 * ⌘↩ sends; closing with changes asks «Сохранить черновик?».
 */
export function ComposeSheet({ req }: { req: ComposeRequest }): ReactNode {
  const [form, setForm] = useState<Form | null>(null);
  const [orig, setOrig] = useState<MailMessage | null>(null);
  const [failed, setFailed] = useState(false);
  const [initial, setInitial] = useState<Form | null>(null);
  useEffect(() => {
    let alive = true;
    initForm(req).then(
      (r) => {
        if (!alive) return;
        setInitial(r.form);
        setForm(r.form);
        setOrig(r.orig);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [req]);
  const close = (): void => useMailUi.getState().closeCompose();
  const title = req.kind === 'reply' || req.kind === 'replyAll' ? t('mbox.replyTitle') : req.kind === 'forward' ? t('mbox.forwardTitle') : t('mbox.newMessage');
  if (failed) {
    return (
      <Modal open onClose={close} title={title} medium nonModal keepOpen={() => true}>
        <p className="text-body text-muted" role="alert">
          {t('mbox.err.notFound')}
        </p>
      </Modal>
    );
  }
  if (!form) {
    return (
      <Modal open onClose={close} title={title} medium nonModal keepOpen={() => true}>
        <div className="grid h-40 place-items-center">
          <Spinner />
        </div>
      </Modal>
    );
  }
  return <ComposeForm title={title} form={form} setForm={setForm} orig={orig} initial={initial ?? form} />;
}

function ComposeForm({ title, form, setForm, orig, initial }: { title: string; form: Form; setForm: (f: Form) => void; orig: MailMessage | null; initial: Form }): ReactNode {
  const accountIds = useMail((s) => s.accountIds);
  const accountEmail = useMail((s) => s.accounts[form.accountId]?.email ?? '');
  const [showCc, setShowCc] = useState(form.cc.length > 0);
  const [showBcc, setShowBcc] = useState(form.bcc.length > 0);
  const [busy, setBusy] = useState<'send' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [over, setOver] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Autocomplete pool, taken once: the addresses on screen and the members' known emails.
  const pool = useMemo(() => {
    const seen = seenAddresses(useMail.getState());
    const have = new Set(seen.map((a) => a.address));
    for (const u of Object.values(useWorkspaces.getState().users)) {
      const address = u.email.trim().toLowerCase();
      if (address && !have.has(address)) {
        have.add(address);
        seen.push({ name: u.displayName, address });
      }
    }
    return seen;
  }, []);
  const patch = (p: Partial<Form>): void => {
    setError(null);
    setForm({ ...form, ...p });
  };
  const dirty = !sameForm(form, initial);
  const size = attachmentsSize(form.attachments);

  // Focus on open (the sheet's initialFocus, not the «×» with its tooltip): «Кому» when empty (new /
  // forward), else the start of the text (a reply, the signature below the caret).
  const [focusTo] = useState(() => form.to.length === 0);

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    if (!list.length) return;
    const total = size + list.reduce((s, f) => s + f.size, 0);
    if (total > MAX_ATTACH_BYTES) {
      setError(t('mbox.tooBig'));
      return;
    }
    const read = await Promise.all(
      list.map(async (f, i): Promise<MailDraftAttachment> => ({ kind: 'file', id: `f${Date.now()}-${i}`, name: f.name, mime: f.type || 'application/octet-stream', size: f.size, data: new Uint8Array(await f.arrayBuffer()) })),
    );
    setForm({ ...form, attachments: [...form.attachments, ...read] });
  };

  const send = async (): Promise<void> => {
    const api = mailApi();
    if (!api || busy) return;
    if (!form.to.length && !form.cc.length && !form.bcc.length) {
      setError(t('mbox.noRecipients'));
      toRef.current?.focus();
      return;
    }
    if (size > MAX_ATTACH_BYTES) {
      setError(t('mbox.tooBig'));
      return;
    }
    setBusy('send');
    try {
      await api.compose.send(toDraft(form));
      toast.info(t('mbox.sending'));
      useMailUi.getState().closeCompose();
    } catch (e) {
      setBusy(null);
      setError(mailErrorText(isMailError(e) ? e.code : 'ENGINE_DOWN'));
    }
  };

  const saveDraft = async (): Promise<void> => {
    const api = mailApi();
    if (!api) return;
    setBusy('save');
    try {
      await api.drafts.save(toDraft(form));
      toast.success(t('mbox.draftSaved'));
      useMailUi.getState().closeCompose();
    } catch (e) {
      setBusy(null);
      setAsking(false);
      setError(mailErrorText(isMailError(e) ? e.code : 'ENGINE_DOWN'));
    }
  };

  const requestClose = (): void => {
    if (busy) return;
    if (dirty) setAsking(true);
    else useMailUi.getState().closeCompose();
  };

  const onDrop = (e: DragEvent): void => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setOver(false);
    void addFiles(e.dataTransfer.files);
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        title={title}
        medium
        nonModal
        keepOpen={() => true}
        initialFocus={focusTo ? toRef : textRef}
        footer={
          <>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }} />
            <Button variant="ghost" className="mr-auto" onClick={() => fileRef.current?.click()} data-testid="compose-attach">
              <Paperclip className="size-4" aria-hidden />
              {t('mbox.attach')}
            </Button>
            <Tip label={t('mbox.send')} shortcut={MAIL_KEYS.send}>
              <Button onClick={() => void send()} busy={busy === 'send'} data-testid="compose-send">
                {t('mbox.send')}
              </Button>
            </Tip>
          </>
        }
      >
        <div
          className={cx('relative flex flex-col', over && 'rounded-[8px] outline-dashed outline-2 outline-offset-4 outline-[var(--color-accent)]')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setOver(false);
          }}
          onDrop={onDrop}
          data-testid="compose-sheet"
        >
          {accountIds.length > 1 ? (
            <label className="flex min-h-10 items-center gap-1 border-b border-line py-1.5">
              <span className="w-16 shrink-0 text-body text-muted">{t('mbox.from')}</span>
              <Select
                value={form.accountId}
                onChange={(e) => patch({ accountId: e.target.value })}
                aria-label={t('mbox.from')}
                className="w-auto max-w-full border-0 bg-transparent shadow-none"
              >
                {accountIds.map((id) => (
                  <AccountOption key={id} id={id} />
                ))}
              </Select>
            </label>
          ) : null}
          <AddressField
            label={t('mbox.to')}
            value={form.to}
            onChange={(to) => patch({ to })}
            pool={pool}
            inputRef={toRef}
            testId="compose-to"
            trailing={
              <span className="ml-auto flex shrink-0 gap-1">
                {showCc ? null : (
                  <button type="button" className="text-caption text-muted hover:text-fg" onClick={() => setShowCc(true)}>
                    {t('mbox.cc')}
                  </button>
                )}
                {showBcc ? null : (
                  <button type="button" className="text-caption text-muted hover:text-fg" onClick={() => setShowBcc(true)}>
                    {t('mbox.bcc')}
                  </button>
                )}
              </span>
            }
          />
          {showCc ? <AddressField label={t('mbox.cc')} value={form.cc} onChange={(cc) => patch({ cc })} pool={pool} testId="compose-cc" /> : null}
          {showBcc ? <AddressField label={t('mbox.bcc')} value={form.bcc} onChange={(bcc) => patch({ bcc })} pool={pool} testId="compose-bcc" /> : null}
          <label className="flex min-h-10 items-center gap-1 border-b border-line py-1.5">
            <span className="w-16 shrink-0 text-body text-muted">{t('mbox.subject')}</span>
            <Input value={form.subject} onChange={(e) => patch({ subject: e.target.value })} aria-label={t('mbox.subject')} className="h-6 border-0 bg-transparent px-0 shadow-none" data-testid="compose-subject" />
          </label>
          {accountIds.length <= 1 && accountEmail ? <span className="sr-only">{t('mbox.fromLine', { email: accountEmail })}</span> : null}
          <textarea
            ref={textRef}
            value={form.text}
            onChange={(e) => patch({ text: e.target.value })}
            aria-label={t('mbox.editor')}
            spellCheck
            className="selectable mt-3 min-h-[200px] w-full resize-y bg-transparent text-[14px] leading-[1.5] text-fg outline-none"
            data-testid="compose-text"
            onFocus={(e) => {
              // The first focus lands before the signature, not after it.
              if (e.currentTarget.selectionStart === e.currentTarget.value.length && e.currentTarget.value.startsWith('\n')) e.currentTarget.setSelectionRange(0, 0);
            }}
          />
          {form.ref?.quote && orig ? <QuotePreview orig={orig} kind={form.ref.kind} onRemove={() => form.ref && patch({ ref: { ...form.ref, quote: false } })} /> : null}
          {form.attachments.length ? (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t('mbox.attach')}>
              {form.attachments.map((a) => (
                <li key={a.id} className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full bg-hover pl-2.5 pr-1 text-caption text-fg">
                  <Paperclip className="size-3 shrink-0 text-muted" aria-hidden />
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-muted">{fmt.size(a.size)}</span>
                  <IconButton label={t('mbox.removeAttachment', { name: a.name })} size="sm" tip={false} className="size-5" onClick={() => patch({ attachments: form.attachments.filter((x) => x.id !== a.id) })}>
                    <X className="size-3" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p className="mt-3 text-caption text-danger-text" role="alert" data-testid="compose-error">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title={t('mbox.saveDraft.title')}
        description={t('mbox.saveDraft.text')}
        closeButton={false}
        footer={
          <>
            <Button variant="destructive" className="mr-auto" onClick={() => useMailUi.getState().closeCompose()} data-testid="compose-discard">
              {t('mbox.saveDraft.discard')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void saveDraft()} busy={busy === 'save'} autoFocus data-testid="compose-save-draft">
              {t('mbox.saveDraft.save')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}

function AccountOption({ id }: { id: string }): ReactNode {
  const a = useMail((s) => s.accounts[id]);
  if (!a) return null;
  return <option value={id}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>;
}

/** The original as the engine will quote it (§6): `> ` lines under «date, name:», or the forward header. */
function QuotePreview({ orig, kind, onRemove }: { orig: MailMessage; kind: 'reply' | 'replyAll' | 'forward'; onRemove: () => void }): ReactNode {
  const text = orig.text ?? orig.snippet;
  const head =
    kind === 'forward'
      ? [
          t('mbox.fwdHeader'),
          `${t('mbox.from')}: ${addressFull(orig.from)}`,
          `${t('mbox.date')}: ${mailHeaderTime(orig.date)}`,
          `${t('mbox.subject')}: ${orig.subject}`,
          `${t('mbox.to')}: ${orig.to.map(addressFull).join(', ')}`,
        ].join('\n')
      : t('mbox.quoteWrote', { date: mailHeaderTime(orig.date), name: addressLabel(orig.from) });
  return (
    <div className="group relative mt-3 rounded-[8px] bg-hover px-3 py-2" data-testid="compose-quote">
      <IconButton label={t('mbox.removeQuote')} size="sm" className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onRemove}>
        <X className="size-3.5" />
      </IconButton>
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-caption text-muted">
        {head}
        {'\n'}
        {kind === 'forward' ? `\n${text}` : quoteLines(text)}
      </pre>
    </div>
  );
}

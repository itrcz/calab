import { Paperclip } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isMailError, type MailDraftAttachment, type MailMessage } from '../../../shared/mail';
import { Button, Input, Modal, Select, Spinner, Tip } from '../../components/ui';
import { t } from '../../i18n';
import { mailApi, seenAddresses, useMail } from '../../stores/mail';
import { useMailUi, type ComposeRequest } from '../../stores/mailUi';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { MAIL_KEYS } from './actions';
import { AddressField } from './AddressField';
import { attachmentsSize, fitsAttachments, forwardAttachments, forwardSubject, inlineImages, MAX_ATTACH_BYTES, replyRecipients, replySubject } from './compose';
import { ComposeAttachments } from './ComposeAttachments';
import { ComposeEditor } from './ComposeEditor';
import { draftFrom, initialEditorHtml, quoteBlock, sanitizeForEditor, type ComposeFields } from './editor';
import { mailErrorText } from './format';

type Form = ComposeFields;

interface Init {
  form: Form;
  /** The editor's starting HTML (sanitized). */
  html: string;
  /** A forward's inline images by their editor URL (carried as attachments when still in the text). */
  inline: Map<string, MailDraftAttachment>;
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

/** The original quoted in the editor: sanitized, remote images blocked, `cid:` via the attachment URL. */
function quoteOf(orig: MailMessage, kind: 'reply' | 'replyAll' | 'forward'): string {
  const api = mailApi();
  const cid = (contentId: string): string | null => {
    const a = orig.attachments.find((x) => x.cid === contentId && x.mime.startsWith('image/'));
    return a && api ? api.attachmentUrl(orig.id, a.id) : null;
  };
  return quoteBlock(orig, kind, { remote: false, cid });
}

const inlineOf = (orig: MailMessage | null, kind: string | undefined): Map<string, MailDraftAttachment> => {
  const api = mailApi();
  if (!orig || !api || kind !== 'forward') return new Map<string, MailDraftAttachment>();
  return inlineImages(orig, (m, a) => api.attachmentUrl(m, a));
};

/** The form a request opens with (Apple Mail rules, compose.ts) and the editor's content. */
async function initForm(req: ComposeRequest): Promise<Init> {
  if (req.kind === 'draft') {
    const d = req.draft;
    const orig = d.ref ? await original(d.ref.messageId).catch(() => null) : null;
    // A draft saved by this composer keeps its HTML (quote included); an older one had the quote
    // appended by the engine (`ref.quote`) — it now goes into the editor.
    const html =
      d.html !== undefined
        ? sanitizeForEditor(d.html, { remote: false, cid: () => null, local: true })
        : initialEditorHtml({ text: d.text, ...(d.ref?.quote && orig ? { quote: quoteOf(orig, d.ref.kind) } : {}) });
    const ref = d.ref ? { ...d.ref, quote: false } : undefined;
    return {
      form: { ...(d.id ? { id: d.id } : {}), accountId: d.accountId, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, ...(ref ? { ref } : {}), attachments: d.attachments },
      html,
      inline: inlineOf(orig, d.ref?.kind),
    };
  }
  if (req.kind === 'new') {
    const accountId = req.accountId ?? defaultAccount();
    return {
      form: { accountId, to: req.to ?? [], cc: req.cc ?? [], bcc: [], subject: req.subject ?? '', attachments: [] },
      html: initialEditorHtml({ ...(req.text ? { text: req.text } : {}), signature: signatureOf(accountId) }),
      inline: new Map(),
    };
  }
  const orig = await original(req.messageId);
  const s = useMail.getState();
  const mine = s.accountIds.map((id) => s.accounts[id]?.email ?? '').filter(Boolean);
  const accountId = s.accounts[orig.accountId] ? orig.accountId : defaultAccount();
  // The quote is in the editor (sent as `html`), so the engine must not append it again.
  const ref = { messageId: orig.id, kind: req.kind, quote: false };
  const html = initialEditorHtml({ signature: signatureOf(accountId), quote: quoteOf(orig, req.kind) });
  if (req.kind === 'forward') {
    return { form: { accountId, to: [], cc: [], bcc: [], subject: forwardSubject(orig.subject), ref, attachments: forwardAttachments(orig) }, html, inline: inlineOf(orig, 'forward') };
  }
  const { to, cc } = replyRecipients(orig, mine, req.kind === 'replyAll');
  return { form: { accountId, to, cc, bcc: [], subject: replySubject(orig.subject), ref, attachments: [] }, html, inline: new Map() };
}

const sameForm = (a: Form, b: Form): boolean =>
  JSON.stringify({ ...a, attachments: a.attachments.map((x) => x.id) }) === JSON.stringify({ ...b, attachments: b.attachments.map((x) => x.id) });

/**
 * New message / reply / forward (ADR-0088 §8, owner 12.10): a sheet over the centre like the meeting
 * sheet — no scrim, the thread stays readable. From, To / Cc / Bcc chips, Subject, the attachment
 * strip, then one editor with the typed text, the signature and the quoted original (editable, like
 * Apple Mail). Files by button, paste or drop anywhere on the sheet. ⌘↩ sends; closing with changes
 * asks «Сохранить черновик?».
 */
export function ComposeSheet({ req }: { req: ComposeRequest }): ReactNode {
  const [init, setInit] = useState<Init | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    initForm(req).then(
      (r) => alive && setInit(r),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [req]);
  const close = (): void => useMailUi.getState().closeCompose();
  const title = req.kind === 'reply' || req.kind === 'replyAll' ? t('mbox.replyTitle') : req.kind === 'forward' ? t('mbox.forwardTitle') : t('mbox.newMessage');
  if (failed || !init) {
    return (
      <Modal open onClose={close} title={title} medium nonModal keepOpen={() => true}>
        {failed ? (
          <p className="text-body text-muted" role="alert">
            {t('mbox.err.notFound')}
          </p>
        ) : (
          <div className="grid h-40 place-items-center">
            <Spinner />
          </div>
        )}
      </Modal>
    );
  }
  return <ComposeForm title={title} init={init} />;
}

function ComposeForm({ title, init }: { title: string; init: Init }): ReactNode {
  const [form, setForm] = useState<Form>(init.form);
  const accountIds = useMail((s) => s.accountIds);
  const accountEmail = useMail((s) => s.accounts[form.accountId]?.email ?? '');
  const [showCc, setShowCc] = useState(form.cc.length > 0);
  const [showBcc, setShowBcc] = useState(form.bcc.length > 0);
  const [busy, setBusy] = useState<'send' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachError, setAttachError] = useState(false);
  const [asking, setAsking] = useState(false);
  // The editor is uncontrolled: one flag when it is first edited (no re-render per keystroke).
  const [edited, setEdited] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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
    setForm((f) => ({ ...f, ...p }));
  };
  const dirty = edited || !sameForm(form, init.form);

  // Focus on open: «Кому» when empty (new / forward), else the editor — its caret on the top line.
  const [focusTo] = useState(() => form.to.length === 0);

  // Latest form / adder for the native drop listener and the editor's paste (registered once).
  const formRef = useRef(form);
  useLayoutEffect(() => {
    formRef.current = form;
  }, [form]);

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    if (!list.length) return;
    if (!fitsAttachments(formRef.current.attachments, list.map((f) => f.size)).ok) {
      setAttachError(true);
      return;
    }
    setAttachError(false);
    const read = await Promise.all(
      list.map(async (f, i): Promise<MailDraftAttachment> => ({ kind: 'file', id: `f${Date.now()}-${i}`, name: f.name, mime: f.type || 'application/octet-stream', size: f.size, data: new Uint8Array(await f.arrayBuffer()) })),
    );
    setForm((f) => ({ ...f, attachments: [...f.attachments, ...read] }));
  };
  const addFilesRef = useRef(addFiles);
  useLayoutEffect(() => {
    addFilesRef.current = addFiles;
  });
  const onPasteFiles = useCallback((files: File[]) => void addFilesRef.current(files), []);

  // Files dropped anywhere on the sheet (the dialog, footer included): captured before the editor
  // could insert them; the sheet's outline shows the drop target.
  useEffect(() => {
    const sheet = boxRef.current?.closest<HTMLElement>('[role="dialog"]');
    if (!sheet) return;
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const mark = (on: boolean): void => {
      sheet.style.outline = on ? '2px dashed var(--color-accent)' : '';
      sheet.style.outlineOffset = on ? '-6px' : '';
    };
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      mark(true);
    };
    const leave = (e: DragEvent): void => {
      if (!(e.relatedTarget instanceof Node) || !sheet.contains(e.relatedTarget)) mark(false);
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      mark(false);
      if (e.dataTransfer?.files.length) void addFilesRef.current(e.dataTransfer.files);
    };
    sheet.addEventListener('dragover', over, true);
    sheet.addEventListener('dragleave', leave, true);
    sheet.addEventListener('drop', drop, true);
    return () => {
      sheet.removeEventListener('dragover', over, true);
      sheet.removeEventListener('dragleave', leave, true);
      sheet.removeEventListener('drop', drop, true);
      mark(false);
    };
  }, []);

  const editorHtml = (): string => editorRef.current?.innerHTML ?? '';

  const send = async (): Promise<void> => {
    const api = mailApi();
    if (!api || busy) return;
    if (!form.to.length && !form.cc.length && !form.bcc.length) {
      setError(t('mbox.noRecipients'));
      toRef.current?.focus();
      return;
    }
    const draft = draftFrom(form, editorHtml(), init.inline, true);
    if (attachmentsSize(draft.attachments) > MAX_ATTACH_BYTES) {
      setAttachError(true);
      return;
    }
    setBusy('send');
    try {
      await api.compose.send(draft);
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
      await api.drafts.save(draftFrom(form, editorHtml(), init.inline, false));
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

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        title={title}
        medium
        nonModal
        keepOpen={() => true}
        initialFocus={focusTo ? toRef : editorRef}
        footer={
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
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
          ref={boxRef}
          className="relative flex flex-col"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="compose-sheet"
        >
          {accountIds.length > 1 ? (
            <label className="flex min-h-10 items-center gap-1 border-b border-line py-1.5">
              <span className="w-16 shrink-0 text-body text-muted">{t('mbox.from')}</span>
              <Select value={form.accountId} onChange={(e) => patch({ accountId: e.target.value })} aria-label={t('mbox.from')} className="w-auto max-w-full border-0 bg-transparent shadow-none">
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
          <ComposeAttachments
            list={form.attachments}
            overLimit={attachError}
            onRemove={(id) => {
              setAttachError(false);
              setForm((f) => ({ ...f, attachments: f.attachments.filter((x) => x.id !== id) }));
            }}
          />
          <ComposeEditor initialHtml={init.html} editorRef={editorRef} onEdited={setEdited} onFiles={onPasteFiles} />
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

import { create } from '@bufbuild/protobuf';
import { SipContactPhoneSchema, SipPhoneLabel, type SipContact } from '@calaba/protocol';
import { Plus, Trash2, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Choice } from '../../../components/Choice';
import { PhoneHeader } from '../../../components/PhoneHeader';
import { Button, Field, IconButton, Input, Modal, Select, Spinner, TextArea, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { formatNumberInput, formatPhone, maskEdit } from '../../../lib/sip';
import { openTab, phoneBack } from '../../../services/phoneNav';
import { useTelContacts, type ContactPrefill } from '../../../stores/telContacts';
import { useMayDeleteContact } from '../access';
import { confirmDelete } from './ContactsList';
import { formToContact, saveContact, saveErrorOf, useContact, type ContactDraft, type SaveError } from './data';
import { PHONE_LABELS, labelKey } from './model';
import { asEnum } from '../../../lib/enums';

/**
 * A contact's form (ADR-0137 §6 desktop — a Modal; §7 phone — a screen: several fields): name,
 * company, the numbers (the label — a select / the phone's picker —, the masked number, ×), «Добавить
 * номер», the note. Errors under their field; a number another contact has —
 * «Номер уже у «ООО Ромашка»» with a link to that contact. The phone's «Сохранить» is a sticky
 * full-width button that rides above the keyboard (the shell ends at it, lib/mobile.ts).
 */

const MAX_PHONES = 10;

interface Row {
  key: number;
  number: string;
  label: SipPhoneLabel;
}

let rowSeq = 0;
const row = (number = '', label: SipPhoneLabel = SipPhoneLabel.MOBILE): Row => ({ key: ++rowSeq, number, label });

function initial(c: SipContact | undefined, prefill: ContactPrefill | undefined): { name: string; company: string; note: string; rows: Row[] } {
  if (c) return { name: c.name, company: c.company, note: c.note, rows: c.phones.length ? c.phones.map((p) => row(formatPhone(p.number), p.label || SipPhoneLabel.OTHER)) : [row()] };
  return { name: prefill?.name ?? '', company: '', note: '', rows: [row(prefill?.number ? formatNumberInput(prefill.number) : '')] };
}

/** Desktop: the Modal over «Телефония» (stores/telContacts `form`). */
export function ContactFormModal({ ws }: { ws: string }): ReactNode {
  const form = useTelContacts((s) => s.form);
  if (!form) return null;
  return <DesktopForm key={form.id || 'new'} ws={ws} id={form.id} prefill={form.prefill} />;
}

function DesktopForm({ ws, id, prefill }: { ws: string; id: string; prefill: ContactPrefill | undefined }): ReactNode {
  useLocale();
  const q = useContact(ws, id);
  const close = (): void => useTelContacts.getState().openForm(null);
  const title = id ? t('telc.editTitle') : t('telc.newTitle');
  if (id && !q.data?.contact) {
    return (
      <Modal open onClose={close} title={title}>
        <div className="grid place-items-center py-8">{q.isError ? <span className="text-danger-text">{t('telc.cardFailed')}</span> : <Spinner />}</div>
      </Modal>
    );
  }
  return <FormBody ws={ws} id={id} contact={q.data?.contact} prefill={prefill} phone={false} onDone={close} />;
}

/** Phone: the pushed screen (its prefill is in stores/telContacts). */
export function PhoneContactEdit({ ws, id }: { ws: string; id: string }): ReactNode {
  useLocale();
  const q = useContact(ws, id);
  const prefill = useTelContacts((s) => s.form?.prefill);
  const title = id ? t('telc.editTitle') : t('telc.newTitle');
  if (id && !q.data?.contact) {
    return (
      <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="telc-form">
        <PhoneHeader title={title} />
        <div className="grid flex-1 place-items-center">{q.isError ? <span className="text-danger-text">{t('telc.cardFailed')}</span> : <Spinner />}</div>
      </section>
    );
  }
  return <FormBody ws={ws} id={id} contact={q.data?.contact} prefill={prefill} phone onDone={phoneBack} />;
}

function FormBody({ ws, id, contact, prefill, phone, onDone }: { ws: string; id: string; contact: SipContact | undefined; prefill: ContactPrefill | undefined; phone: boolean; onDone: () => void }): ReactNode {
  const [init] = useState(() => initial(contact, prefill));
  const [name, setName] = useState(init.name);
  const [company, setCompany] = useState(init.company);
  const [note, setNote] = useState(init.note);
  const [rows, setRows] = useState<Row[]>(init.rows);
  const [err, setErr] = useState<SaveError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const del = useMayDeleteContact(ws, contact?.createdBy ?? '');
  const title = id ? t('telc.editTitle') : t('telc.newTitle');
  const empty = !name.trim() && !company.trim();

  const save = async (): Promise<void> => {
    if (busy) return;
    if (empty) {
      setErr({ field: 'name', text: t('telc.err.nameOrCompany') });
      return;
    }
    setBusy(true);
    setErr(null);
    const d: ContactDraft = { name, company, note, phones: rows.filter((r) => r.number.trim()).map((r) => create(SipContactPhoneSchema, { number: r.number, label: r.label })) };
    try {
      const saved = await saveContact(ws, id, d);
      // A new contact opens its card (the desktop's panel; the phone swaps the form for it).
      if (!id && saved) formToContact(saved.id);
      else onDone();
    } catch (e) {
      setErr(saveErrorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const setRow = (key: number, patch: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const fields = (
    <div className={cx('flex flex-col', phone ? 'gap-4' : 'gap-3')} data-testid="telc-form-fields">
      <Field label={t('telc.f.name')} error={err?.field === 'name' ? err.text : null}>
        <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={128} autoComplete="off" data-testid="telc-f-name" className={phone ? 'text-[16px]' : undefined} />
      </Field>
      <Field label={t('telc.f.company')} error={err?.field === 'company' ? err.text : null}>
        <Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={128} autoComplete="off" data-testid="telc-f-company" className={phone ? 'text-[16px]' : undefined} />
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-2" data-testid="telc-f-phones">
        <legend className="mb-1 text-caption font-medium text-muted">{t('telc.numbers')}</legend>
        {rows.map((r, i) => {
          const number = (
            <Input
              type="tel"
              inputMode="tel"
              value={r.number}
              onChange={(e) => setRow(r.key, { number: maskEdit(r.number, e.target.value) })}
              placeholder="+7 900 000-00-00"
              aria-label={t('telc.f.number', { n: i + 1 })}
              autoComplete="off"
              className={cx('min-w-0 flex-1 tabular-nums', phone && 'text-[16px]')}
              data-testid="telc-f-number"
            />
          );
          const remove = (
            <IconButton label={t('telc.f.removeNumber')} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [row()]))} className="shrink-0 mobile:tap-size">
              <X className="size-4" aria-hidden />
            </IconButton>
          );
          // Phone: the label and × over the number on all the width (375 px: «+7 916 123-45-67» never cut).
          return phone ? (
            <div key={r.key} className="flex min-w-0 flex-col gap-1" data-testid="telc-f-phone">
              <div className="flex items-center justify-between gap-2">
                <Choice
                  value={String(r.label)}
                  options={PHONE_LABELS.map((l) => ({ value: String(l), label: t(labelKey(l)) }))}
                  onChange={(v) => setRow(r.key, { label: asEnum(SipPhoneLabel, Number(v)) })}
                  label={`${t('telc.f.label')}: ${t(labelKey(r.label))}`}
                  phone="picker"
                />
                {remove}
              </div>
              {number}
            </div>
          ) : (
            <div key={r.key} className="flex min-w-0 items-center gap-2" data-testid="telc-f-phone">
              <Select value={String(r.label)} onChange={(e) => setRow(r.key, { label: asEnum(SipPhoneLabel, Number(e.target.value)) })} aria-label={t('telc.f.label')} className="w-[128px] shrink-0">
                {PHONE_LABELS.map((l) => (
                  <option key={l} value={String(l)}>
                    {t(labelKey(l))}
                  </option>
                ))}
              </Select>
              {number}
              {remove}
            </div>
          );
        })}
        {err?.field === 'phones' ? (
          <div role="alert" data-testid="telc-f-phones-error">
            {err.taken?.id ? (
              // The whole sentence opens that contact: a 44 px target on the phone, the name wraps inside it.
              <button
                type="button"
                className="block w-full text-left text-caption text-danger-text mobile:min-h-11"
                onClick={() => formToContact(err.taken?.id ?? '')}
                data-testid="telc-f-taken-link"
              >
                {t('telc.err.numberTakenPrefix')} <span className="font-medium underline">«{err.taken.name}»</span>
              </button>
            ) : (
              <p className="text-caption text-danger-text">{err.text}</p>
            )}
          </div>
        ) : null}
        {rows.length < MAX_PHONES ? (
          <button type="button" className="flex h-9 items-center gap-1.5 self-start rounded-full px-1 text-body font-medium text-accent-text hover:underline mobile:tap-h" onClick={() => setRows((rs) => [...rs, row('', SipPhoneLabel.WORK)])} data-testid="telc-f-add-number">
            <Plus className="size-4" aria-hidden />
            {t('telc.f.addNumber')}
          </button>
        ) : null}
      </fieldset>
      <Field label={t('telc.note')} error={err?.field === 'note' ? err.text : null}>
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} className={cx('resize-none', phone && 'text-[16px]')} data-testid="telc-f-note" />
      </Field>
      {err && !err.field ? (
        <p className="text-caption text-danger-text" role="alert">
          {err.text}
        </p>
      ) : null}
      {phone && id && del && contact ? (
        <Button variant="destructive" className="mt-2 w-full" onClick={() => void confirmDelete(ws, contact).then((ok) => ok && openTab('telephony'))} data-testid="telc-f-delete">
          <Trash2 className="size-4" aria-hidden /> {t('telc.deleteContact')}
        </Button>
      ) : null}
    </div>
  );

  if (phone) {
    return (
      <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="telc-form">
        <PhoneHeader title={title} />
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4">{fields}</div>
          <div className="mat-toolbar shrink-0 border-t border-line px-4 pb-[calc(var(--safe-bottom,0px)+12px)] pt-3">
            <Button type="submit" busy={busy} className="w-full" data-testid="telc-f-save">
              {t('common.save')}
            </Button>
          </div>
        </form>
      </section>
    );
  }
  return (
    <Modal
      open
      onClose={onDone}
      title={title}
      initialFocus={nameRef}
      footer={
        <>
          {id && del && contact ? (
            <Button variant="destructive" className="mr-auto" onClick={() => void confirmDelete(ws, contact).then((ok) => ok && onDone())} data-testid="telc-f-delete">
              {t('telc.delete')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void save()} data-testid="telc-f-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        data-testid="telc-form"
      >
        {fields}
      </form>
    </Modal>
  );
}

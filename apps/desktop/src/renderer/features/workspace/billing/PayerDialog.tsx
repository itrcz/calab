import {
  PayerFieldInput,
  PayerType,
  checkPayer,
  payerFields,
  payerTypes,
  type PayerFieldSpec,
  type PayerProfile,
  type PayerSchema,
} from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal, Segmented, Spinner, cx } from '../../../components/ui';
import { getLocale, t } from '../../../i18n';
import { ApiError } from '../../../lib/api/client';
import { billingErrorText } from '../../../lib/billing/errors';
import { defaultCountry, fieldHint, fieldTitle, nameLabel, payerTypeLabel, problemKey, reasonText } from '../../../lib/billing/payer';
import { ownerBilling, reloadBilling } from '../../../services/billing';
import { toast } from '../../../stores/toasts';
import { CountrySelect } from './CountrySelect';

/**
 * The payer form (ADR-0080 §6.4 and its amendment §0.1): country → payer type → the requisites of
 * that country and type, all from the server's schema (GET …/billing/payer-schema), checked inline
 * by the same rules as the server (@calaba/protocol payer.ts). The server is the judge: its 422
 * names the field and the reason, shown under that field. The country never changes the account's
 * market (ADR-0080 §2.1); a new payer starts from the account's market / the system language.
 */

/** The schema is the same for every account and changes only with a server release. */
const SCHEMA_KEY = ['billing', 'payer-schema'] as const;

export function PayerDialog({
  workspaceId,
  payer,
  market,
  onClose,
}: {
  workspaceId: string;
  payer: PayerProfile | undefined;
  market: string;
  onClose: () => void;
}): ReactNode {
  const schema = useQuery({
    queryKey: SCHEMA_KEY,
    queryFn: ({ signal }) => ownerBilling.payerSchema(workspaceId, signal),
    staleTime: Infinity,
    retry: 1,
  });
  if (schema.data) return <PayerForm workspaceId={workspaceId} payer={payer} market={market} schema={schema.data} onClose={onClose} />;
  return (
    <Modal
      open
      initialFocus="body"
      onClose={onClose}
      title={t('billing.payer.title')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      }
    >
      <div className="grid min-h-24 place-items-center gap-2 text-center" data-testid="billing-payer-form">
        {schema.isError ? (
          <>
            <p className="text-body text-muted">{t('billing.payer.loadFailed')}</p>
            <Button size="sm" variant="secondary" onClick={() => void schema.refetch()}>
              {t('common.retry')}
            </Button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    </Modal>
  );
}

const TYPE_VALUE: Record<PayerType, string> = {
  [PayerType.UNSPECIFIED]: 'UNSPECIFIED',
  [PayerType.PERSON]: 'PERSON',
  [PayerType.COMPANY]: 'COMPANY',
  [PayerType.SOLE_PROPRIETOR]: 'SOLE_PROPRIETOR',
};
const typeOf = (v: string): PayerType => PayerType[v as keyof typeof PayerType];

/** The type to show for a country: the wanted one when offered, else a company, else the first. */
function offeredType(schema: PayerSchema, country: string, want: PayerType): PayerType {
  const types = payerTypes(schema, country);
  if (types.includes(want)) return want;
  return types.includes(PayerType.COMPANY) ? PayerType.COMPANY : (types[0] ?? PayerType.PERSON);
}

/** The values a saved payer starts the form with; a payer from before the requisites has only tax_id. */
function initialRequisites(schema: PayerSchema, payer: PayerProfile | undefined, country: string, type: PayerType): Record<string, string> {
  const out: Record<string, string> = { ...payer?.requisites };
  const primary = payerFields(schema, country, type)?.find((f) => f.primary);
  if (payer?.taxId && primary && !out[primary.key]) out[primary.key] = payer.taxId;
  return out;
}

function PayerForm({
  workspaceId,
  payer,
  market,
  schema,
  onClose,
}: {
  workspaceId: string;
  payer: PayerProfile | undefined;
  market: string;
  schema: PayerSchema;
  onClose: () => void;
}): ReactNode {
  const [country, setCountry] = useState(() =>
    payer?.country && schema.allCountries.includes(payer.country) ? payer.country : defaultCountry(market, getLocale(), navigator.languages, schema.allCountries),
  );
  const [type, setType] = useState(() => offeredType(schema, country, payer?.type || PayerType.COMPANY));
  const [name, setName] = useState(payer?.name ?? '');
  const [email, setEmail] = useState(payer?.email ?? '');
  const [requisites, setRequisites] = useState(() => initialRequisites(schema, payer, country, type));
  // A field's error shows once the field was left (or after «Сохранить»): never while typing the first time.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<{ field: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLDivElement>(null);

  const types = useMemo(() => payerTypes(schema, country), [schema, country]);
  const fields = useMemo(() => payerFields(schema, country, type) ?? [], [schema, country, type]);
  const checked = useMemo(() => checkPayer(schema, { type, name, country, email, requisites }), [schema, type, name, country, email, requisites]);
  const errorOf = (key: string): string | null => {
    if (server && problemKey(server.field) === key) return reasonText(server.reason, server.field);
    if (!submitted && !touched.has(key)) return null;
    const p = checked.problems.find((x) => problemKey(x.field) === key);
    return p ? reasonText(p.reason, p.field) : null;
  };

  const clearServer = useCallback((key: string) => setServer((s) => (s && problemKey(s.field) === key ? null : s)), []);
  const onRequisite = useCallback(
    (key: string, value: string) => {
      setRequisites((r) => ({ ...r, [key]: value }));
      clearServer(key);
    },
    [clearServer],
  );
  const onBlur = useCallback((key: string) => setTouched((s) => (s.has(key) ? s : new Set(s).add(key))), []);
  // Requisites belong to their country: another country starts empty (the saved payer's own
  // country gets its saved values back).
  const onCountry = useCallback(
    (c: string) => {
      const ty = offeredType(schema, c, type);
      setCountry(c);
      setType(ty);
      setRequisites(c === payer?.country ? initialRequisites(schema, payer, c, ty) : {});
      setTouched(new Set());
      setServer(null);
    },
    [schema, type, payer],
  );
  const typeOptions = useMemo(() => types.map((ty) => ({ value: TYPE_VALUE[ty], label: payerTypeLabel(ty) })), [types]);
  const onType = useCallback((v: string) => setType(typeOf(v)), []);

  const save = async (): Promise<void> => {
    setSubmitted(true);
    setError(null);
    const first = checked.problems[0];
    if (first || !checked.payer) {
      if (first) form.current?.querySelector<HTMLElement>(`[data-payer-field="${problemKey(first.field)}"]`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const saved = await ownerBilling.putPayer(workspaceId, checked.payer);
      if (saved.syncWarning === 'TAX_ID_REJECTED') toast.info(t('billing.payer.warn.taxId'));
      else if (saved.syncWarning) toast.info(t('billing.payer.warn.provider'));
      else toast.success(t('billing.payer.saved'));
      reloadBilling(workspaceId);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.field?.startsWith('payer.') && e.reason?.startsWith('PAYER_')) {
        setServer({ field: e.field, reason: e.reason });
        form.current?.querySelector<HTMLElement>(`[data-payer-field="${problemKey(e.field)}"]`)?.focus();
      } else setError(billingErrorText(e, t('err.ctx.save')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      initialFocus="body"
      onClose={onClose}
      title={t('billing.payer.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void save()} data-testid="billing-payer-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div ref={form} className="flex flex-col gap-3" data-testid="billing-payer-form">
        <Field label={t('billing.payer.country')} error={errorOf('payer.country')}>
          <CountrySelect label={t('billing.payer.country')} value={country} codes={schema.allCountries} onChange={onCountry} invalid={!!errorOf('payer.country')} />
        </Field>
        {types.length > 1 ? (
          <div className="flex flex-col gap-1">
            <span className="text-caption font-medium text-muted" aria-hidden>
              {t('billing.payer.type')}
            </span>
            <Segmented label={t('billing.payer.type')} value={TYPE_VALUE[type]} onChange={onType} options={typeOptions} fill testId="billing-payer-type" />
          </div>
        ) : null}
        <Field label={nameLabel(type)} error={errorOf('payer.name')}>
          <Input
            value={name}
            maxLength={200}
            autoComplete={type === PayerType.PERSON ? 'name' : 'organization'}
            data-payer-field="payer.name"
            aria-invalid={!!errorOf('payer.name') || undefined}
            className={cx(errorOf('payer.name') && 'border-danger')}
            onChange={(e) => {
              setName(e.target.value);
              clearServer('payer.name');
            }}
            onBlur={() => onBlur('payer.name')}
          />
        </Field>
        {fields.map((f) => (
          <RequisiteField key={`${country}:${f.key}`} f={f} value={requisites[f.key] ?? ''} error={errorOf(f.key)} onChange={onRequisite} onBlur={onBlur} />
        ))}
        <Field label={t('billing.payer.email')} error={errorOf('payer.email')}>
          <Input
            type="email"
            value={email}
            maxLength={254}
            autoComplete="email"
            data-payer-field="payer.email"
            aria-invalid={!!errorOf('payer.email') || undefined}
            className={cx(errorOf('payer.email') && 'border-danger')}
            onChange={(e) => {
              setEmail(e.target.value);
              clearServer('payer.email');
            }}
            onBlur={() => onBlur('payer.email')}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-caption text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * One requisite: label (with «необязательно»), the example as the placeholder, a format hint, the
 * error once left. Digits get the numeric keyboard on phones, codes the upper-case one; the raw
 * text may carry spaces and dashes (the rules drop them), so the limit leaves room for them.
 */
const RequisiteField = memo(function RequisiteField({
  f,
  value,
  error,
  onChange,
  onBlur,
}: {
  f: PayerFieldSpec;
  value: string;
  error: string | null;
  onChange: (key: string, value: string) => void;
  onBlur: (key: string) => void;
}): ReactNode {
  const text = f.input !== PayerFieldInput.DIGITS && f.input !== PayerFieldInput.CODE;
  return (
    <Field label={fieldTitle(f)} hint={fieldHint(f)} error={error}>
      <Input
        value={value}
        placeholder={f.example || undefined}
        maxLength={text ? f.maxLength || 64 : (f.maxLength || 64) + 8}
        inputMode={f.input === PayerFieldInput.DIGITS ? 'numeric' : undefined}
        autoCapitalize={f.input === PayerFieldInput.CODE ? 'characters' : undefined}
        autoComplete={f.key.endsWith('address') ? 'street-address' : 'off'}
        spellCheck={text}
        data-payer-field={f.key}
        data-testid={`billing-payer-field-${f.key}`}
        aria-invalid={!!error || undefined}
        className={cx(!text && 'font-mono', error && 'border-danger')}
        onChange={(e) => onChange(f.key, e.target.value)}
        onBlur={() => onBlur(f.key)}
      />
    </Field>
  );
});

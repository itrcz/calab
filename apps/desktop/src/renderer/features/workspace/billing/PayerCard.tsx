import { PayerType, type PayerProfile } from '@calaba/protocol';
import { useState, type ReactNode } from 'react';
import { Button, Card, Field, Input, Modal, Row, Segmented } from '../../../components/ui';
import { getLocale, t } from '../../../i18n';
import { billingErrorText } from '../../../lib/billing/errors';
import { ownerBilling, reloadBilling } from '../../../services/billing';
import { toast } from '../../../stores/toasts';

/**
 * «Плательщик» (ADR-0080 §6.4, v1 cut): person / company, name, country, e-mail, optional tax id —
 * what goes to the provider's customer and receipts. Checkout itself collects the billing address
 * and tax id (v1), so this is a short form, no country-specific requisites.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** «Германия» for "DE" in the UI language; the code itself when Intl does not know it. */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code || '—';
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function PayerCard({ workspaceId, payer, payments }: { workspaceId: string; payer: PayerProfile | undefined; payments: boolean }): ReactNode {
  const [edit, setEdit] = useState(false);
  const empty = !payer || (!payer.name && !payer.email);
  return (
    <Card title={t('billing.payer.title')} footer={t('billing.payer.footer')}>
      {empty ? (
        <p className="px-3 py-3 text-body text-muted">{t('billing.payer.empty')}</p>
      ) : (
        <>
          <Row label={t(payer.type === PayerType.COMPANY ? 'billing.payer.company' : 'billing.payer.person')}>
            <span className="max-w-72 truncate text-body" title={payer.name}>
              {payer.name || '—'}
            </span>
          </Row>
          <Row label={t('billing.payer.country')}>
            <span className="text-body text-muted">{countryName(payer.country)}</span>
          </Row>
          <Row label={t('billing.payer.email')}>
            <span className="max-w-72 truncate text-body text-muted">{payer.email || '—'}</span>
          </Row>
          {payer.taxId ? (
            <Row label={t('billing.payer.taxId')}>
              <span className="selectable font-mono text-caption text-muted">{payer.taxId}</span>
            </Row>
          ) : null}
        </>
      )}
      {payments ? (
        <div className="flex px-3 py-2">
          <Button size="sm" variant="secondary" onClick={() => setEdit(true)} data-testid="billing-payer-edit">
            {empty ? t('billing.payer.add') : t('billing.payer.edit')}
          </Button>
        </div>
      ) : null}
      {edit ? <PayerDialog workspaceId={workspaceId} payer={payer} onClose={() => setEdit(false)} /> : null}
    </Card>
  );
}

function PayerDialog({ workspaceId, payer, onClose }: { workspaceId: string; payer: PayerProfile | undefined; onClose: () => void }): ReactNode {
  const [type, setType] = useState<'PERSON' | 'COMPANY'>(payer?.type === PayerType.COMPANY ? 'COMPANY' : 'PERSON');
  const [name, setName] = useState(payer?.name ?? '');
  const [country, setCountry] = useState(payer?.country ?? '');
  const [email, setEmail] = useState(payer?.email ?? '');
  const [taxId, setTaxId] = useState(payer?.taxId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cc = country.trim().toUpperCase();
  const problems = {
    name: !name.trim() ? t('billing.payer.err.name') : null,
    country: !/^[A-Z]{2}$/.test(cc) ? t('billing.payer.err.country') : null,
    email: !EMAIL.test(email.trim()) ? t('billing.payer.err.email') : null,
  };
  const [touched, setTouched] = useState(false);

  const save = async (): Promise<void> => {
    setTouched(true);
    if (problems.name || problems.country || problems.email) return;
    setBusy(true);
    setError(null);
    try {
      await ownerBilling.putPayer(workspaceId, { type: PayerType[type], name: name.trim(), country: cc, email: email.trim(), taxId: taxId.trim() });
      toast.success(t('billing.payer.saved'));
      reloadBilling(workspaceId);
      onClose();
    } catch (e) {
      setError(billingErrorText(e, t('err.ctx.save')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('billing.payer.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="billing-payer-form">
        <Segmented<'PERSON' | 'COMPANY'>
          label={t('billing.payer.type')}
          value={type}
          onChange={setType}
          options={[
            { value: 'PERSON', label: t('billing.payer.person') },
            { value: 'COMPANY', label: t('billing.payer.company') },
          ]}
        />
        <Field label={t(type === 'COMPANY' ? 'billing.payer.companyName' : 'billing.payer.personName')} error={touched ? problems.name : null}>
          <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('billing.payer.country')} hint={/^[A-Z]{2}$/.test(cc) ? countryName(cc) : t('billing.payer.countryHint')} error={touched ? problems.country : null}>
          <Input value={country} maxLength={2} className="w-24 uppercase mobile:w-full" autoCapitalize="characters" onChange={(e) => setCountry(e.target.value.replace(/[^a-z]/gi, ''))} />
        </Field>
        <Field label={t('billing.payer.email')} error={touched ? problems.email : null}>
          <Input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('billing.payer.taxIdOptional')}>
          <Input value={taxId} maxLength={64} onChange={(e) => setTaxId(e.target.value)} />
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

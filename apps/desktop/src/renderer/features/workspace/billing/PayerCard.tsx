import type { PayerProfile } from '@calaba/protocol';
import { useState, type ReactNode } from 'react';
import { Button, Card, Row } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { countryName, fieldLabel, payerTypeLabel } from '../../../lib/billing/payer';
import { PayerDialog } from './PayerDialog';

/**
 * «Плательщик» (ADR-0080 §6.4 and §0.1): type, name, country, e-mail and the main tax number of the
 * payer; «Изменить» opens the country requisites form (PayerDialog).
 */
export function PayerCard({
  workspaceId,
  payer,
  market,
  payments,
}: {
  workspaceId: string;
  payer: PayerProfile | undefined;
  /** The account's market: the form's default country for a new payer. */
  market: string;
  payments: boolean;
}): ReactNode {
  const [edit, setEdit] = useState(false);
  const locale = useLocale();
  const empty = !payer || (!payer.name && !payer.email);
  // The main tax number under its own label («ИНН», «VAT number»…).
  const taxKey = payer?.taxId ? Object.keys(payer.requisites).find((k) => payer.requisites[k] === payer.taxId) : undefined;
  return (
    <Card title={t('billing.payer.title')} footer={t('billing.payer.footer')}>
      {empty ? (
        <p className="px-3 py-3 text-body text-muted">{t('billing.payer.empty')}</p>
      ) : (
        <>
          <Row label={payerTypeLabel(payer.type)}>
            <span className="max-w-72 truncate text-body" title={payer.name}>
              {payer.name || '—'}
            </span>
          </Row>
          <Row label={t('billing.payer.country')}>
            <span className="text-body text-muted">{countryName(payer.country, locale)}</span>
          </Row>
          <Row label={t('billing.payer.email')}>
            <span className="max-w-72 truncate text-body text-muted">{payer.email || '—'}</span>
          </Row>
          {payer.taxId ? (
            <Row label={taxKey ? fieldLabel(taxKey) : t('billing.payer.taxId')}>
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
      {edit ? <PayerDialog workspaceId={workspaceId} payer={payer} market={market} onClose={() => setEdit(false)} /> : null}
    </Card>
  );
}

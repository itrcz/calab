import { AutoTopupAttemptStatus, type BillingSummary, type SavedPaymentMethod } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { confirmAction } from '../../../components/Confirm';
import { Button, Card, Field, Input, Modal, Row, Select, Toggle } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { nowMs } from '../../../lib/billing/checkout';
import { billingErrorText } from '../../../lib/billing/errors';
import { AUTO_TOPUP_CONSENT_VERSION, autoTopupFailure, autoTopupLimits, currencyOf, requestId, type AutoTopupFailure } from '../../../lib/billing/model';
import { formatMinor, formatMoney, inputOf, minorOf, parseMajor } from '../../../lib/billing/money';
import { brandName, cardLabel } from '../../../lib/billing/savedTopup';
import { fmt } from '../../../lib/format';
import { billingKeys, ownerBilling, reloadBilling } from '../../../services/billing';
import { toast } from '../../../stores/toasts';

/**
 * «Автопополнение» (ADR-0080 §7, §0): off by default; turning it on is a separate consent with the
 * formula («долг + 30 суток текущей команды»), the cap (default $500, max $5000) and the saved card.
 * Turning it off revokes the consent at once; it never stops the paid plan (that is «Остановить»).
 * A saved card can be detached (that also turns auto-topup off on the server).
 */

const ATTEMPT_KEY: Record<AutoTopupAttemptStatus, MessageKey> = {
  [AutoTopupAttemptStatus.UNSPECIFIED]: 'billing.auto.attempt.unknown',
  [AutoTopupAttemptStatus.PREPARED]: 'billing.auto.attempt.pending',
  [AutoTopupAttemptStatus.DISPATCHED]: 'billing.auto.attempt.pending',
  [AutoTopupAttemptStatus.SUCCEEDED]: 'billing.auto.attempt.ok',
  [AutoTopupAttemptStatus.FAILED]: 'billing.auto.attempt.failed',
  [AutoTopupAttemptStatus.UNKNOWN]: 'billing.auto.attempt.unknown',
  [AutoTopupAttemptStatus.REQUIRES_ACTION]: 'billing.auto.attempt.pending',
};

const FAILURE_KEY: Record<AutoTopupFailure, MessageKey> = {
  authentication_required: 'billing.auto.fail.authentication_required',
  card_declined: 'billing.auto.fail.card_declined',
  insufficient_funds: 'billing.auto.fail.insufficient_funds',
  expired_card: 'billing.auto.fail.expired_card',
  generic: 'billing.auto.fail.generic',
};

/** «Visa •••• 4242, до 08/29»; a card without an expiry (Tochka shows none) is «МИР •••• 0792». */
export const cardText = (m: SavedPaymentMethod): string =>
  m.expMonth > 0
    ? t('billing.card.line', { brand: brandName(m.brand) || t('billing.method.card'), last4: m.last4, exp: `${String(m.expMonth).padStart(2, '0')}/${String(m.expYear % 100).padStart(2, '0')}` })
    : cardLabel(m);

export function AutoTopupCard({ workspaceId, summary: s, payments }: { workspaceId: string; summary: BillingSummary; payments: boolean }): ReactNode {
  const methods = useQuery({ queryKey: billingKeys.methods(workspaceId), queryFn: ({ signal }) => ownerBilling.paymentMethods(workspaceId, signal), retry: false });
  const a = s.autoTopup;
  const enabled = !!a?.enabled;
  const cards = methods.data?.methods ?? [];
  const card = cards.find((m) => m.id === a?.paymentMethodId) ?? cards[0];
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  // «Not before» is compared with the time the card opened (no clock in render).
  const [mountedAt] = useState(nowMs);
  const last = a?.lastAttempt;

  const revoke = async (): Promise<void> => {
    if (!(await confirmAction(t('billing.auto.offTitle'), t('billing.auto.offText'), t('billing.auto.off')))) return;
    setBusy(true);
    try {
      await ownerBilling.revokeAutoTopup(workspaceId);
      toast.success(t('billing.auto.offDone'));
      reloadBilling(workspaceId);
    } catch (e) {
      toast.error(billingErrorText(e, t('billing.auto.offFailed')));
    } finally {
      setBusy(false);
    }
  };

  const detach = async (m: SavedPaymentMethod): Promise<void> => {
    if (!(await confirmAction(t('billing.card.detachTitle'), t(enabled ? 'billing.card.detachTextAuto' : 'billing.card.detachText', { card: cardText(m) }), t('billing.card.detach')))) return;
    try {
      await ownerBilling.detachMethod(workspaceId, m.id);
      reloadBilling(workspaceId);
    } catch (e) {
      toast.error(billingErrorText(e, t('billing.card.detachFailed')));
    }
  };

  return (
    <Card title={t('billing.auto.title')} footer={t('billing.auto.formula')}>
      <Row label={t('billing.auto.toggle')} hint={enabled && a.maxAmount ? t('billing.auto.capLine', { cap: formatMoney(a.maxAmount, { compact: true }) }) : t(cards.length > 0 ? 'billing.auto.offHint' : 'billing.auto.needCard')}>
        <Toggle
          label={t('billing.auto.toggle')}
          checked={enabled}
          disabled={!payments || busy || (!enabled && cards.length === 0)}
          onChange={(v) => (v ? setConsent(true) : void revoke())}
        />
      </Row>
      {enabled && a.nextAmount && minorOf(a.nextAmount) > 0n ? (
        <Row label={t('billing.auto.next')} hint={t('billing.auto.nextHint')}>
          <span className="text-body tabular-nums">{formatMoney(a.nextAmount)}</span>
        </Row>
      ) : null}
      {last ? (
        <Row label={t('billing.auto.last')} hint={last.failureCode ? t(FAILURE_KEY[autoTopupFailure(last.failureCode)]) : undefined}>
          <span className={last.status === AutoTopupAttemptStatus.FAILED ? 'text-body text-danger-text' : 'text-body text-muted'}>
            {t(ATTEMPT_KEY[last.status], { amount: formatMoney(last.amount), when: last.createdAt ? fmt.shortDate(timestampDate(last.createdAt)) : '—' })}
          </span>
        </Row>
      ) : null}
      {enabled && a.notBefore && timestampDate(a.notBefore).getTime() > mountedAt ? (
        <Row label={t('billing.auto.notBefore')}>
          <span className="text-body text-muted">{fmt.dateTime(timestampDate(a.notBefore), 'short')}</span>
        </Row>
      ) : null}
      {cards.map((m) => (
        <Row key={m.id} label={t('billing.card.saved')} hint={m.id === a?.paymentMethodId && enabled ? t('billing.card.usedForAuto') : undefined}>
          <span className="flex items-center gap-2 text-body">
            <CreditCard className="size-4 text-muted" aria-hidden />
            <span className="tabular-nums" data-testid="billing-card">
              {cardText(m)}
            </span>
          </span>
          {payments ? (
            <Button size="sm" variant="destructive" onClick={() => void detach(m)}>
              {t('billing.card.detach')}
            </Button>
          ) : null}
        </Row>
      ))}
      {cards.length === 0 && !methods.isLoading ? (
        <p className="px-3 py-2 text-caption text-muted">{t('billing.card.none')}</p>
      ) : null}
      {consent && card ? <ConsentDialog workspaceId={workspaceId} summary={s} cards={cards} initial={card.id} onClose={() => setConsent(false)} /> : null}
    </Card>
  );
}

/** The consent: card, cap, the formula; PUT …/auto-topup with the consent version. */
function ConsentDialog({ workspaceId, summary, cards, initial, onClose }: { workspaceId: string; summary: BillingSummary; cards: SavedPaymentMethod[]; initial: string; onClose: () => void }): ReactNode {
  const currency = currencyOf(summary);
  const lim = autoTopupLimits(summary);
  const [pm, setPm] = useState(initial);
  const [raw, setRaw] = useState(() => inputOf(minorOf(summary.autoTopup?.maxAmount) > 0n ? minorOf(summary.autoTopup?.maxAmount) : lim.def, currency));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reqId = useRef(requestId());
  const cap = parseMajor(raw, currency);
  const bad = cap === null || cap <= 0n || cap > lim.max;

  const save = async (): Promise<void> => {
    if (bad) {
      setError(t('billing.auto.capInvalid', { max: formatMinor(lim.max, currency, { compact: true }) }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ownerBilling.putAutoTopup(workspaceId, { paymentMethodId: pm, maxAmount: { minor: cap, currency }, consentVersion: AUTO_TOPUP_CONSENT_VERSION, requestId: reqId.current });
      toast.success(t('billing.auto.onDone'));
      reloadBilling(workspaceId);
      onClose();
    } catch (e) {
      setError(billingErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      initialFocus="body"
      onClose={onClose}
      title={t('billing.auto.consentTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void save()} data-testid="billing-auto-accept">
            {t('billing.auto.accept')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="billing-auto-consent">
        <p className="text-body">{t('billing.auto.consentText', { cap: cap !== null && !bad ? formatMinor(cap, currency, { compact: true }) : '—' })}</p>
        {cards.length === 1 && cards[0] ? (
          <p className="flex items-center gap-2 text-body text-muted">
            <CreditCard className="size-4" aria-hidden />
            {cardText(cards[0])}
          </p>
        ) : cards.length > 1 ? (
          <Field label={t('billing.card.saved')}>
            <Select value={pm} onChange={(e) => setPm(e.target.value)} aria-label={t('billing.card.saved')}>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {cardText(c)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={t('billing.auto.cap', { currency })} hint={t('billing.auto.capHint', { def: formatMinor(lim.def, currency, { compact: true }), max: formatMinor(lim.max, currency, { compact: true }) })} error={error}>
          <Input inputMode="decimal" className="w-40 tabular-nums mobile:w-full" aria-label={t('billing.auto.cap', { currency })} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </Field>
        <p className="text-caption text-faint">{t('billing.auto.consentRules')}</p>
      </div>
    </Modal>
  );
}

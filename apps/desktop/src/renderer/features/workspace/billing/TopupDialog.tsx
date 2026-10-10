import { PaymentMethodKind, type BillingSummary, type PaymentMethodOption } from '@calaba/protocol';
import { CircleCheck, CircleX, CreditCard, ExternalLink, QrCode } from 'lucide-react';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal, Spinner, cx } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { IDLE, checkoutReducer, nowMs, pollDelay, type CheckoutFlow, type CheckoutOutcome } from '../../../lib/billing/checkout';
import { billingErrorText } from '../../../lib/billing/errors';
import { methodLabel, providerTag } from '../../../lib/billing/market';
import { amountProblem, currencyOf, defaultTopup, offeredMethods, requestId, topupLimits, topupPresets, type AmountProblem } from '../../../lib/billing/model';
import { clampMinor, formatMinor, inputOf, minorOf, parseMajor } from '../../../lib/billing/money';
import { onCheckoutReturn, openCheckout, ownerBilling, reloadBilling } from '../../../services/billing';

/**
 * «Пополнить баланс» (ADR-0080 §13): a method from GET …/billing methods[] (only what the server
 * offers for the market / currency / payer; v1 — Stripe card), an amount (presets or own, limits from
 * the server), the optional «save the card for auto-topup» consent; POST …/topups opens the hosted
 * checkout in the system browser, then the dialog polls GET …/checkouts/{id} until the money is on
 * the balance (the poll pauses while the window is hidden and runs again when it comes back).
 */

const PROBLEM_KEY: Record<AmountProblem, MessageKey> = {
  empty: 'billing.topup.err.empty',
  invalid: 'billing.topup.err.invalid',
  tooSmall: 'billing.topup.err.min',
  tooLarge: 'billing.topup.err.max',
};

function MethodPicker({ methods, value, onChange }: { methods: PaymentMethodOption[]; value: string; onChange: (id: string) => void }): ReactNode {
  return (
    <div role="radiogroup" aria-label={t('billing.topup.method')} className="flex flex-col gap-1.5">
      {methods.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          onClick={() => onChange(m.id)}
          className={cx(
            'flex min-h-10 items-center gap-2.5 rounded-[var(--radius-card)] border px-3 py-2 text-left text-body mobile:tap-min-h',
            value === m.id ? 'border-[var(--color-focus)] bg-[var(--color-card)]' : 'border-line hover:bg-hover',
          )}
        >
          {m.kind === PaymentMethodKind.SBP ? <QrCode className="size-4 shrink-0 text-muted" aria-hidden /> : <CreditCard className="size-4 shrink-0 text-muted" aria-hidden />}
          <span className="min-w-0 flex-1">{t(methodLabel(m))}</span>
          {providerTag(m.provider) ? <span className="text-caption text-faint">{providerTag(m.provider)}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function useCheckoutPoll(workspaceId: string, flow: CheckoutFlow, dispatch: (e: Parameters<typeof checkoutReducer>[1]) => void): void {
  // The poll: one timeout at a time, none while hidden; coming back polls at once (the person
  // returns from the browser or the checkout window right after paying).
  const id = flow.phase === 'waiting' ? flow.checkoutId : null;
  const delay = pollDelay(flow);
  const polls = flow.phase === 'waiting' ? flow.polls : -1;
  useEffect(() => {
    if (!id || delay === null) return;
    const ac = new AbortController();
    let timer = 0;
    const poll = (): void => {
      window.clearTimeout(timer);
      ownerBilling
        .checkout(workspaceId, id, ac.signal)
        .then((status) => dispatch({ type: 'polled', status, now: nowMs() }))
        .catch(() => {
          if (!ac.signal.aborted) dispatch({ type: 'pollFailed', now: nowMs() });
        });
    };
    const arm = (): void => {
      if (document.visibilityState !== 'hidden') timer = window.setTimeout(poll, polls === 0 ? 1_500 : delay);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') poll();
      else window.clearTimeout(timer);
    };
    arm();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    // Back from the in-app checkout window (ADR-0084): poll at once.
    const offReturn = onCheckoutReturn(poll);
    return () => {
      offReturn();
      ac.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [workspaceId, id, delay, polls, dispatch]);
}

export function TopupDialog({
  workspaceId,
  summary,
  initialAmount,
  onClose,
}: {
  workspaceId: string;
  summary: BillingSummary;
  /** Prefilled amount in minor units (a quote's «to pay»). */
  initialAmount?: bigint | undefined;
  onClose: () => void;
}): ReactNode {
  const currency = currencyOf(summary);
  const methods = offeredMethods(summary);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? '');
  const method = methods.find((m) => m.id === methodId);
  const lim = topupLimits(method, currency);
  const presets = topupPresets(summary, lim, currency);
  const [raw, setRaw] = useState(() => inputOf(initialAmount && initialAmount > 0n ? clampMinor(initialAmount, lim.min, lim.max) : defaultTopup(summary, lim, currency), currency));
  const [save, setSave] = useState(false);
  const [touched, setTouched] = useState(false);
  const [flow, dispatch] = useReducer(checkoutReducer, IDLE);
  // One request id per opened form: a double click is the same checkout (server idempotency).
  const reqId = useRef(requestId());
  const minor = parseMajor(raw, currency);
  const problem = amountProblem(minor, raw, lim);
  // «Save the card» only while no card is saved (one card per account in v1).
  const canSave = !!method?.autoTopupCapable && !summary.autoTopup?.paymentMethodId;
  const hasDebt = minorOf(summary.debt) > 0n;
  useCheckoutPoll(workspaceId, flow, dispatch);

  useEffect(() => {
    if (flow.phase === 'done' && flow.outcome === 'credited') reloadBilling(workspaceId);
  }, [flow, workspaceId]);

  const pay = async (): Promise<void> => {
    setTouched(true);
    if (problem || minor === null || !method) return;
    dispatch({ type: 'create' });
    try {
      const r = await ownerBilling.topup(workspaceId, { methodId: method.id, amount: { minor, currency }, requestId: reqId.current, saveMethod: canSave && save });
      dispatch({ type: 'created', checkoutId: r.checkoutId, url: r.url, now: nowMs() });
      openCheckout(r.url);
    } catch (e) {
      dispatch({ type: 'createFailed', message: billingErrorText(e, t('billing.topup.failed')) });
      reqId.current = requestId();
    }
  };

  const phase = flow.phase;
  const form = phase === 'idle' || phase === 'creating' || phase === 'error';
  const footer = form ? (
    <>
      <Button variant="secondary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button busy={phase === 'creating'} disabled={!method} onClick={() => void pay()} data-testid="billing-topup-pay">
        {minor !== null && !problem ? t('billing.topup.payAmount', { amount: formatMinor(minor, currency) }) : t('billing.topup.pay')}
      </Button>
    </>
  ) : phase === 'done' || phase === 'stalled' ? (
    <Button onClick={onClose}>{t('billing.topup.close')}</Button>
  ) : (
    <Button variant="secondary" onClick={onClose}>
      {t('billing.topup.later')}
    </Button>
  );

  return (
    <Modal open onClose={onClose} title={t('billing.topup.title')} footer={footer}>
      <div className="flex flex-col gap-4" data-testid="billing-topup">
        {form ? (
          <>
            {methods.length === 0 ? (
              <p className="text-body text-muted">{t('billing.topup.noMethods')}</p>
            ) : methods.length > 1 ? (
              <MethodPicker methods={methods} value={methodId} onChange={setMethodId} />
            ) : null}
            <div className="flex flex-col gap-2">
              <span className="text-caption font-medium text-muted">{t('billing.topup.amount')}</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('billing.topup.presets')}>
                {presets.map((p) => {
                  const on = minor === p.minor;
                  return (
                    <button
                      key={`${p.reserve}-${p.minor}`}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setRaw(inputOf(p.minor, currency))}
                      title={p.reserve ? t('billing.topup.reserveHint') : undefined}
                      className={cx(
                        'inline-flex h-7 items-center gap-1 rounded-full px-3 text-body font-medium tabular-nums mobile:tap-h',
                        on ? 'bg-accent-strong text-accent-fg' : 'bg-hover text-fg hover:bg-[var(--color-fill-hover)]',
                      )}
                    >
                      {formatMinor(p.minor, currency, { compact: true })}
                      {p.reserve ? <span className={cx('text-caption font-normal', on ? 'text-accent-fg' : 'text-muted')}>{t(hasDebt ? 'billing.topup.reserve' : 'billing.topup.reserve30')}</span> : null}
                    </button>
                  );
                })}
              </div>
              <Field
                label={t('billing.topup.own', { currency })}
                error={touched && problem ? t(PROBLEM_KEY[problem], { min: formatMinor(lim.min, currency, { compact: true }), max: formatMinor(lim.max, currency, { compact: true }) }) : null}
                hint={t('billing.topup.limits', { min: formatMinor(lim.min, currency, { compact: true }), max: formatMinor(lim.max, currency, { compact: true }) })}
              >
                <Input
                  inputMode="decimal"
                  aria-label={t('billing.topup.own', { currency })}
                  className="w-40 tabular-nums mobile:w-full"
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  onBlur={() => setTouched(true)}
                  data-testid="billing-topup-amount"
                />
              </Field>
            </div>
            {canSave ? (
              <label className="flex items-start gap-2.5 text-body">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" checked={save} onChange={(e) => setSave(e.target.checked)} data-testid="billing-topup-save" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{t('billing.topup.save')}</span>
                  <span className="text-caption text-faint">{t('billing.topup.saveConsent')}</span>
                </span>
              </label>
            ) : null}
            <p className="text-caption text-faint">{t('billing.topup.hosted')}</p>
            {phase === 'error' ? (
              <p role="alert" className="text-caption text-danger-text">
                {flow.message}
              </p>
            ) : null}
          </>
        ) : (
          <CheckoutProgress flow={flow} onRecheck={() => dispatch({ type: 'recheck', now: nowMs() })} />
        )}
      </div>
    </Modal>
  );
}

const OUTCOME: Record<CheckoutOutcome, MessageKey> = {
  credited: 'billing.checkout.credited',
  expired: 'billing.checkout.expired',
  canceled: 'billing.checkout.canceled',
  failed: 'billing.checkout.failed',
};

/** After the checkout opened: waiting / paid / failed, with «open the page again». */
export function CheckoutProgress({ flow, onRecheck }: { flow: CheckoutFlow; onRecheck: () => void }): ReactNode {
  if (flow.phase === 'done') {
    const ok = flow.outcome === 'credited';
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center" role="status" data-testid="billing-checkout-done">
        {ok ? <CircleCheck className="size-8 text-ok" aria-hidden /> : <CircleX className="size-8 text-danger" aria-hidden />}
        <p className="text-body">{t(OUTCOME[flow.outcome])}</p>
      </div>
    );
  }
  const url = flow.phase === 'waiting' || flow.phase === 'stalled' ? flow.url : '';
  const paid = (flow.phase === 'waiting' || flow.phase === 'stalled') && flow.paid;
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center" role="status" data-testid="billing-checkout-waiting">
      {flow.phase === 'waiting' ? <Spinner className="size-6" /> : null}
      <p className="text-body">{paid ? t('billing.checkout.crediting') : flow.phase === 'stalled' ? t('billing.checkout.stalled') : t('billing.checkout.waiting')}</p>
      <p className="text-caption text-muted">{t('billing.checkout.hint')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {url && !paid ? (
          <Button variant="secondary" onClick={() => openCheckout(url)}>
            {t('billing.checkout.open')}
            <ExternalLink className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        {flow.phase === 'stalled' ? (
          <Button variant="secondary" onClick={onRecheck}>
            {t('billing.checkout.recheck')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

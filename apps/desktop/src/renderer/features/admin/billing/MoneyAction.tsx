import type { AdminBillingMutationResult } from '@calaba/protocol';
import { useRef, useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal } from '../../../components/ui';
import { t } from '../../../i18n';
import { REASON_MAX, adminFormError, reasonError, reasonHint, reasonProblem, type AdminFormError } from '../../../lib/billing/adminForm';
import { amountProblem, requestId } from '../../../lib/billing/model';
import { formatMinor, formatMoney, inputOf, parseMajor } from '../../../lib/billing/money';
import { toast } from '../../../stores/toasts';
import { SumLine } from '../../workspace/billing/parts';

/**
 * A superadmin money mutation (ADR-0080 §13, docs/plans/billing-v1-tasks T6): reason required,
 * a request_id per opened form (idempotent retries), the server's preview (balance before → after)
 * shown before «Подтвердить», then the same request without preview. A 403 RECENT_AUTH_REQUIRED
 * shows the admin window's password notice; the form stays open for a retry. The reason is
 * checked like the server does (5..1000, lib/billing/adminForm) before any request; a 422 about a
 * field is shown at that field, any other refusal as its own sentence.
 */

export interface MoneyActionArgs {
  /** Minor units (when the action takes an amount). */
  amount: bigint | null;
  reason: string;
  requestId: string;
  preview: boolean;
}

export function MoneyActionDialog({
  title,
  text,
  action,
  currency,
  amount,
  maxAmount,
  initialAmount,
  preview = true,
  destructive = false,
  extra,
  run,
  onDone,
  onClose,
}: {
  title: string;
  text?: string;
  /** The confirm button («Начислить», «Вернуть»). */
  action: string;
  currency: string;
  /** The form has an amount field. */
  amount: boolean;
  maxAmount?: bigint | undefined;
  initialAmount?: bigint | undefined;
  /** The route answers a preview (manual credit, reverse, refund); else a plain confirmation. */
  preview?: boolean;
  /** The confirm button is destructive (a rejection). */
  destructive?: boolean;
  /** Extra fields above the reason (rendered by the caller). */
  extra?: ReactNode;
  run: (a: MoneyActionArgs) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}): ReactNode {
  const [raw, setRaw] = useState(initialAmount ? inputOf(initialAmount, currency) : '');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminFormError | null>(null);
  const [shown, setShown] = useState<AdminBillingMutationResult | null>(null);
  const reqId = useRef(requestId());
  const minor = amount ? parseMajor(raw, currency) : null;
  const problem = amount ? amountProblem(minor, raw, { min: 1n, max: maxAmount ?? 10n ** 15n }) : null;
  const reasonMissing = reasonProblem(reason) !== null;
  const fieldError = (f: string): string | null => (error?.field === f ? error.text : null);

  const go = async (asPreview: boolean): Promise<void> => {
    setTouched(true);
    if (problem || reasonMissing) return;
    setBusy(true);
    setError(null);
    try {
      const r = await run({ amount: minor, reason: reason.trim(), requestId: reqId.current, preview: asPreview });
      if (asPreview) setShown(r as AdminBillingMutationResult);
      else {
        toast.success(t('adminBilling.done'));
        onDone();
        onClose();
      }
    } catch (e) {
      const fe = adminFormError(e);
      setError(fe);
      // A refusal about the form's own fields goes back to the form (the preview step included).
      if (fe.field === 'reason' || fe.field === 'amount') setShown(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmStep = !preview || shown !== null;
  return (
    <Modal
      open
      initialFocus="body"
      onClose={onClose}
      title={title}
      description={text}
      closeButton={false}
      footer={
        <>
          <Button variant="secondary" onClick={shown ? () => setShown(null) : onClose}>
            {shown ? t('adminBilling.back') : t('common.cancel')}
          </Button>
          <Button busy={busy} variant={confirmStep && destructive ? 'destructive' : 'primary'} onClick={() => void go(!confirmStep)} data-testid="admin-billing-submit">
            {confirmStep ? action : t('adminBilling.preview')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="admin-billing-action">
        {shown ? (
          <div className="flex flex-col" data-testid="admin-billing-preview">
            <SumLine label={t('adminBilling.before')}>{formatMoney(shown.balanceBefore)}</SumLine>
            <SumLine label={t('adminBilling.after')} strong>
              {formatMoney(shown.balanceAfter)}
            </SumLine>
            {minor !== null ? <p className="pt-2 text-caption text-muted">{t('adminBilling.previewNote', { amount: formatMinor(minor, currency), reason: reason.trim() })}</p> : null}
          </div>
        ) : (
          <>
            {extra}
            {amount ? (
              <Field
                label={t('adminBilling.amount', { currency })}
                hint={maxAmount !== undefined ? t('adminBilling.amountMax', { max: formatMinor(maxAmount, currency) }) : undefined}
                error={touched && problem ? t(problem === 'tooLarge' ? 'adminBilling.amountTooLarge' : 'billing.topup.err.invalid') : fieldError('amount')}
              >
                <Input inputMode="decimal" className="w-40 tabular-nums mobile:w-full" value={raw} onChange={(e) => setRaw(e.target.value)} data-testid="admin-billing-amount" />
              </Field>
            ) : null}
            <Field label={t('adminBilling.reason')} hint={reasonHint(reason)} error={reasonError(reason, touched) ?? fieldError('reason')}>
              <Input
                value={reason}
                maxLength={REASON_MAX}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (error?.field === 'reason') setError(null);
                }}
                placeholder={t('adminBilling.reasonPh')}
                aria-required
                data-testid="admin-billing-reason"
              />
            </Field>
          </>
        )}
        {error && error.field !== 'reason' && !(error.field === 'amount' && amount && !shown) ? (
          <p role="alert" className="text-caption text-danger-text" data-testid="admin-billing-error">
            {error.text}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

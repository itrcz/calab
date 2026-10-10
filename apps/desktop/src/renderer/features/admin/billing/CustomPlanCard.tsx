import { BillingAccountStatus, Plan, type AdminBillingAccount, type AdminBillingAccountDetails, type AdminBillingMutationResult, type AdminCustomPlan, type PlanLimitViolation } from '@calaba/protocol';
import { timestampDate, timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TriangleAlert } from 'lucide-react';
import { memo, useRef, useState, type ReactNode } from 'react';
import { confirmAction } from '../../../components/Confirm';
import { Button, Card, Field, Input, Modal, Row, Segmented, cx } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { recentAuthRequired } from '../../../lib/api/errors';
import { nowMs } from '../../../lib/billing/checkout';
import { CUSTOM_UNIT_CAP, customPriceAt, localInputMs, nextCustomPrice, priceStatus, type PriceStatus } from '../../../lib/billing/customPlan';
import { billingErrorText } from '../../../lib/billing/errors';
import { requestId } from '../../../lib/billing/model';
import { formatMinor, formatMoney, inputOf, parseMajor } from '../../../lib/billing/money';
import { violationText, violationsOf } from '../../../lib/billing/violations';
import { fmt } from '../../../lib/format';
import { CUSTOM_DESCRIPTION_MAX, CUSTOM_NAME_MAX, limitsFormFrom, limitsFromForm, planDisplayName, type LimitsForm } from '../../../lib/plan';
import { adminBilling } from '../../../services/billing';
import { toast } from '../../../stores/toasts';
import { SumLine } from '../../workspace/billing/parts';
import { CustomLimitsFields, FIELD_LABEL } from '../CustomLimitsFields';
import { MoneyActionDialog } from './MoneyAction';

/**
 * «Индивидуальный тариф» on the superadmin's billing account page (ADR-0086, 10.10): the name and
 * description members see, the account's own price per seat per day and its version history, the
 * limits; «Назначить» / «Изменить» open the editor (preview of what is charged and returned, then
 * the same request), «Вернуть на стандартный» moves the account back to Team / Business. A plan the
 * workspace exceeds is listed and assigned only on «Назначить всё равно» (written to the plan log).
 */

const STATUS_KEY: Record<PriceStatus, MessageKey> = {
  current: 'adminCustom.status.current',
  scheduled: 'adminCustom.status.scheduled',
  past: 'adminCustom.status.past',
  replaced: 'adminCustom.status.replaced',
};

type Open = 'edit' | 'standard' | null;

export function CustomPlanCard({ details, onDone }: { details: AdminBillingAccountDetails; onDone: () => void }): ReactNode {
  const a = details.account;
  const cp = details.customPlan;
  const [open, setOpen] = useState<Open>(null);
  const [now] = useState(nowMs);
  if (!a) return null;
  const active = !!cp?.active;
  const prices = cp?.prices ?? [];
  const current = customPriceAt(prices, now);
  const next = nextCustomPrice(prices, now);
  const closed = a.status === BillingAccountStatus.CLOSED || a.status === BillingAccountStatus.SUSPENDED;
  return (
    <>
      <Card title={t('adminCustom.title')}>
        {active ? (
          <>
            <Row label={t('adminCustom.row.name')} hint={cp.description || undefined}>
              <span className={cx('max-w-72 truncate text-body', cp.displayName ? 'text-fg' : 'text-muted')} data-testid="admin-custom-name">
                {cp.displayName || t('adminCustom.unnamed')}
              </span>
            </Row>
            <Row label={t('adminCustom.row.price')}>
              <span className="text-body font-semibold tabular-nums" data-testid="admin-custom-price">
                {current ? formatMoney(current.unit) : '—'}
              </span>
            </Row>
            {next ? (
              <Row label={t('adminCustom.row.nextPrice')}>
                <span className="text-body tabular-nums text-muted">{t('customPlan.nextPrice', { date: fmt.dateTime(new Date(next.at), 'short'), price: formatMoney(next.version.unit) })}</span>
              </Row>
            ) : null}
          </>
        ) : (
          <p className="px-3 py-3 text-body text-muted">{t('adminCustom.off')}</p>
        )}
        <div className="flex flex-wrap gap-2 px-3 py-3" data-testid="admin-custom-actions">
          <Button size="sm" variant={active ? 'secondary' : 'primary'} disabled={closed} onClick={() => setOpen('edit')} data-testid="admin-custom-edit">
            {active ? t('adminCustom.edit') : t('adminCustom.assign')}
          </Button>
          {active ? (
            <Button size="sm" variant="ghost" disabled={closed} onClick={() => setOpen('standard')} data-testid="admin-custom-standard">
              {t('adminCustom.toStandard')}
            </Button>
          ) : null}
        </div>
      </Card>
      {prices.length ? <PriceHistory prices={prices} now={now} /> : null}
      {open === 'edit' ? <CustomPlanDialog a={a} cp={cp} active={active} onDone={onDone} onClose={() => setOpen(null)} /> : null}
      {open === 'standard' ? <StandardPlanDialog a={a} onDone={onDone} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** The account's price versions, newest first, with what each is now. */
const PriceHistory = memo(function PriceHistory({ prices, now }: { prices: AdminCustomPlan['prices']; now: number }): ReactNode {
  const cols = 'grid grid-cols-[minmax(0,1fr)_96px_104px] items-center gap-3 mobile:grid-cols-[minmax(0,1fr)_auto]';
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 text-caption font-semibold text-muted">{t('adminCustom.history')}</h3>
      <div role="table" aria-label={t('adminCustom.history')} className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body" data-testid="admin-custom-history">
        <div role="row" className={cx(cols, 'border-b border-[var(--color-card-line)] px-3 py-1.5 text-caption font-medium text-muted mobile:hidden')}>
          <span role="columnheader">{t('adminCustom.col.from')}</span>
          <span role="columnheader" className="text-right">
            {t('adminCustom.col.price')}
          </span>
          <span role="columnheader" className="text-right">
            {t('adminCustom.col.set')}
          </span>
        </div>
        {prices.map((p) => {
          const status = priceStatus(prices, p, now);
          return (
            <div key={p.id} role="row" className={cx(cols, 'min-h-10 border-b border-[var(--color-card-line)] px-3 py-1.5 last:border-b-0')} data-testid="admin-custom-price-row" data-status={status}>
              <span role="cell" className="flex min-w-0 flex-col">
                <span className="tabular-nums">{p.effectiveFrom ? fmt.dateTime(timestampDate(p.effectiveFrom), 'short') : '—'}</span>
                <span className={cx('text-caption', status === 'current' ? 'text-ok' : status === 'scheduled' ? 'text-accent-text' : 'text-faint')}>{t(STATUS_KEY[status])}</span>
              </span>
              <span role="cell" className={cx('text-right tabular-nums', status === 'replaced' && 'text-muted line-through')}>
                {formatMoney(p.unit)}
              </span>
              <span role="cell" className="text-right tabular-nums text-caption text-muted mobile:hidden">
                {p.createdAt ? fmt.shortDate(timestampDate(p.createdAt)) : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
});

/** The editor: name, description, price (and its start once the account is on custom), limits, reason → preview → save. */
function CustomPlanDialog({ a, cp, active, onDone, onClose }: { a: AdminBillingAccount; cp: AdminCustomPlan | undefined; active: boolean; onDone: () => void; onClose: () => void }): ReactNode {
  const currency = a.balance?.currency || 'USD';
  const cap = CUSTOM_UNIT_CAP[currency] ?? 0n;
  const [now] = useState(nowMs);
  const current = customPriceAt(cp?.prices ?? [], now);
  const [name, setName] = useState(active ? (cp?.displayName ?? '') : '');
  const [description, setDescription] = useState(active ? (cp?.description ?? '') : '');
  const [price, setPrice] = useState(active && current?.unit ? inputOf(current.unit.minor, currency) : '');
  const [from, setFrom] = useState('');
  const [limits, setLimits] = useState<LimitsForm>(() => limitsFormFrom(active && cp?.limits ? Plan.CUSTOM : Plan.FREE, cp?.limits));
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<AdminBillingMutationResult | null>(null);
  const [over, setOver] = useState<readonly PlanLimitViolation[] | null>(null);
  const override = useRef(false);
  const reqId = useRef(requestId());

  const unit = price.trim() === '' ? null : parseMajor(price, currency);
  const priceBad = price.trim() === '' ? !active : unit === null || unit <= 0n || unit > cap;
  const fromMs = from ? localInputMs(from) : null;
  const fromBad = from !== '' && (fromMs === null || fromMs < now - 60_000);
  const lim = limitsFromForm(limits);
  const reasonBad = reason.trim().length < 5;
  const plan = planDisplayName(Plan.CUSTOM, name);

  const go = async (preview: boolean): Promise<void> => {
    setTouched(true);
    if (priceBad || fromBad || 'error' in lim || reasonBad) return;
    setBusy(true);
    setError(null);
    try {
      const r = await adminBilling.customPlan(a.accountId, {
        limits: lim.limits,
        ...(unit !== null ? { unit: { minor: unit, currency } } : {}),
        displayName: name.trim(),
        description: description.trim(),
        ...(active && fromMs !== null && fromMs > now ? { effectiveFrom: timestampFromMs(fromMs) } : {}),
        reason: reason.trim(),
        requestId: reqId.current,
        expectedRevision: a.revision,
        preview,
        overrideLimits: override.current,
      });
      if (preview) setShown(r);
      else {
        toast.success(t('adminBilling.done'));
        onDone();
        onClose();
      }
    } catch (e) {
      const list = violationsOf(e);
      if (list.length && !override.current) setOver(list);
      else setError(recentAuthRequired(e) ? t('adminBilling.reauth') : billingErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const assignAnyway = (): void => {
    override.current = true;
    setOver(null);
    void go(true);
  };

  return (
    <Modal
      open
      wide
      initialFocus="body"
      onClose={onClose}
      title={t('adminCustom.dialogTitle')}
      description={t('adminCustom.dialogText')}
      closeButton={false}
      footer={
        <>
          <Button variant="secondary" onClick={shown ? () => setShown(null) : onClose}>
            {shown ? t('adminBilling.back') : t('common.cancel')}
          </Button>
          {over ? (
            <Button variant="destructive" busy={busy} onClick={assignAnyway} data-testid="admin-custom-override">
              {t('admin.plan.overConfirm')}
            </Button>
          ) : (
            <Button busy={busy} onClick={() => void go(!shown)} data-testid="admin-custom-submit">
              {shown ? t('adminCustom.save') : t('adminBilling.preview')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="admin-custom-dialog">
        {shown ? (
          <div className="flex flex-col" data-testid="admin-custom-preview">
            <SumLine label={t('adminCustom.charged')}>{formatMoney(shown.amount)}</SumLine>
            <SumLine label={t('adminCustom.compensated')}>{formatMoney(shown.compensation)}</SumLine>
            {shown.price ? (
              <SumLine label={t('adminCustom.newPrice')}>
                {shown.price.effectiveFrom && timestampDate(shown.price.effectiveFrom).getTime() > now + 60_000
                  ? t('customPlan.nextPrice', { date: fmt.dateTime(timestampDate(shown.price.effectiveFrom), 'short'), price: formatMoney(shown.price.unit) })
                  : formatMoney(shown.price.unit)}
              </SumLine>
            ) : null}
            <SumLine label={t('adminBilling.before')}>{formatMoney(shown.balanceBefore)}</SumLine>
            <SumLine label={t('adminBilling.after')} strong>
              {formatMoney(shown.balanceAfter)}
            </SumLine>
            <p className="pt-2 text-caption text-muted">{plan}</p>
          </div>
        ) : over ? (
          <div role="alert" className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-warn-surface px-3 py-3" data-testid="admin-custom-over">
            <p className="flex items-start gap-2 text-body font-semibold">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
              {t('admin.plan.overTitle')}
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-10 text-body">
              {over.map((v) => (
                <li key={v.kind}>{violationText(v, plan)}</li>
              ))}
            </ul>
            <p className="pl-6 text-caption text-muted">{t('admin.plan.overText')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mobile:grid-cols-1">
              <Field label={t('adminCustom.name')} hint={t('adminCustom.nameHint')}>
                <Input value={name} maxLength={CUSTOM_NAME_MAX} placeholder={t('adminCustom.namePh')} onChange={(e) => setName(e.target.value)} data-testid="admin-custom-name-input" />
              </Field>
              <Field label={t('adminCustom.description')} hint={t('adminCustom.descriptionHint')}>
                <Input value={description} maxLength={CUSTOM_DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} data-testid="admin-custom-description" />
              </Field>
              <Field
                label={t('adminCustom.price', { currency })}
                hint={active ? `${t('adminCustom.priceHint')} ${t('adminCustom.priceKeep')}` : t('adminCustom.priceHint')}
                error={touched && priceBad ? t('adminCustom.priceInvalid', { max: formatMinor(cap, currency) }) : null}
              >
                <Input inputMode="decimal" className="tabular-nums" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="admin-custom-price-input" />
              </Field>
              {active ? (
                <Field label={t('adminCustom.from')} hint={t('adminCustom.fromHint')} error={touched && fromBad ? t('adminCustom.fromHint') : null}>
                  <Input type="datetime-local" className="[color-scheme:inherit]" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="admin-custom-from" />
                </Field>
              ) : (
                <p className="self-end pb-2 text-caption text-muted">{t('adminCustom.fromFirst')}</p>
              )}
            </div>
            <section className="flex flex-col gap-1.5">
              <h3 className="px-1 text-caption font-semibold text-muted">{t('adminCustom.limits')}</h3>
              <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
                <CustomLimitsFields form={limits} onChange={setLimits} />
              </div>
              {touched && 'error' in lim ? (
                <p role="alert" className="px-1 text-caption text-danger-text">
                  {t('admin.invalid', { field: t(FIELD_LABEL[lim.error]) })}
                </p>
              ) : null}
            </section>
            <Field label={t('adminBilling.reason')} error={touched && reasonBad ? t('adminBilling.reasonRequired') : null}>
              <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('adminBilling.reasonPh')} data-testid="admin-custom-reason" />
            </Field>
          </>
        )}
        {error ? (
          <p role="alert" className="text-caption text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** Back to Team / Business (ADR-0086): preview, then the switch; over the target's limits — listed and confirmed. */
function StandardPlanDialog({ a, onDone, onClose }: { a: AdminBillingAccount; onDone: () => void; onClose: () => void }): ReactNode {
  const [plan, setPlan] = useState<'TEAM' | 'ENTERPRISE'>('TEAM');
  const override = useRef(false);
  const currency = a.balance?.currency || 'USD';
  return (
    <MoneyActionDialog
      title={t('adminCustom.backTitle')}
      text={t('adminCustom.backText')}
      action={t('adminCustom.backAction')}
      currency={currency}
      amount={false}
      extra={
        <Segmented<'TEAM' | 'ENTERPRISE'>
          label={t('admin.row.plan')}
          value={plan}
          onChange={setPlan}
          options={[
            { value: 'TEAM', label: t('plan.name.team') },
            { value: 'ENTERPRISE', label: t('plan.name.enterprise') },
          ]}
        />
      }
      run={async (x) => {
        const send = () =>
          adminBilling.setPlan(a.accountId, { plan: Plan[plan], reason: x.reason, requestId: x.requestId, expectedRevision: a.revision, preview: x.preview, overrideLimits: override.current });
        try {
          return await send();
        } catch (e) {
          const list = violationsOf(e);
          if (!list.length || override.current) throw e;
          const name = t(plan === 'TEAM' ? 'plan.name.team' : 'plan.name.enterprise');
          const ok = await confirmAction(t('admin.plan.overTitle'), [...list.map((v) => `• ${violationText(v, name)}`), t('admin.plan.overText')].join('\n'), t('admin.plan.overConfirm'));
          if (!ok) throw e;
          override.current = true;
          return send();
        }
      }}
      onDone={onDone}
      onClose={onClose}
    />
  );
}

import type { PlanLimitViolation } from '@calaba/protocol';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { memo, useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../../../components/ui';
import { t } from '../../../i18n';
import { fixLabel, fixPlace, violationText } from '../../../lib/billing/violations';
import { openFixPlace } from '../../../services/billing';
import { openPlanContact, planContact } from '../../../services/plan';
import { Note } from './parts';

/**
 * Why a plan cannot be chosen now (ADR-0086): one sentence per violation — «У вас создано 6 ботов,
 * а в тарифе Team можно максимум 5…» — each with a button to the place where it is fixed. The
 * list comes from the server (BillingPlanOffer.violations or a 409 PLAN_LIMITS_EXCEEDED); static,
 * no subscriptions.
 */
export const ViolationList = memo(function ViolationList({
  workspaceId,
  plan,
  violations,
  reveal = false,
}: {
  workspaceId: string;
  /** The target plan's name («Team»). */
  plan: string;
  violations: readonly PlanLimitViolation[];
  /** Scroll it into view when it appears (asked for below the plan cards). */
  reveal?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [reveal]);
  return (
    <div ref={ref} role="alert" className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-warn-surface px-3 py-3" data-testid="plan-violations">
      <p className="flex items-start gap-2 text-body font-semibold">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        {t('billing.transition.blockedTitle', { plan })}
      </p>
      <ul className="flex flex-col gap-2 pl-6">
        {violations.map((v) => {
          const place = fixPlace(v);
          return (
            <li key={v.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body" data-testid="plan-violation" data-kind={v.kind}>
              <span className="min-w-0 flex-1 basis-64">{violationText(v, plan)}</span>
              {place ? (
                <Button size="sm" variant="secondary" onClick={() => openFixPlace(workspaceId, place)}>
                  {t(fixLabel(place))}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="pl-6 text-caption text-muted">{t('billing.transition.blockedHint')}</p>
    </div>
  );
});

/** A superadmin assigned the plan: self-serve does not change it (ADR-0086). */
export function AdminAssignedNote(): ReactNode {
  const contact = planContact();
  return (
    <Note icon={<ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />} testId="plan-admin-assigned">
      <span className="flex flex-col items-start gap-2">
        <span>{t('billing.adminAssigned.text')}</span>
        {contact ? (
          <Button size="sm" variant="secondary" onClick={openPlanContact}>
            {t('billing.adminAssigned.contact')}
          </Button>
        ) : null}
      </span>
    </Note>
  );
}

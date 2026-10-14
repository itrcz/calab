import { AdminPriceVersionSchema, Plan, WorkspacePlanSchema } from '@calaba/protocol';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { planDisplayName, setPlanBody, limitsFormFrom, workspacePlanName } from '../plan';
import { customPriceAt, localInputMs, nextCustomPrice, priceStatus } from './customPlan';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 9);
const v = (id: string, unit: bigint, fromDay: number, createdDay: number) =>
  create(AdminPriceVersionSchema, { id, unit: { minor: unit, currency: 'USD' }, effectiveFrom: timestampFromMs(T0 + fromDay * DAY), createdAt: timestampFromMs(T0 + createdDay * DAY) });

describe('custom price versions (ADR-0086)', () => {
  // a: 10 from day 0; b: on day 1 scheduled 20 for day 10; c: on day 2 — 15 from day 5, replaces b.
  const a = v('a', 10n, 0, 0);
  const b = v('b', 20n, 10, 1);
  const c = v('c', 15n, 5, 2);
  const all = [c, b, a];

  it('the newest version whose start has come applies', () => {
    expect(customPriceAt(all, T0 - 1)).toBeUndefined();
    expect(customPriceAt(all, T0 + 4 * DAY)?.id).toBe('a');
    expect(customPriceAt(all, T0 + 5 * DAY)?.id).toBe('c');
    expect(customPriceAt(all, T0 + 11 * DAY)?.id).toBe('c');
  });

  it('the next change and the history statuses', () => {
    expect(nextCustomPrice(all, T0 + 3 * DAY)).toEqual({ version: c, at: T0 + 5 * DAY });
    expect(nextCustomPrice(all, T0 + 6 * DAY)).toBeNull();
    expect(nextCustomPrice([a, b], T0 + 3 * DAY)).toEqual({ version: b, at: T0 + 10 * DAY });
    const now = T0 + 3 * DAY;
    expect(all.map((x) => priceStatus(all, x, now))).toEqual(['scheduled', 'replaced', 'current']);
    expect(all.map((x) => priceStatus(all, x, T0 + 6 * DAY))).toEqual(['current', 'replaced', 'past']);
  });

  it('datetime-local input', () => {
    expect(localInputMs('')).toBeNull();
    expect(localInputMs('garbage')).toBeNull();
    expect(localInputMs('2026-10-12T09:30')).toBe(new Date('2026-10-12T09:30').getTime());
  });
});

describe('custom plan name (ADR-0086)', () => {
  it('falls back to «Индивидуальный», other plans keep their names', () => {
    expect(planDisplayName(Plan.CUSTOM, '  Acme Pro ')).toBe('Acme Pro');
    expect(planDisplayName(Plan.CUSTOM, '   ')).toBe(t('plan.name.custom'));
    expect(planDisplayName(Plan.CUSTOM, undefined)).toBe(t('plan.name.custom'));
    expect(planDisplayName(Plan.TEAM, 'stale')).toBe(t('plan.name.team'));
    expect(planDisplayName(Plan.UNSPECIFIED, '')).toBe(t('plan.name.free'));
    expect(workspacePlanName(create(WorkspacePlanSchema, { plan: Plan.CUSTOM, displayName: 'Нейро-офис' }))).toBe('Нейро-офис');
    expect(workspacePlanName(undefined)).toBe(t('plan.name.free'));
  });

  it('the manual plan form sends the name with CUSTOM only', () => {
    const limits = limitsFormFrom(Plan.FREE, undefined);
    const custom = setPlanBody({ plan: Plan.CUSTOM, limits, validUntil: '', note: '', displayName: ' Acme ', description: ' Contract ' });
    expect('body' in custom && custom.body).toMatchObject({ displayName: 'Acme', description: 'Contract' });
    const team = setPlanBody({ plan: Plan.TEAM, limits, validUntil: '', note: '', displayName: 'Acme' });
    expect('body' in team && 'displayName' in team.body).toBe(false);
  });
});

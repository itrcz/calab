import { create } from '@bufbuild/protobuf';
import { LedgerEntryKind, LedgerEntrySchema, MoneySchema, Plan, PlanLimitKind, PlanLimitViolationSchema } from '@calaba/protocol';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';

vi.mock('../../platform', () => ({ platform: { kind: 'web' } }));

const { ApiError } = await import('../api/client');
const { groupLedger } = await import('./history');
const { fixPlace, violationText, violationsOf } = await import('./violations');

const v = (kind: PlanLimitKind, current: bigint, limit: bigint, rooms = 0) => create(PlanLimitViolationSchema, { kind, current, limit, rooms });

describe('plan violations (ADR-0086)', () => {
  beforeAll(async () => {
    await setLocale('ru');
  });

  it('reads them only from PLAN_LIMITS_EXCEEDED', () => {
    const list = [v(PlanLimitKind.BOTS, 6n, 5n)];
    expect(violationsOf(new ApiError('ERROR_CODE_CONFLICT', '', 409, undefined, { reason: 'PLAN_LIMITS_EXCEEDED', planViolations: list }))).toEqual(list);
    expect(violationsOf(new ApiError('ERROR_CODE_CONFLICT', '', 409, undefined, { reason: 'PLAN_LIMIT' }))).toEqual([]);
    expect(violationsOf(new Error('x'))).toEqual([]);
  });

  it('says one sentence per violation with the right plural', () => {
    expect(violationText(v(PlanLimitKind.BOTS, 6n, 5n), 'Team')).toBe('У вас создано 6 ботов, а в тарифе Team можно максимум 5. Удалите лишних, чтобы перейти на тариф.');
    expect(violationText(v(PlanLimitKind.BOTS, 2n, 1n), 'Free')).toContain('создано 2 бота');
    expect(violationText(v(PlanLimitKind.BOTS, 21n, 20n), 'Business')).toContain('создан 21 бот');
    expect(violationText(v(PlanLimitKind.ROOM_MEMBERS, 30n, 15n, 2), 'Team')).toContain('В 2 голосовых комнатах разрешено до 30 человек');
    expect(violationText(v(PlanLimitKind.SSO, 1n, 0n), 'Team')).toContain('SSO');
    expect(violationText(v(PlanLimitKind.BOARD_FORMS, 3n, 0n), 'Free')).toContain('формы, а в тарифе Free их нет');
  });

  it('links to where the usage is fixed', () => {
    expect(fixPlace(v(PlanLimitKind.MEMBERS, 1n, 1n))).toEqual({ kind: 'settings', tab: 'members' });
    expect(fixPlace(v(PlanLimitKind.AUTOMATIONS, 1n, 0n))).toEqual({ kind: 'boards' });
    expect(fixPlace(v(PlanLimitKind.STORAGE_MB, 1n, 1n))).toBeNull();
  });
});

describe('ledger operations', () => {
  const usd = (minor: bigint) => create(MoneySchema, { minor, currency: 'USD' });
  const e = (id: string, kind: LedgerEntryKind, minor: bigint, operationId = '', sku = '', reason = '') =>
    create(LedgerEntrySchema, { id, kind, amount: usd(minor), operationId, sku, reason });

  it('groups the charge and the compensation of one plan change', () => {
    const rows = groupLedger([
      e('t', LedgerEntryKind.TOPUP, 1500n),
      e('s', LedgerEntryKind.SEAT_CHARGE, -10n, 'op', 'seat.team.day', 'change_plan'),
      e('c', LedgerEntryKind.COMPENSATION, 7n, 'op', 'seat.enterprise.day'),
      e('a', LedgerEntryKind.SEAT_CHARGE, -30n, 'op2', 'seat.enterprise.day', 'activate'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'op', 'entry']);
    const op = rows[1];
    expect(op?.kind === 'op' && { op: op.op, from: op.from, to: op.to, total: op.total }).toEqual({ op: 'change', from: Plan.ENTERPRISE, to: Plan.TEAM, total: -3n });
  });
});

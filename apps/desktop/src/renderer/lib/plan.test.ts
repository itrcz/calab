import { Plan, PlanLimitsSchema, ScreenSharePreset, WorkspacePlanSchema } from '@calaba/protocol';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { ApiError, toApiError } from './api/client';
import {
  FREE_LIMITS,
  PLAN_LABEL,
  allowedCameraPreset,
  atLimit,
  audioTierLocked,
  capAudioKbps,
  allowedStreamPreset,
  cameraPresetLock,
  capFps,
  contactHref,
  limitsFormFrom,
  limitsFromForm,
  planErrorNotice,
  capMax,
  clampToCap,
  planHas,
  planHasIdentity,
  planUsage,
  setPlanBody,
  streamPresetLock,
  validUntilFromInput,
  videoLimitText,
} from './plan';

vi.mock('../platform', () => ({ platform: { kind: 'web' } }));

const { ECONOMY, H720, H1080, ORIGINAL, UNSPECIFIED } = ScreenSharePreset;

describe('preset locks (ADR-0024)', () => {
  it('room lock wins over the plan; UNSPECIFIED plan = no limit', () => {
    expect(streamPresetLock(H1080, H1080, H720)).toBe('plan');
    expect(streamPresetLock(ORIGINAL, H1080, H720)).toBe('room');
    expect(streamPresetLock(H720, H1080, H720)).toBeNull();
    expect(streamPresetLock(ORIGINAL, ORIGINAL, UNSPECIFIED)).toBeNull();
    expect(streamPresetLock(ORIGINAL, ORIGINAL, undefined)).toBeNull();
  });

  it('the picked preset falls to the highest allowed one', () => {
    expect(allowedStreamPreset(H1080, H1080, H720)).toBe(H720);
    expect(allowedStreamPreset(ORIGINAL, ORIGINAL, ECONOMY)).toBe(ECONOMY);
    expect(allowedStreamPreset(H1080, ORIGINAL, UNSPECIFIED)).toBe(H1080);
  });

  it('camera: 1080p locked on free, allowed on team', () => {
    expect(cameraPresetLock(H1080, H720)).toBe('plan');
    expect(cameraPresetLock(H720, H720)).toBeNull();
    expect(cameraPresetLock(H1080, UNSPECIFIED)).toBeNull();
    expect(allowedCameraPreset(H1080, H720)).toBe(H720);
    expect(allowedCameraPreset(H1080, H1080)).toBe(H1080);
  });

  it('fps never above the granted one; 0 = no cap', () => {
    expect(capFps(30, 15)).toBe(15);
    expect(capFps(5, 15)).toBe(5);
    expect(capFps(30, 0)).toBe(30);
    expect(capFps(30, undefined)).toBe(30);
  });

  it('limit texts', () => {
    expect(videoLimitText(H720, 15)).toBe('720p · 15 fps');
    expect(videoLimitText(UNSPECIFIED, 0)).toBe('Без ограничений');
  });
});

describe('plan contact', () => {
  it('only mailto: and http(s)', () => {
    expect(contactHref('mailto:it@gptunnel.ai')).toBe('mailto:it@gptunnel.ai');
    expect(contactHref(' https://calab.io/buy ')).toBe('https://calab.io/buy');
    expect(contactHref('javascript:alert(1)')).toBeNull();
    expect(contactHref('file:///etc/passwd')).toBeNull();
    expect(contactHref('')).toBeNull();
  });
});

describe('toApiError: plan fields', () => {
  it('reads reason / used / limit (uint64 as strings)', async () => {
    const res = new Response(JSON.stringify({ code: 'ERROR_CODE_ROOM_FULL', message: 'full', reason: 'PLAN_LIMIT', used: '5', limit: '5' }), { status: 409 });
    const e = await toApiError(res);
    expect(e.reason).toBe('PLAN_LIMIT');
    expect(e.extra).toEqual({ reason: 'PLAN_LIMIT', used: 5, limit: 5 });
    const plain = await toApiError(new Response(JSON.stringify({ code: 'ERROR_CODE_CONFLICT', message: 'x' }), { status: 409 }));
    expect(plain.extra).toEqual({});
  });
});

describe('planErrorNotice (toasts on API errors)', () => {
  const roomFull = new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409, undefined, { reason: 'PLAN_LIMIT', used: 5, limit: 5 });

  it('409 ROOM_FULL PLAN_LIMIT → «до N человек» with contact; wording by plan', () => {
    expect(planErrorNotice(roomFull, Plan.FREE)).toEqual({ text: 'В бесплатном тарифе до 5 человек в комнате', contact: true });
    expect(planErrorNotice(roomFull, Plan.CUSTOM)?.text).toBe('По тарифу пространства — до 5 человек в комнате');
  });

  it('«тариф не активен» (ADR-0086 amendment): its own wording, no contact', () => {
    const third = new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409, undefined, { reason: 'WORKSPACE_PLAN_INACTIVE', used: 2, limit: 2 });
    expect(planErrorNotice(third, Plan.FREE)).toEqual({ text: 'Тариф не активен — в голосовой комнате сейчас можно быть только вдвоём, пока владелец не подключит тариф.', contact: false });
    const send = new ApiError('ERROR_CODE_FORBIDDEN', 'inactive', 403, undefined, { reason: 'WORKSPACE_PLAN_INACTIVE' });
    expect(planErrorNotice(send, Plan.FREE)?.contact).toBe(false);
  });

  it('a room over its own user limit is not a plan matter', () => {
    expect(planErrorNotice(new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409), Plan.FREE)).toBeNull();
    expect(planErrorNotice(new Error('x'), Plan.FREE)).toBeNull();
  });

  it('413 quota → usage; contact only when the plan is the cause', () => {
    const mb = 1024 * 1024;
    const byPlan = new ApiError('ERROR_CODE_FILE_QUOTA_EXCEEDED', 'quota', 413, undefined, { reason: 'PLAN_LIMIT', used: 900 * mb, limit: 1024 * mb });
    expect(planErrorNotice(byPlan, Plan.FREE)).toEqual({ text: 'Хранилище файлов заполнено: 900,0 МБ из 1,00 ГБ', contact: true });
    const own = new ApiError('ERROR_CODE_FILE_QUOTA_EXCEEDED', 'quota', 413);
    expect(planErrorNotice(own, Plan.TEAM)).toEqual({ text: 'Хранилище файлов пространства заполнено', contact: false });
  });

  it('409 CONFLICT PLAN_LIMIT about bots → the bot limit (ADR-0031)', () => {
    const bots = new ApiError('ERROR_CODE_CONFLICT', 'the workspace plan allows no more bots', 409, undefined, { reason: 'PLAN_LIMIT', used: 2, limit: 2 });
    expect(planErrorNotice(bots, Plan.FREE)).toEqual({ text: 'По тарифу пространства — до 2 ботов', contact: true });
  });

  it('409 CONFLICT PLAN_LIMIT about members / voice quality (owner 28.09)', () => {
    const members = new ApiError('ERROR_CODE_CONFLICT', 'the workspace plan allows 50 members', 409, undefined, { reason: 'PLAN_LIMIT', used: 50, limit: 50 });
    expect(planErrorNotice(members, Plan.FREE)).toEqual({ text: 'Лимит тарифа Free: 50 участников', contact: true });
    expect(planErrorNotice(members, Plan.ENTERPRISE)?.text).toBe('Лимит тарифа Business: 50 участников');
    const voice = new ApiError('ERROR_CODE_CONFLICT', 'the workspace plan allows 16 kbps of voice quality', 409, undefined, { reason: 'PLAN_LIMIT', used: 32, limit: 16 });
    expect(planErrorNotice(voice, Plan.FREE)).toEqual({ text: 'Доступно в платном тарифе', contact: true });
  });
});

describe('30.09 lineup: Business naming, features by plan', () => {
  it('PLAN_ENTERPRISE is shown as Business; Team and Business name their plan in the room toast', () => {
    expect(t(PLAN_LABEL[Plan.ENTERPRISE])).toBe('Business');
    const roomFull = new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409, undefined, { reason: 'PLAN_LIMIT', used: 15, limit: 15 });
    expect(planErrorNotice(roomFull, Plan.TEAM)?.text).toBe('На тарифе Team — до 15 человек в комнате');
    expect(planErrorNotice(roomFull, Plan.ENTERPRISE)?.text).toBe('На тарифе Business — до 15 человек в комнате');
  });

  it('CalDAV is a feature, not a count: its refusal says Team and above', () => {
    const e = new ApiError('ERROR_CODE_CONFLICT', 'CalDAV is not included in the plan', 409, undefined, { reason: 'PLAN_LIMIT', used: 0, limit: 0 });
    expect(planErrorNotice(e, Plan.FREE)).toEqual({ text: 'CalDAV доступен на тарифах Team и выше', contact: true });
  });

  it('boards over the plan get their own text', () => {
    const e = new ApiError('ERROR_CODE_CONFLICT', 'the workspace plan allows 30 boards', 409, undefined, { reason: 'PLAN_LIMIT', used: 30, limit: 30 });
    expect(planErrorNotice(e, Plan.TEAM)?.text).toBe('Лимит тарифа Team: 30 досок');
  });

  it('planHas: a missing plan or flag allows; the disabled flags lock', () => {
    const p = (limits: MessageInitShape<typeof PlanLimitsSchema>) => create(WorkspacePlanSchema, { plan: Plan.FREE, limits: create(PlanLimitsSchema, limits) });
    expect(planHas(undefined, 'caldav')).toBe(true);
    expect(planHas(p({}), 'caldav')).toBe(true);
    expect(planHas(p({ caldavDisabled: true }), 'caldav')).toBe(false);
    expect(planHas(p({ caldavDisabled: true }), 'musician')).toBe(true);
    expect(planHas(p({ musicianDisabled: true }), 'musician')).toBe(false);
  });
});

describe('voice tier and counted limits (owner 28.09)', () => {
  it('tiers above the plan cap are locked; 0 / undefined = none', () => {
    expect([8, 16, 32, 64].filter((k) => audioTierLocked(k, 16))).toEqual([32, 64]);
    expect(audioTierLocked(64, 0)).toBe(false);
    expect(audioTierLocked(64, undefined)).toBe(false);
    expect(capAudioKbps(32, 16)).toBe(16);
    expect(capAudioKbps(8, 16)).toBe(8);
    expect(capAudioKbps(64, 0)).toBe(64);
  });

  it('at the limit when used ≥ limit; no limit never', () => {
    expect(atLimit(50, 50)).toBe(true);
    expect(atLimit(49, 50)).toBe(false);
    expect(atLimit(1000, 0)).toBe(false);
    expect(atLimit(1000, undefined)).toBe(false);
  });
});

describe('admin CUSTOM form', () => {
  it('starts from the free limits unless the workspace is custom already', () => {
    const f = limitsFormFrom(Plan.FREE, undefined);
    expect(f.roomMembers).toBe(String(FREE_LIMITS.roomMembers));
    expect(f.storageMb).toBe('5120');
    expect(f.streamMaxPreset).toBe(H720);
    expect(f).toMatchObject({ members: '50', bots: '1', stickerPacks: '1', audioTierMaxKbps: 16 });
    const custom = create(PlanLimitsSchema, { roomMembers: 12, storageMb: 5120n, streamMaxPreset: H1080 });
    expect(limitsFormFrom(Plan.CUSTOM, custom)).toMatchObject({ roomMembers: '12', storageMb: '5120', streamMaxPreset: H1080, cameraMaxFps: '0' });
    // Team → Custom: the free defaults, not Team's.
    expect(limitsFormFrom(Plan.TEAM, custom).roomMembers).toBe('5');
    expect(limitsFormFrom(Plan.ENTERPRISE, custom).storageMb).toBe('5120');
  });

  it('validates whole numbers ≥ 0 (empty = 0 = no limit)', () => {
    const f = limitsFormFrom(Plan.FREE, undefined);
    expect(limitsFromForm({ ...f, roomMembers: '' })).toMatchObject({ limits: { roomMembers: 0 } });
    expect(limitsFromForm({ ...f, streamMaxFps: '2.5' })).toEqual({ error: 'streamMaxFps' });
    expect(limitsFromForm({ ...f, members: '-1' })).toEqual({ error: 'members' });
    expect(limitsFromForm(f)).toMatchObject({ limits: { storageMb: 5120n, cameraMaxPreset: H720, members: 50, bots: 1, stickerPacks: 1, audioTierMaxKbps: 16 } });
    expect(limitsFromForm({ ...f, bots: '1001' })).toEqual({ error: 'bots' });
  });

  it('PUT body: limits only with CUSTOM, end of the chosen day, trimmed note', () => {
    const limits = limitsFormFrom(Plan.FREE, undefined);
    const team = setPlanBody({ plan: Plan.TEAM, limits, validUntil: '2026-12-31', note: '  счёт 42 ' });
    expect(team).toEqual({ body: { plan: Plan.TEAM, validUntil: new Date('2026-12-31T23:59:59Z'), note: 'счёт 42' } });
    expect(setPlanBody({ plan: Plan.ENTERPRISE, limits, validUntil: '', note: '' })).toEqual({ body: { plan: Plan.ENTERPRISE, note: '' } });
    const custom = setPlanBody({ plan: Plan.CUSTOM, limits: { ...limits, roomMembers: '10' }, validUntil: '', note: '' });
    expect('body' in custom && custom.body.limits?.roomMembers).toBe(10);
    expect('body' in custom ? custom.body.validUntil : null).toBeUndefined();
    expect(setPlanBody({ plan: Plan.CUSTOM, limits: { ...limits, storageMb: 'x' }, validUntil: '', note: '' })).toEqual({ error: 'storageMb' });
    expect(validUntilFromInput('garbage')).toBeNull();
  });

  it('ADR-0058 §5: the CUSTOM form carries checklists / board webhooks (new: checklists on, webhooks off)', () => {
    const fresh = limitsFormFrom(Plan.FREE, undefined);
    expect(fresh).toMatchObject({ checklistsDisabled: false, boardWebhooksDisabled: true });
    const stored = create(PlanLimitsSchema, { checklistsDisabled: true, boardWebhooksDisabled: false });
    expect(limitsFormFrom(Plan.CUSTOM, stored)).toMatchObject({ checklistsDisabled: true, boardWebhooksDisabled: false });
    const body = setPlanBody({ plan: Plan.CUSTOM, limits: fresh, validUntil: '', note: '' });
    // Saving the form without touching them does not switch webhooks on.
    expect('body' in body && body.body.limits).toMatchObject({ checklistsDisabled: false, boardWebhooksDisabled: true });
  });
});

describe('ADR-0058 §5: checklists and board webhooks by plan', () => {
  const plan = (l: MessageInitShape<typeof PlanLimitsSchema>) => create(WorkspacePlanSchema, { plan: Plan.FREE, limits: l });
  it('planHas reads the flags; the 409 PLAN_LIMIT texts name the plan', () => {
    expect(planHas(plan({ checklistsDisabled: true }), 'checklists')).toBe(false);
    expect(planHas(plan({ checklistsDisabled: true }), 'boardWebhooks')).toBe(true);
    expect(planHas(plan({ boardWebhooksDisabled: true }), 'boardWebhooks')).toBe(false);
    expect(planHas(undefined, 'boardWebhooks')).toBe(true);
    const err = (msg: string) => new ApiError('ERROR_CODE_CONFLICT', msg, 409, undefined, { reason: 'PLAN_LIMIT', used: 0, limit: 0 });
    expect(planErrorNotice(err('checklists is not included in the plan'), Plan.FREE)?.text).toBe(t('plan.checklistsLocked'));
    expect(planErrorNotice(err('board_webhooks is not included in the plan'), Plan.TEAM)?.text).toBe(t('plan.boardWebhooksLocked'));
  });
});

describe('ADR-0046 (owner 02.10): telephony is Business only', () => {
  it('planHas, the 409 text and a new CUSTOM form without telephony', () => {
    const plan = (l: MessageInitShape<typeof PlanLimitsSchema>) => create(WorkspacePlanSchema, { plan: Plan.TEAM, limits: l });
    expect(planHas(plan({ telephonyDisabled: true }), 'telephony')).toBe(false);
    expect(planHas(plan({}), 'telephony')).toBe(true);
    expect(planHas(undefined, 'telephony')).toBe(true);
    const err = new ApiError('ERROR_CODE_CONFLICT', 'telephony is not included in the plan', 409, undefined, { reason: 'PLAN_LIMIT', used: 0, limit: 0 });
    expect(planErrorNotice(err, Plan.TEAM)?.text).toBe(t('plan.telephonyLocked'));
    const fresh = limitsFormFrom(Plan.TEAM, undefined);
    expect(fresh.telephonyDisabled).toBe(true);
    expect(limitsFormFrom(Plan.CUSTOM, create(PlanLimitsSchema, { telephonyDisabled: false })).telephonyDisabled).toBe(false);
    const body = setPlanBody({ plan: Plan.CUSTOM, limits: fresh, validUntil: '', note: '' });
    expect('body' in body && body.body.limits?.telephonyDisabled).toBe(true);
  });
});

describe('planUsage', () => {
  it('fullest room, most streams in one room, members without guests', () => {
    const voice = [
      { roomId: 'a', streaming: true },
      { roomId: 'a', streaming: false },
      { roomId: 'b', streaming: true },
      { roomId: 'b', streaming: true },
      { roomId: 'b', streaming: false },
      { roomId: '', streaming: false },
    ];
    expect(planUsage(voice, [{ guest: false }, { guest: true }, { guest: false, bot: true }])).toEqual({ roomPeak: 3, streamPeak: 2, members: 2, bots: 1 });
    expect(planUsage([], [])).toEqual({ roomPeak: 0, streamPeak: 0, members: 0, bots: 0 });
  });
});

describe('plan caps for workspace voice defaults (#42)', () => {
  it('clampToCap = min(value, cap); 0 means no plan limit', () => {
    expect(clampToCap(3, 1)).toBe(1);
    expect(clampToCap(1, 3)).toBe(1);
    expect(clampToCap(6, 0)).toBe(6);
  });
  it('capMax limits the selectable range', () => {
    expect(capMax(10, 1)).toBe(1);
    expect(capMax(10, 0)).toBe(10);
    expect(capMax(10, 99)).toBe(10);
  });
  it('planHasIdentity: SSO / OAuth provider only on a current Business plan (ADR-0054 §5)', () => {
    expect(planHasIdentity(undefined)).toBe(true);
    expect(planHasIdentity(create(WorkspacePlanSchema, { plan: Plan.ENTERPRISE }))).toBe(true);
    expect(planHasIdentity(create(WorkspacePlanSchema, { plan: Plan.ENTERPRISE, expired: true }))).toBe(false);
    for (const plan of [Plan.UNSPECIFIED, Plan.FREE, Plan.TEAM, Plan.CUSTOM]) expect(planHasIdentity(create(WorkspacePlanSchema, { plan }))).toBe(false);
  });
});

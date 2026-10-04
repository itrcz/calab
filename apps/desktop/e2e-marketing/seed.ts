import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import type { Browser } from '@playwright/test';
import { AttendeeStatus, BoardTemplate, EventRepeat, PresenceStatus, ReactionSchema, RoomInviteSchema, TaskPriority, TaskRelationKind, VoiceInfoSchema, WorkspaceRole, type Message } from '@calaba/protocol';
import { IDS, fileMeta, mockId, ts, VOICE_WAVEFORM } from '../e2e-support/fixtures';
import type { MockServer } from '../e2e-support/mock-server';
import { mockupHtml, pdfBytes, render } from './art';
import type { Copy, PersonKey } from './copy';
import { avatarPhoto } from './photos';

/**
 * The landing scenes' data (docs/09 #139) on top of the mock's `data` scenario: the fixture ids
 * stay (the app, the calendar and the boards mock rely on them), every visible name and text is
 * replaced by the page language's `Copy`, and the chat, the meetings, the board and the notes are
 * rebuilt as one believable working day (Thursday 15 January 2026, NOW = 13:30 Moscow time).
 * Everything is set before the client signs in, so READY carries it (no live events needed).
 */

const U = IDS.users;
const R = IDS.rooms;
const W = IDS.workspaces;
const KEYS: PersonKey[] = ['anna', 'boris', 'vera', 'grigory', 'dina'];

/** Moscow wall time on NOW's day → ms. */
export const msk = (hhmm: string, day = '2026-01-15'): number => Date.parse(`${day}T${hhmm}:00+03:00`);

/** Extra rooms / files of the scenes, in their own id ranges (never clash with the fixtures). */
export const SCENE = {
  files: {
    mockup: mockId('file', 0x61),
    report: mockId('file', 0x62),
    voice: mockId('file', 0x63),
    avatars: { anna: mockId('file', 0x64), boris: mockId('file', 0x65), vera: IDS.files.veraAvatar, grigory: mockId('file', 0x66), dina: mockId('file', 0x67) } as Record<PersonKey, string>,
  },
  meetingLink: 'meeting-guest-link',
} as const;

export interface Sticker {
  name: string;
  emoji: string;
  bytes: Buffer;
}

export interface Art {
  mockup: Buffer;
  avatars: Record<PersonKey, Buffer>;
  stickers: Sticker[];
}

/** Real built-in Calab stickers (apps/server/internal/builtinstickers, 512×512 still WebP) for the «Calab» pack. */
const STICKERS_DIR = resolve(import.meta.dirname, '../../server/internal/builtinstickers');
const STICKER_NAMES = ['like', 'fire', 'cool'] as const;
const STICKER_SIZE = 512;

function builtinStickers(): Sticker[] {
  const manifest = JSON.parse(readFileSync(resolve(STICKERS_DIR, 'manifest.json'), 'utf8')) as { stickers: { name: string; emoji: string }[] };
  return STICKER_NAMES.map((name) => ({
    name,
    emoji: manifest.stickers.find((x) => x.name === name)?.emoji ?? '',
    bytes: readFileSync(resolve(STICKERS_DIR, 'assets', `${name}.webp`)),
  }));
}

export async function drawArt(browser: Browser, c: Copy): Promise<Art> {
  const avatars = {} as Record<PersonKey, Buffer>;
  for (const k of KEYS) avatars[k] = avatarPhoto(k);
  return { mockup: await render(browser, mockupHtml(c), 1600, 900), avatars, stickers: builtinStickers() };
}

/** Freezes a message at a Moscow wall time (runtime messages get the mock's tick clock). */
function at(m: Message, hhmm: string, day?: string): Message {
  m.createdAt = timestampFromMs(msk(hhmm, day));
  return m;
}

function react(mock: MockServer, m: Message, list: Record<string, PersonKey[]>): void {
  const map = new Map(Object.entries(list).map(([e, who]) => [e, new Set(who.map((k) => U[k]))]));
  mock.state.reactions.set(m.id, map);
  m.reactions = Object.entries(list).map(([emoji, who]) => create(ReactionSchema, { emoji, count: who.length, me: who.includes('anna') }));
}

export function seedScene(mock: MockServer, c: Copy, art: Art): void {
  const s = mock.state;

  // ---- people: names, statuses, photo avatars, presence
  for (const k of KEYS) {
    const rec = s.users.get(U[k]);
    if (!rec) continue;
    rec.user.displayName = c.people[k].name;
    rec.user.statusText = c.people[k].status;
    rec.user.timezone = 'Europe/Moscow';
    const id = SCENE.files.avatars[k];
    s.files.set(id, {
      meta: fileMeta(id, '', U[k], 'avatar.jpg', 'image/jpeg', art.avatars[k], ts('2025-12-02T10:00:00Z'), { width: 256, height: 256 }),
      bytes: art.avatars[k],
      thumbnail: { bytes: art.avatars[k], mime: 'image/jpeg' },
    });
    rec.user.avatarFileId = id;
  }
  // Дина is the team's QA here, a full member (the fixture has her as a guest).
  for (const m of s.members) if (m.userId === U.dina && m.workspaceId === W.main) m.role = WorkspaceRole.MEMBER;
  const dinaRec = s.users.get(U.dina);
  if (dinaRec) dinaRec.user.isGuest = false;
  const presence = (k: PersonKey, status: PresenceStatus): void => {
    const p = s.presences.get(U[k]);
    if (p) p.status = status;
  };
  presence('anna', PresenceStatus.ONLINE);
  presence('boris', PresenceStatus.ONLINE);
  presence('vera', PresenceStatus.ONLINE);
  presence('grigory', PresenceStatus.IDLE);
  presence('dina', PresenceStatus.ONLINE);

  // ---- workspaces, categories, rooms
  const ws = (id: string, name: string): void => {
    const w = s.workspaces.get(id);
    if (w) w.name = name;
  };
  ws(W.main, c.company);
  ws(W.design, c.otherWorkspaces[0]);
  ws(W.community, c.otherWorkspaces[1]);
  const cat = (id: string, name: string): void => {
    const x = s.categories.get(id);
    if (x) x.name = name;
  };
  cat(IDS.categories.dev, c.categories.product);
  cat(IDS.categories.voice, c.categories.voice);
  const room = (id: string, name: string, topic?: string): void => {
    const r = s.rooms.get(id);
    if (!r) return;
    r.name = name;
    if (topic !== undefined) r.topic = topic;
  };
  room(R.general, c.rooms.general, c.topics.general);
  room(R.dev, c.rooms.dev, c.topics.dev);
  room(R.longPrivate, c.rooms.releases, c.topics.releases);
  room(R.call, c.rooms.standup, '');
  room(R.meeting, c.rooms.meeting, c.topics.meeting);
  // The fixture caps «Переговорка» at 4; the shots show five people in it (a «05/04» counter in red looks like an error).
  const meeting = s.rooms.get(R.meeting);
  if (meeting) meeting.userLimit = 12;
  // Guests see only the rooms they were let into (the fixture opens some rooms to the guest role).
  for (const r of s.rooms.values()) r.permissionOverrides = r.permissionOverrides.filter((o) => o.targetId !== 'guest');
  // The other workspaces' rooms are never opened; keep them but give them neutral names.
  room(R.designMockups, c.rooms.general);
  room(R.designReview, c.rooms.meeting);
  room(R.communityWelcome, c.rooms.general);

  // ---- nobody in voice at the start (the voice scene joins people itself)
  s.voiceStates.clear();

  // ---- files: the mockup, the regression report, a voice note
  const mockup = art.mockup;
  s.files.set(SCENE.files.mockup, {
    meta: fileMeta(SCENE.files.mockup, W.main, U.vera, c.chat.mockupFile, 'image/png', mockup, ts('2026-01-15T07:02:00Z'), { width: 1600, height: 900 }),
    bytes: mockup,
    thumbnail: { bytes: mockup, mime: 'image/png' },
  });
  const pdf = pdfBytes(c.chat.reportFile);
  s.files.set(SCENE.files.report, { meta: fileMeta(SCENE.files.report, W.main, U.dina, c.chat.reportFile, 'application/pdf', pdf, ts('2026-01-15T07:15:00Z')), bytes: pdf });
  const noteBytes = readFileSync(resolve(import.meta.dirname, '../e2e-support/fixtures/voice-note.ogg'));
  const noteMeta = fileMeta(SCENE.files.voice, W.main, U.boris, 'voice-2026-01-15-10-20-00.ogg', 'audio/ogg', noteBytes, ts('2026-01-15T07:20:00Z'));
  noteMeta.voice = create(VoiceInfoSchema, { durationMs: 17_400, waveform: VOICE_WAVEFORM });
  s.files.set(SCENE.files.voice, { meta: noteMeta, bytes: noteBytes });

  // ---- stickers: the «Calab» pack made of real built-in Calab stickers
  const pack = s.stickerPacks.get(IDS.stickerPacks.calab);
  const stickerFiles = [IDS.files.stickerSun, IDS.files.stickerGem, IDS.files.stickerOrbit];
  pack?.stickers.forEach((st, i) => {
    const sticker = art.stickers[i];
    const fid = stickerFiles[i];
    if (!sticker || !fid) return;
    const { bytes } = sticker;
    st.emoji = sticker.emoji || st.emoji;
    st.animated = false;
    s.files.set(fid, {
      meta: fileMeta(fid, W.main, U.anna, `${sticker.name}.webp`, 'image/webp', bytes, ts('2026-01-12T10:00:00Z'), { width: STICKER_SIZE, height: STICKER_SIZE }),
      bytes,
      thumbnail: { bytes, mime: 'image/webp' },
    });
  });

  // ---- chat «общий»: this morning (the fixture history is replaced)
  for (const id of [R.general, R.dev, R.longPrivate, R.call, R.meeting]) s.messages.set(id, []);
  const post = (room: string, k: PersonKey, hhmm: string, content: string, extra: { attachments?: string[]; replyToId?: string; stickerId?: string } = {}): Message =>
    at(mock.injectMessage({ roomId: room, authorId: U[k], content, ...extra }), hhmm);
  post(R.dev, 'grigory', '09:40', c.chat.report);
  post(R.longPrivate, 'boris', '09:45', c.slide.footer);
  const kickoff = post(R.general, 'boris', '09:58', c.chat.kickoff);
  react(mock, kickoff, { '🔥': ['anna', 'vera', 'grigory'], '🎉': ['dina'] });
  post(R.general, 'boris', '10:01', `@${U.anna} ${c.chat.mention}`);
  post(R.general, 'anna', '10:03', c.chat.answer);
  const report = post(R.general, 'dina', '10:15', c.chat.report, { attachments: [SCENE.files.report] });
  react(mock, report, { '👍': ['anna', 'boris'] });
  post(R.general, 'boris', '10:20', c.chat.voiceIntro);
  post(R.general, 'boris', '10:20', '', { attachments: [SCENE.files.voice] });
  const mock1 = post(R.general, 'vera', '10:32', c.chat.mockupCaption, { attachments: [SCENE.files.mockup] });
  react(mock, mock1, { '😍': ['anna', 'boris'], '👍': ['grigory'] });
  post(R.general, 'grigory', '10:35', c.chat.reply, { replyToId: mock1.id });
  post(R.general, 'anna', '10:36', '', { stickerId: IDS.stickers.sun });

  // ---- direct messages with Борис
  s.messages.set(IDS.dms.boris, []);
  post(IDS.dms.boris, 'boris', '11:40', c.dm.hi);
  post(IDS.dms.boris, 'anna', '11:44', c.dm.answer);
  post(IDS.dms.boris, 'boris', '13:10', c.dm.checklist);
  post(IDS.dms.boris, 'boris', '13:28', c.dm.callAsk);
  for (const m of s.messages.get(IDS.dms.vera) ?? []) m.content = c.chat.mockupCaption;
  for (const m of s.messages.get(IDS.dms.grigory) ?? []) m.content = c.people.grigory.status;

  // ---- read states: Анна has read everything (a clean sidebar) except Борис's last DM
  const last = (rid: string): string => s.messages.get(rid)?.at(-1)?.id ?? '';
  for (const k of KEYS) {
    const reads = new Map([...s.messages.keys()].map((rid) => [rid, last(rid)]));
    s.readStates.set(U[k], reads);
  }
  const dmBoris = s.messages.get(IDS.dms.boris) ?? [];
  s.readStates.get(U.anna)?.set(IDS.dms.boris, dmBoris.at(-2)?.id ?? '');

  // ---- a guest link for the meeting room
  s.roomInvites.set(
    mockId('invite', 0x61),
    create(RoomInviteSchema, {
      id: mockId('invite', 0x61),
      roomId: R.meeting,
      workspaceId: W.main,
      code: SCENE.meetingLink,
      createdBy: U.anna,
      maxUses: 0,
      uses: 0,
      allowGuests: true,
      allowSpeak: true,
      allowMessages: true,
      allowFiles: false,
      allowStream: false,
      expiresAt: ts('2099-01-01T00:00:00Z'),
      createdAt: ts('2026-01-14T09:00:00Z'),
    }),
  );
}

/** The day's meetings (calendar scenes); returns the planning meeting's id. */
export function seedMeetings(mock: MockServer, c: Copy): string {
  const cal = c.calendar;
  const ev = (a: Parameters<MockServer['addEvent']>[0]): string => mock.addEvent(a).id;
  ev({ workspaceId: W.main, title: cal.release, startMs: msk('00:00'), endMs: msk('00:00', '2026-01-16'), allDay: true, tz: 'Europe/Moscow', attendees: [{ userId: U.boris, status: AttendeeStatus.ACCEPTED }, { userId: U.vera, status: AttendeeStatus.ACCEPTED }] });
  ev({ workspaceId: W.main, organizerId: U.boris, title: cal.standup, startMs: msk('10:30', '2026-01-12'), endMs: msk('10:45', '2026-01-12'), roomId: R.call, repeat: EventRepeat.DAILY, attendees: [{ userId: U.anna, status: AttendeeStatus.ACCEPTED }, { userId: U.vera, status: AttendeeStatus.ACCEPTED }, { userId: U.grigory, status: AttendeeStatus.ACCEPTED }] });
  ev({ workspaceId: W.main, organizerId: U.vera, title: cal.designReview, startMs: msk('11:00'), endMs: msk('12:00'), roomId: R.meeting, attendees: [{ userId: U.anna, status: AttendeeStatus.ACCEPTED }, { userId: U.dina, status: AttendeeStatus.ACCEPTED }] });
  ev({ workspaceId: W.main, title: cal.oneOnOne, startMs: msk('12:30'), endMs: msk('13:00'), attendees: [{ userId: U.boris, status: AttendeeStatus.ACCEPTED }] });
  const planning = ev({
    workspaceId: W.main,
    organizerId: U.boris,
    title: cal.planning,
    description: cal.planningAgenda,
    startMs: msk('14:00'),
    endMs: msk('15:00'),
    roomId: R.meeting,
    record: true,
    attendees: [
      { userId: U.anna, status: AttendeeStatus.ACCEPTED },
      { userId: U.vera, status: AttendeeStatus.ACCEPTED },
      { userId: U.grigory, required: false, status: AttendeeStatus.MAYBE },
      { userId: U.dina, status: AttendeeStatus.ACCEPTED },
      { email: cal.external, required: false },
    ],
  });
  ev({ workspaceId: W.main, organizerId: U.grigory, title: cal.interview, startMs: msk('14:30'), endMs: msk('15:30'), attendees: [{ userId: U.anna, status: AttendeeStatus.ACCEPTED }] });
  ev({ workspaceId: W.main, title: cal.demo, startMs: msk('16:00'), endMs: msk('17:00'), roomId: R.meeting, attendees: [{ userId: U.boris, status: AttendeeStatus.ACCEPTED }, { email: cal.external }] });
  ev({ workspaceId: W.main, organizerId: U.vera, title: cal.retro, startMs: msk('17:30'), endMs: msk('18:15'), roomId: R.meeting, attendees: [{ userId: U.anna, status: AttendeeStatus.ACCEPTED }, { userId: U.boris, status: AttendeeStatus.ACCEPTED }, { userId: U.grigory }] });
  // Next week: dots in the mini month.
  ev({ workspaceId: W.main, title: cal.demo, startMs: msk('12:00', '2026-01-20'), endMs: msk('13:00', '2026-01-20'), roomId: R.meeting });
  ev({ workspaceId: W.main, title: cal.retro, startMs: msk('16:00', '2026-01-22'), endMs: msk('17:00', '2026-01-22'), roomId: R.meeting });
  // Free / busy for «Подобрать время»: Вера's external calendar and Борис's private meeting.
  mock.setBusy(U.vera, [{ startMs: msk('16:00'), endMs: msk('17:00') }, { startMs: msk('11:00', '2026-01-16'), endMs: msk('12:30', '2026-01-16') }]);
  mock.addEvent({ workspaceId: W.main, organizerId: U.boris, title: '—', startMs: msk('11:00', '2026-01-16'), endMs: msk('12:00', '2026-01-16'), attendees: [{ userId: U.grigory }] });
  return planning;
}

const PRIORITY: Record<string, TaskPriority> = {
  urgent: TaskPriority.URGENT,
  high: TaskPriority.HIGH,
  medium: TaskPriority.MEDIUM,
  low: TaskPriority.LOW,
  none: TaskPriority.NONE,
};

/**
 * The task board «Продукт» (key APP) replacing the fixture's boards: six localized statuses,
 * labels, a milestone, a dozen tasks with dates (the timeline), the opened task's subtasks,
 * a relation and chat-like comments. Returns the opened task's key.
 */
export function seedBoard(mock: MockServer, c: Copy): string {
  const b = mock.boards;
  const host = (b as unknown as { host: { fanout: unknown; tick: () => unknown } }).host;
  const quiet = host.fanout;
  const clock = host.tick;
  let n = 0;
  host.fanout = () => undefined;
  host.tick = () => timestampFromMs(Date.parse('2026-01-12T07:00:00Z') + n++ * 7 * 60_000);
  try {
    for (const t of b.tasks.values()) mock.state.rooms.delete(t.task.roomId);
    b.boards.clear();
    b.tasks.clear();
    b.roomTask.clear();
    b.activity.length = 0;
    const anna = U.anna;
    const board = b.createBoard(W.main, anna, { name: c.board.name, key: 'APP', emoji: '🚀', isPrivate: false, description: c.board.description, template: BoardTemplate.DEVELOPMENT });
    board.board.statuses.forEach((st, i) => (st.name = c.board.statuses[i] ?? st.name));
    const id = board.board.id;
    const colors = { bug: 0xff453a, feature: 0xbf5af2, design: 0x0a84ff, infra: 0x30d158 } as const;
    for (const [k, color] of Object.entries(colors)) b.createLabel(id, anna, { name: c.board.labels[k as keyof typeof colors], color });
    b.createMilestone(id, anna, { name: c.board.milestone, dueOn: '2026-01-23' });
    const label = (k: string): string => board.board.labels.find((l) => l.name === c.board.labels[k as keyof typeof colors])?.id ?? '';
    const milestone = board.board.milestones[0]?.id ?? '';
    const status = (i: number): string => board.board.statuses[i]?.id ?? '';
    const created = c.board.tasks.map((t) =>
      b.createTask(id, anna, {
        title: t.title,
        description: '',
        statusId: status(t.status),
        priority: PRIORITY[t.priority] ?? TaskPriority.NONE,
        assignees: [...(t.lead ? [{ userId: U[t.lead], isLead: true, note: '' }] : []), ...(t.helpers ?? []).map((h) => ({ userId: U[h], isLead: false, note: '' }))],
        labelIds: (t.labels ?? []).map(label),
        startOn: t.start ?? '',
        dueOn: t.due ?? '',
        estimate: t.estimate ?? 0,
        parentId: '',
        milestoneId: t.milestone ? milestone : '',
        afterTaskId: '',
      }),
    );
    const open = created[c.board.open.index];
    if (!open) throw new Error('no task to open');
    b.updateTask(open.task.id, anna, { description: c.board.open.description });
    c.board.open.subtasks.forEach((title, i) =>
      b.createTask(id, anna, {
        title,
        description: '',
        statusId: status(i === 0 ? 4 : 2),
        priority: TaskPriority.NONE,
        assignees: [{ userId: i === 0 ? U.boris : U.anna, isLead: true, note: '' }],
        labelIds: [],
        startOn: '',
        dueOn: '',
        estimate: 0,
        parentId: open.task.id,
        milestoneId: '',
        afterTaskId: '',
      }),
    );
    // «Эхо» blocks «Напоминания» (the timeline's late-blocker marker).
    const blocked = created[3];
    if (blocked) b.setRelation(open.task.id, anna, blocked.task.id, TaskRelationKind.BLOCKS, true);
    // Comments: a chat in the task's room.
    const times = ['09:10', '09:25', '09:31'];
    c.board.open.comments.forEach(([k, text], i) => {
      const m = at(mock.injectMessage({ roomId: open.task.roomId, authorId: U[k], content: text }), times[i] ?? '09:40');
      if (i === 0) react(mock, m, { '👍': ['anna', 'vera'] });
    });
    for (const t of b.tasks.values()) t.unread.clear();
    const mk = b.createBoard(W.main, anna, { name: c.board.marketing, key: 'MKT', emoji: '📣', isPrivate: false, description: '', template: BoardTemplate.SIMPLE });
    mk.board.statuses.forEach((st, i) => (st.name = [c.board.statuses[1], c.board.statuses[2], c.board.statuses[4]][i] ?? st.name));
    return open.task.key;
  } finally {
    host.fanout = quiet;
    host.tick = clock;
  }
}

/** «Заметки»: three shelves, the first one with a few notes and a forwarded message. */
export function seedNotes(mock: MockServer, c: Copy): string {
  const ids = c.notes.shelves.map(([name, emoji]) => mock.addShelf(U.anna, name, emoji));
  const first = ids[0] ?? '';
  const times = ['09:12', '11:05', '12:48'];
  c.notes.items.forEach((text, i) => at(mock.injectMessage({ roomId: first, authorId: U.anna, content: text }), times[i] ?? '12:50'));
  at(mock.injectMessage({ roomId: first, authorId: U.anna, content: c.notes.forwarded, forward: { authorId: U.vera, sentAtMs: msk('16:05', '2026-01-14'), roomId: R.general } }), '13:02');
  const second = ids[1];
  if (second) at(mock.injectMessage({ roomId: second, authorId: U.anna, content: 'https://calab.io' }), '10:00');
  const third = ids[2];
  if (third) at(mock.injectMessage({ roomId: third, authorId: U.anna, content: c.slide.items.join('\n') }), '12:00');
  return first;
}

import { create } from '@bufbuild/protobuf';
import { MessageSchema, TaskNoticeEntrySchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useInbox } from './inbox';
import { inboxRows, unreadNoticeTasks } from './inboxUnread';

const mention = (id: string) => create(MessageSchema, { id, roomId: 'a' });
const notice = (id: string, taskId: string) => create(TaskNoticeEntrySchema, { id, taskId });

describe('inboxRows (ADR-0141)', () => {
  it('interleaves mentions and task notices by id, newest first; only the newest notice of a task is latest', () => {
    const rows = inboxRows([mention('06'), mention('02')], [notice('05', 't1'), notice('04', 't2'), notice('03', 't1')]);
    expect(rows.map((r) => r.id)).toEqual(['06', '05', '04', '03', '02']);
    expect(rows.filter((r) => r.latest).map((r) => r.id)).toEqual(['05', '04']);
    expect(rows[0]?.m?.id).toBe('06');
    expect(rows[1]?.e?.taskId).toBe('t1');
  });
});

describe('useInbox task notices (ADR-0141)', () => {
  beforeEach(() => useInbox.getState().reset());

  it('history and live notices merge without duplicates, newest first; «has more» follows the oldest page', () => {
    const s = useInbox.getState();
    s.addNotices([notice('03', 't1'), notice('01', 't2')], true, false);
    s.addPage([], false, false);
    s.addLiveNotice(notice('05', 't1'));
    s.addLiveNotice(notice('03', 't1'));
    expect(useInbox.getState().notices.map((e) => e.id)).toEqual(['05', '03', '01']);
    expect(useInbox.getState().noticesHasMore).toBe(true);
    useInbox.getState().addNotices([notice('00', 't2')], false, true);
    expect(useInbox.getState().noticesHasMore).toBe(false);
    // A newest-page refresh does not reset «has more» of older pages.
    useInbox.getState().addNotices([], true, false);
    expect(useInbox.getState().noticesHasMore).toBe(false);
  });

  it('a task gone for me takes its notices out; reset clears them', () => {
    const s = useInbox.getState();
    s.addLiveNotice(notice('02', 't1'));
    s.addLiveNotice(notice('01', 't2'));
    s.removeTask('t1');
    expect(useInbox.getState().notices.map((e) => e.taskId)).toEqual(['t2']);
    useInbox.getState().reset();
    expect(useInbox.getState().notices).toEqual([]);
  });
});

describe('unreadNoticeTasks (bug #146)', () => {
  it('counts the tasks with a notice that are still unread, once per task', () => {
    const notices = [{ taskId: 't1' }, { taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }];
    expect(unreadNoticeTasks(notices, { t1: 'w', t3: 'w', t9: 'w' })).toBe(2);
    expect(unreadNoticeTasks(notices, {})).toBe(0);
  });
});

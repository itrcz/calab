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

describe('useInbox dismiss (CBF-155)', () => {
  beforeEach(() => useInbox.getState().reset());

  it('removes mentions and notices by id and keeps them out of later pages, live events and edits', () => {
    const s = useInbox.getState();
    s.addPage([mention('03'), mention('01')], false, false);
    s.addNotices([notice('02', 't1')], false, false);
    const before = useInbox.getState().items;
    s.dismiss(['03', '02']);
    expect(useInbox.getState().items.map((m) => m.id)).toEqual(['01']);
    expect(useInbox.getState().notices).toEqual([]);
    // A history page that raced the dismissal, a live copy and an edit re-mentioning me.
    useInbox.getState().addPage([mention('03')], false, false);
    useInbox.getState().addNotices([notice('02', 't1')], false, false);
    useInbox.getState().addLive(mention('03'));
    useInbox.getState().addLiveNotice(notice('02', 't1'));
    useInbox.getState().update(mention('03'), true);
    expect(useInbox.getState().items.map((m) => m.id)).toEqual(['01']);
    expect(useInbox.getState().notices).toEqual([]);
    // Dismissing again (the INBOX_DISMISS echo) changes nothing.
    const st = useInbox.getState();
    st.dismiss(['03']);
    expect(useInbox.getState().items).toBe(st.items);
    expect(useInbox.getState().dismissed).toBe(st.dismissed);
    expect(before).not.toBe(st.items);
  });

  it('undismiss brings the items back in order; reset forgets the dismissals', () => {
    const s = useInbox.getState();
    const m = mention('03');
    const e = notice('02', 't1');
    s.addPage([m, mention('01')], false, false);
    s.addLiveNotice(e);
    s.dismiss(['03', '02']);
    useInbox.getState().undismiss([m], [e]);
    expect(useInbox.getState().items.map((x) => x.id)).toEqual(['03', '01']);
    expect(useInbox.getState().notices.map((x) => x.id)).toEqual(['02']);
    useInbox.getState().dismiss(['01']);
    useInbox.getState().reset();
    useInbox.getState().addLive(mention('01'));
    expect(useInbox.getState().items.map((x) => x.id)).toEqual(['01']);
  });
});

describe('unreadNoticeTasks (bug #146)', () => {
  it('counts the tasks with a notice that are still unread, once per task', () => {
    const notices = [{ taskId: 't1' }, { taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }];
    expect(unreadNoticeTasks(notices, { t1: 'w', t3: 'w', t9: 'w' })).toBe(2);
    expect(unreadNoticeTasks(notices, {})).toBe(0);
  });
});

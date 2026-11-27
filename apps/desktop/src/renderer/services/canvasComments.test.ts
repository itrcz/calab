// @vitest-environment jsdom
import { PresenceStatus, type CanvasComment, type CanvasCommentMention } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasComments } from '../stores/canvasComments';
import { useCanvasUi } from '../stores/canvasUi';
import { usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined, showWindow: () => undefined } } }));
const opened = vi.hoisted(() => ({ hits: [] as Array<{ ws: string; id: string }> }));
vi.mock('./canvas', () => ({
  openCanvasHit: (ws: string, ref: { itemId: string }) => {
    opened.hits.push({ ws, id: ref.itemId });
    return Promise.resolve();
  },
  openPhoneItem: () => undefined,
}));
vi.mock('../stores/workspaces', async (orig) => ({
  ...(await orig<typeof import('../stores/workspaces')>()),
  memberName: (_ws: string | null, id: string) => ({ alice: 'Alice', bob: 'Bob' })[id] ?? id,
}));

const { noticeBody, onCanvasCommentDelete, onCanvasCommentMention, onCanvasCommentUpsert } = await import('./canvasComments');

const notes: Array<{ title: string; body: string; onclick: (() => void) | null }> = [];
class FakeNotification {
  onclick: (() => void) | null = null;
  constructor(public title: string, opts: { body: string }) {
    notes.push(this as never);
    (this as unknown as { body: string }).body = opts.body;
  }
  close(): void {}
  addEventListener(): void {}
}

const mention = (more: Partial<CanvasCommentMention> = {}): CanvasCommentMention =>
  ({ workspaceId: 'ws', canvasId: 'cv', canvasName: 'Retro', commentId: 'c1', threadId: 't1', actorId: 'alice', text: '', objectId: '', x: 0, y: 0, ...more }) as CanvasCommentMention;

beforeEach(() => {
  notes.length = 0;
  opened.hits.length = 0;
  vi.stubGlobal('Notification', FakeNotification);
  useSession.setState({ me: { user: { id: 'me' } } } as never);
  usePrefs.setState({ presence: PresenceStatus.ONLINE } as never);
  useCanvasComments.setState({ byId: {}, threads: {}, replies: {}, loaded: {}, panel: false, active: null, draft: null, focus: null, filterOpen: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canvas comment events (ADR-0127 wave 4)', () => {
  it('apply to a canvas whose comments are held only', () => {
    const c = { id: 'r', canvasId: 'cv', parentId: '', body: 'x', authorId: 'alice', resolved: false } as CanvasComment;
    onCanvasCommentUpsert({ workspaceId: 'ws', comment: c } as never);
    expect(useCanvasComments.getState().byId['r']).toBeUndefined();
    useCanvasComments.getState().setCanvas('cv', []);
    onCanvasCommentUpsert({ workspaceId: 'ws', comment: c } as never);
    expect(useCanvasComments.getState().threads['cv']).toEqual(['r']);
    onCanvasCommentDelete({ workspaceId: 'ws', canvasId: 'cv', commentId: 'r' } as never);
    expect(useCanvasComments.getState().threads['cv']).toEqual([]);
  });
});

describe('the @mention notice (ADR-0127 wave 4)', () => {
  it('shows the text the server sent, names for ids; none when the server left it out', () => {
    expect(noticeBody(mention({ text: 'look @bob' }))).toBe('Alice: look @bob');
    expect(noticeBody(mention({ text: 'look @00000000-0000-4000-8000-000000000000' }))).toContain('Alice: look @');
    expect(noticeBody(mention())).toContain('Alice');
    expect(noticeBody(mention())).not.toContain(':');
  });

  it('a system notification that opens the canvas at the thread; nothing in «не беспокоить», for my own or while I look at it', async () => {
    onCanvasCommentMention(mention({ text: 'hello' }));
    await vi.waitFor(() => expect(notes).toHaveLength(1)); // web: shown after the service worker lookup
    expect(notes[0]?.title).toContain('Retro');
    notes[0]?.onclick?.();
    await Promise.resolve();
    expect(opened.hits).toEqual([{ ws: 'ws', id: 'cv' }]);
    const st = useCanvasComments.getState();
    expect(st.focus).toEqual({ canvasId: 'cv', threadId: 't1' });
    expect(st.panel).toBe(true);
    expect(st.active).toBe('t1');

    onCanvasCommentMention(mention({ actorId: 'me' }));
    usePrefs.setState({ presence: PresenceStatus.DND } as never);
    onCanvasCommentMention(mention());
    usePrefs.setState({ presence: PresenceStatus.ONLINE } as never);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useUi.setState({ activeWorkspaceId: 'ws' } as never);
    useCanvasUi.setState({ active: true, itemOf: { ws: 'cv' } } as never);
    onCanvasCommentMention(mention());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notes).toHaveLength(1);
  });
});

import { create } from '@bufbuild/protobuf';
import { ApproverState, TaskApproverSchema } from '@calaba/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn(), app: { log: () => undefined } } }));
vi.mock('../../services/voice', () => ({ voice: {}, useVoice: () => undefined }));
const mem = vi.hoisted(() => {
  const m = new Map<string, string>();
  const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('window', { localStorage: ls });
  return m;
});

const { useBoardsUi } = await import('../../stores/boardsUi');
const { TagView, ApprovalsBody } = await import('./Approvals');
const { WatchersHeader } = await import('./Watchers');

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ap = (userId: string, state: ApproverState, comment = '') => create(TaskApproverSchema, { userId, state, comment });

describe('the card approval tag', () => {
  const tag = (key: string) => renderToStaticMarkup(createElement(TagView, { tag: key, id: 't', compact: false }));
  it('approved: filled green «✓ 3/3»', () => {
    const h = tag('approved:3:3');
    expect(h).toContain('data-state="approved"');
    expect(h).toContain('bg-ok-fill');
    expect(h).toContain('lucide-check');
    expect(text(h)).toBe('3/3');
  });
  it('pending: orange outline «2/3», no icon, no fill', () => {
    const h = tag('pending:2:3');
    expect(h).toContain('text-[var(--color-warn-text)]');
    expect(h).not.toContain('bg-ok-fill');
    expect(h).not.toContain('<svg');
    expect(text(h)).toBe('2/3');
  });
  it('rejected: red outline «✕ 1/3»', () => {
    const h = tag('rejected:1:3');
    expect(h).toContain('text-danger-text');
    expect(h).toContain('lucide-x');
    expect(text(h)).toBe('1/3');
  });
});

describe('the approvals part of the properties block', () => {
  const body = (state: 'pending' | 'approved' | 'rejected', approvers: ReturnType<typeof ap>[], approved: number, quorum: number) =>
    renderToStaticMarkup(createElement(ApprovalsBody, { task: { workspaceId: 'w1', approvers }, state, quorum, approved, onRemove: undefined }));
  it('approved: a full-width green band «Согласовано · 3 из 3», no approver list', () => {
    const h = body('approved', [ap('a', ApproverState.APPROVED), ap('b', ApproverState.APPROVED), ap('c', ApproverState.APPROVED)], 3, 3);
    expect(h).toContain('data-testid="approval-band" data-state="approved"');
    expect(h).toContain('w-full');
    expect(h).toContain('bg-ok-surface');
    expect(text(h)).toContain('Согласовано · 3 из 3');
    expect(h).not.toContain('approver-row');
  });
  it('rejected: a red band with the comment, then the approvers (comment not repeated)', () => {
    const h = body('rejected', [ap('a', ApproverState.APPROVED), ap('b', ApproverState.REJECTED, 'Нет бюджета')], 1, 2);
    expect(h).toContain('data-state="rejected"');
    expect(h).toContain('bg-danger-surface');
    expect(text(h).match(/Нет бюджета/g)?.length).toBe(1);
    expect(text(h)).toContain('Отклонено ·');
    expect(h.match(/approver-row/g)?.length).toBe(2);
  });
  it('pending: the approvers with their votes and «1 из 2 согласовали» in orange', () => {
    const h = body('pending', [ap('a', ApproverState.APPROVED), ap('b', ApproverState.PENDING)], 1, 2);
    expect(h).not.toContain('approval-band');
    expect(h.match(/approver-row/g)?.length).toBe(2);
    expect(text(h)).toContain('Согласовано');
    expect(text(h)).toContain('Ждёт согласования');
    expect(h).toContain('text-[var(--color-warn-text)]');
    expect(text(h)).toContain('1 из 2 согласовали');
  });
});

describe('«Наблюдатели» section', () => {
  it('the header shows the count and the expanded state', () => {
    const h = renderToStaticMarkup(createElement(WatchersHeader, { n: 4, open: false }));
    expect(h).toContain('aria-expanded="false"');
    expect(text(h)).toBe('Наблюдатели 4');
  });
  it('collapsed by default, remembered when toggled, restored from storage', async () => {
    expect(useBoardsUi.getState().watchersOpen).toBe(false);
    useBoardsUi.getState().setWatchersOpen(true);
    const saved = JSON.parse(mem.get('calaba-boards-ui') ?? '{}') as { state?: { watchersOpen?: boolean } };
    expect(saved.state?.watchersOpen).toBe(true);
    useBoardsUi.setState({ watchersOpen: false }, false);
    mem.set('calaba-boards-ui', JSON.stringify({ state: { watchersOpen: true }, version: 1 }));
    await useBoardsUi.persist.rehydrate();
    expect(useBoardsUi.getState().watchersOpen).toBe(true);
    // A foreign stored value does not open it.
    mem.set('calaba-boards-ui', JSON.stringify({ state: { watchersOpen: 'yes' }, version: 1 }));
    await useBoardsUi.persist.rehydrate();
    expect(useBoardsUi.getState().watchersOpen).toBe(false);
  });
});

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskGitLinkKind, TaskGitLinkSchema, TaskGitLinkState, type TaskGitLink } from '@calaba/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The task panel's «Git» section (ADR-0060 §4): row content per link kind and the safe open path.
const openExternal = vi.fn((_url: string) => Promise.resolve());
vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { openExternal: (u: string) => openExternal(u), log: () => undefined } } }));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });

const { GitLinkRow, openGitLink } = await import('./GitLinks');
const { gitLinkView } = await import('../../lib/boards/git');

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const link = (p: MessageInitShape<typeof TaskGitLinkSchema>): TaskGitLink =>
  create(TaskGitLinkSchema, { id: 'l', taskId: 't1', repo: 'org/app', url: 'https://github.com/org/app/pull/42', author: 'octocat', updatedAt: timestampFromMs(NOW - 3 * 3600_000), ...p });

describe('gitLinkView', () => {
  it('PR: «repo#N», the state picks the glyph', () => {
    expect(gitLinkView(link({ kind: TaskGitLinkKind.PR, ref: '42', state: TaskGitLinkState.OPEN, title: 'FNG-12 Login' }))).toMatchObject({ glyph: 'pr-open', ref: 'org/app#42', title: 'FNG-12 Login', state: 'git.open' });
    expect(gitLinkView(link({ kind: TaskGitLinkKind.PR, ref: '42', state: TaskGitLinkState.MERGED })).glyph).toBe('pr-merged');
    expect(gitLinkView(link({ kind: TaskGitLinkKind.PR, ref: '42', state: TaskGitLinkState.CLOSED })).glyph).toBe('pr-closed');
  });

  it('commit: the short SHA; branch: its name, no title repeating it', () => {
    expect(gitLinkView(link({ kind: TaskGitLinkKind.COMMIT, ref: '1a2b3c4d5e6f', title: 'fix' }))).toMatchObject({ glyph: 'commit', ref: 'org/app@1a2b3c4' });
    expect(gitLinkView(link({ kind: TaskGitLinkKind.BRANCH, ref: 'feature/FNG-12', title: 'feature/FNG-12' }))).toMatchObject({ glyph: 'branch', ref: 'org/app · feature/FNG-12', title: '' });
  });
});

describe('GitLinkRow', () => {
  it('renders the kind, the reference, the title, the author and the relative time', () => {
    const html = renderToStaticMarkup(createElement(GitLinkRow, { link: link({ kind: TaskGitLinkKind.PR, ref: '42', state: TaskGitLinkState.MERGED, title: 'FNG-12 Login' }), now: new Date(NOW) }));
    expect(html).toContain('data-glyph="pr-merged"');
    expect(html).toContain('org/app#42');
    expect(html).toContain('FNG-12 Login');
    expect(html).toContain('octocat');
    expect(html).toContain('aria-label="Pull request · смержен"');
    expect(html).toMatch(/3 часа назад|3 ч/);
  });
});

describe('openGitLink', () => {
  beforeEach(() => openExternal.mockClear());

  it('opens web pages only', () => {
    openGitLink('https://gitlab.com/org/app/-/merge_requests/3');
    openGitLink('javascript:alert(1)');
    openGitLink('file:///etc/passwd');
    expect(openExternal.mock.calls.map((c) => c[0])).toEqual(['https://gitlab.com/org/app/-/merge_requests/3']);
  });
});

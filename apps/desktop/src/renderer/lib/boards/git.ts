import { GitProvider, TaskGitLinkKind, TaskGitLinkState, type TaskGitLink } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';

/**
 * Git links of a task on the client (ADR-0060 §4): how a link row looks — the kind glyph and its
 * tone (branch; PR open green / merged purple / closed grey; commit), the reference «repo#123» /
 * the branch / the short SHA — and the providers of the board's Git tab. Pure.
 */
export type GitGlyph = 'branch' | 'pr-open' | 'pr-merged' | 'pr-closed' | 'commit';

export interface GitLinkView {
  glyph: GitGlyph;
  /** «org/app#42», «org/app · feature/FNG-12-login», «org/app@1a2b3c4». */
  ref: string;
  title: string;
  /** The kind / state word for screen readers and the tooltip. */
  kind: MessageKey;
  state: MessageKey | null;
}

export function gitLinkView(l: Pick<TaskGitLink, 'kind' | 'state' | 'repo' | 'ref' | 'title'>): GitLinkView {
  switch (l.kind) {
    case TaskGitLinkKind.PR: {
      const glyph: GitGlyph = l.state === TaskGitLinkState.MERGED ? 'pr-merged' : l.state === TaskGitLinkState.CLOSED ? 'pr-closed' : 'pr-open';
      const state: MessageKey = glyph === 'pr-merged' ? 'git.merged' : glyph === 'pr-closed' ? 'git.closed' : 'git.open';
      return { glyph, ref: `${l.repo}#${l.ref}`, title: l.title, kind: 'git.pr', state };
    }
    case TaskGitLinkKind.COMMIT:
      return { glyph: 'commit', ref: `${l.repo}@${l.ref.slice(0, 7)}`, title: l.title, kind: 'git.commit', state: null };
    default:
      return { glyph: 'branch', ref: l.repo ? `${l.repo} · ${l.ref}` : l.ref, title: l.title && l.title !== l.ref ? l.title : '', kind: 'git.branch', state: null };
  }
}

/** Only web pages open from a link row (the server stores what the provider sent). */
export const isWebUrl = (url: string): boolean => /^https?:\/\/[^\s/]+/i.test(url);

export const GIT_PROVIDERS: ReadonlyArray<{ v: GitProvider; label: MessageKey; how: MessageKey }> = [
  { v: GitProvider.GITHUB, label: 'git.github', how: 'git.how.github' },
  { v: GitProvider.GITLAB, label: 'git.gitlab', how: 'git.how.gitlab' },
  { v: GitProvider.GITEA, label: 'git.gitea', how: 'git.how.gitea' },
];

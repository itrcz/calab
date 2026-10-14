import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { TaskGitLink } from '@calaba/protocol';
import { GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n';
import { gitLinkView, isWebUrl, type GitGlyph } from '../../lib/boards/git';
import { fmt } from '../../lib/format';
import { isSafeHref } from '../../lib/markdown/parse';
import { platform } from '../../platform';
import { gitLinksOf, useAutomations } from '../../stores/automations';
import { useBoards } from '../../stores/boards';

/**
 * Git links of a task (ADR-0060 §4, docs/08 «Доски»): the panel's «Git» section under the
 * attachments — one row per branch / pull request / commit that mentions the task key, newest
 * first; a click opens it in the browser (the same safe path as links in messages: http(s) only,
 * through the main process). The kanban card shows the counter `⎇ N` as its own leaf.
 */
export function GitSection({ taskId }: { taskId: string }): ReactNode {
  const ids = useAutomations(useShallow((s) => gitLinksOf(s, taskId).map((l) => l.id)));
  if (ids.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5" aria-label={t('git.section')} data-testid="task-git">
      <h3 className="flex items-center gap-1.5 pb-1 text-caption font-semibold text-muted">
        <GitBranch className="size-3.5" aria-hidden /> {t('git.section')}
        <span className="font-normal tabular-nums">{ids.length}</span>
      </h3>
      {ids.map((id) => (
        <GitLinkLine key={id} taskId={taskId} id={id} />
      ))}
    </section>
  );
}

const GitLinkLine = memo(function GitLinkLine({ taskId, id }: { taskId: string; id: string }): ReactNode {
  const link = useAutomations((s) => gitLinksOf(s, taskId).find((l) => l.id === id));
  return link ? <GitLinkRow link={link} /> : null;
});

const GLYPH: Record<GitGlyph, { Icon: typeof GitBranch; className: string }> = {
  branch: { Icon: GitBranch, className: 'text-muted' },
  'pr-open': { Icon: GitPullRequest, className: 'text-[var(--color-green-text)]' },
  'pr-merged': { Icon: GitMerge, className: 'text-[#bf5af2]' },
  'pr-closed': { Icon: GitPullRequestClosed, className: 'text-faint' },
  commit: { Icon: GitCommitHorizontal, className: 'text-muted' },
};

export function openGitLink(url: string): void {
  if (isWebUrl(url) && isSafeHref(url)) void platform.app.openExternal(url);
}

/** One link: kind glyph, «repo#123» / branch / short SHA, title, author, relative time. */
export function GitLinkRow({ link, now }: { link: TaskGitLink; now?: Date }): ReactNode {
  const v = gitLinkView(link);
  const g = GLYPH[v.glyph];
  const at = link.updatedAt ?? link.createdAt;
  const when = at ? timestampDate(at) : null;
  const kind = v.state ? `${t(v.kind)} · ${t(v.state)}` : t(v.kind);
  return (
    <button
      type="button"
      onClick={() => openGitLink(link.url)}
      title={t('git.openLink', { url: link.url })}
      className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-control hover:bg-hover"
      data-testid="git-link"
      data-glyph={v.glyph}
    >
      <g.Icon className={`size-4 shrink-0 ${g.className}`} aria-label={kind} />
      <span className="shrink-0 truncate font-mono text-caption text-muted" style={{ maxWidth: '45%' }}>
        {v.ref}
      </span>
      <span className="min-w-0 flex-1 truncate">{v.title}</span>
      {link.author ? <span className="max-w-24 shrink-0 truncate text-caption text-muted">{link.author}</span> : null}
      {when ? (
        <span className="shrink-0 text-caption tabular-nums text-faint" title={fmt.full(when)}>
          {fmt.relative(when, now)}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The card's «⎇ N» (ADR-0060 §4): a leaf on the task's counter — a TASK_GIT_LINKS_UPDATE
 * re-renders this chip, not the card.
 */
export const GitBadge = memo(function GitBadge({ id }: { id: string }): ReactNode {
  const live = useAutomations((s) => s.gitCounts[id]);
  const stored = useBoards((s) => s.tasks[id]?.gitLinksCount ?? 0);
  const n = live ?? stored;
  if (!n) return null;
  return (
    <span className="inline-flex h-5 items-center gap-1 px-1 text-micro tabular-nums text-muted" title={t('git.chip', { n })} data-testid="card-git">
      <GitBranch className="size-3" aria-hidden />
      {n}
    </span>
  );
});

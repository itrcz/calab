import { useMemo } from 'react';
import { t } from '../../i18n';
import { mentionTargets, parseMarkdown, previewParts, toPlainText, type PreviewPart } from '../../lib/markdown/parse';
import { flattenTables } from '../../lib/markdown/table';
import { useWorkspaces } from '../../stores/workspaces';

type WsState = ReturnType<typeof useWorkspaces.getState>;

/** The label of one mention from a store snapshot (pure: selectors call it with their state). */
function labelIn(st: WsState, wsId: string | null, v: string): string {
  if (v === 'everyone' || v === 'here') return `@${v}`;
  const m = wsId ? st.byId[wsId]?.members[v] : undefined;
  const name = m?.nickname || m?.user?.displayName || st.users[v]?.displayName;
  return name ? `@${name}` : `@${t('chat.mentionUnknown')}`;
}

/**
 * How a mention reads (docs/05, «Упоминания»): `@everyone` / `@here` as such, a user id as
 * `@<nickname-aware name>`, an id nobody here knows as «@неизвестный».
 */
export function mentionLabel(wsId: string | null, v: string): string {
  return labelIn(useWorkspaces.getState(), wsId, v);
}

/**
 * Reactive mentionLabel(): follows nickname / profile name changes. The selector is a couple of
 * lookups returning a string, so presence storms re-run it cheaply and never re-render.
 */
export function useMentionLabel(wsId: string | null, v: string): string {
  return useWorkspaces((st) => labelIn(st, wsId, v));
}

/** One-line plain text of a message with mentions as names (previews, notifications, snippets). */
export function previewText(wsId: string | null, content: string): string {
  return toPlainText(parseMarkdown(flattenTables(content)), (v) => mentionLabel(wsId, v));
}

/** previewText() as runs: code (inline or a block squeezed to one line) is drawn monospace (PreviewRuns). */
export function previewPartsOf(wsId: string | null, content: string, max?: number): PreviewPart[] {
  return previewParts(parseMarkdown(flattenTables(content)), (v) => mentionLabel(wsId, v), max);
}

/**
 * Reactive previewPartsOf(): the markdown is parsed once per content; the store selector only
 * joins the labels of the mentioned users (a string), so unrelated store updates (presence,
 * other members) cost a few lookups and no re-render.
 */
export function usePreviewParts(wsId: string | null, content: string): PreviewPart[] {
  const nodes = useMemo(() => parseMarkdown(flattenTables(content)), [content]);
  const ids = useMemo(() => mentionTargets(nodes).users, [nodes]);
  const labels = useWorkspaces((st) => ids.map((v) => labelIn(st, wsId, v)).join('\u0000'));
  return useMemo(() => {
    const byId = new Map(ids.map((v, i) => [v, labels.split('\u0000')[i] ?? '']));
    return previewParts(nodes, (v) => byId.get(v) ?? labelIn(useWorkspaces.getState(), wsId, v));
  }, [nodes, ids, labels, wsId]);
}

/** Reactive previewText() (usePreviewParts joined). */
export function usePreviewText(wsId: string | null, content: string): string {
  const parts = usePreviewParts(wsId, content);
  return useMemo(() => parts.map((p) => p.v).join(''), [parts]);
}

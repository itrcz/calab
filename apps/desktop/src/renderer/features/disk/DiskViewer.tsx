import { ChevronLeft, ChevronRight, Download, Send } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Modal, Spinner } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { filePath } from '../../lib/api/endpoints';
import { CSV_MAX_ROWS, parseCsv, previewKind, stepSibling, textKind, textTooLarge, type TextKind } from '../../lib/diskPreview';
import { contentHref, openContentLink } from '../../services/contentLink';
import { fromMarkdown, type PmNode } from '../../lib/wiki/markdown';
import { platform } from '../../platform';
import { downloadItem, openSendToChat } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { usePlayer } from '../../stores/player';
import { useUi } from '../../stores/ui';
import { AudioAttachment } from '../chat/MediaPlayer';

/**
 * The Disk viewer for audio and text-like files (CBF-22, ADR-0094): audio in the chat's shared
 * player (`<audio>` through the player driver — docs/02 echo rule 1), text / code / Markdown / CSV
 * read-only, fetched through the API (`GET /api/files/{id}`) up to 1 MB. ←/→ step through the
 * folder's other viewable files, Space (outside a control) or Esc closes — Quick Look.
 */

type Text = { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error' };

/** The file's text at API `path`; nothing is fetched while `enabled` is false (too large for the viewer). */
function useFileText(path: string, enabled: boolean): Text {
  const [state, setState] = useState<{ id: string; v: Text } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    platform
      .apiFetch(path, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!ac.signal.aborted) setState({ id: path, v: { kind: 'ready', text } });
      })
      .catch(() => {
        if (!ac.signal.aborted) setState({ id: path, v: { kind: 'error' } });
      });
    return () => ac.abort();
  }, [path, enabled]);
  return state?.id === path ? state.v : { kind: 'loading' };
}

// ---------------------------------------------------------------- Markdown

function marked(node: PmNode, key: string): ReactNode {
  let out: ReactNode = node.text ?? '';
  for (const m of (node.marks ?? [])) {
    if (m.type === 'bold') out = <strong>{out}</strong>;
    else if (m.type === 'italic') out = <em>{out}</em>;
    else if (m.type === 'strike') out = <s>{out}</s>;
    else if (m.type === 'code') out = <code className="rounded bg-code px-1 py-px font-mono text-[0.88em]">{out}</code>;
    else if (m.type === 'link') {
      const href = contentHref(typeof m.attrs?.['href'] === 'string' ? m.attrs['href'] : '');
      if (href) {
        out = (
          <a
            href={href}
            title={href}
            data-inline-target
            onClick={(e) => {
              e.preventDefault();
              openContentLink(href);
            }}
            className="text-accent-text underline underline-offset-2"
          >
            {out}
          </a>
        );
      }
    }
  }
  return <Fragment key={key}>{out}</Fragment>;
}

const children = (n: PmNode, key: string): ReactNode[] => (n.content ?? []).map((c, i) => md(c, `${key}.${i}`));

/** The wiki parser's JSON (headings, lists, quotes, fences, tables, inline marks) as static React; no editor code. */
function md(n: PmNode, key: string): ReactNode {
  switch (n.type) {
    case 'text':
      return marked(n, key);
    case 'hardBreak':
      return <br key={key} />;
    case 'paragraph':
      return (
        <p key={key} className="my-2 break-words [overflow-wrap:anywhere]">
          {children(n, key)}
        </p>
      );
    case 'heading': {
      const level = Number(n.attrs?.['level'] ?? 1);
      const cls = level === 1 ? 'mb-2 mt-4 text-[22px] font-bold leading-7' : level === 2 ? 'mb-2 mt-4 text-[18px] font-semibold leading-6' : 'mb-1.5 mt-3 text-[15px] font-semibold leading-5';
      return (
        <h3 key={key} className={cls}>
          {children(n, key)}
        </h3>
      );
    }
    case 'bulletList':
    case 'taskList':
      return (
        <ul key={key} className="my-2 list-disc pl-6 [&_li>p]:my-0">
          {children(n, key)}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} start={Number(n.attrs?.['start'] ?? 1)} className="my-2 list-decimal pl-6 [&_li>p]:my-0">
          {children(n, key)}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{children(n, key)}</li>;
    case 'taskItem':
      return (
        <li key={key} className="list-none">
          <span aria-hidden className="mr-1.5 -ml-5 text-muted">
            {n.attrs?.['checked'] ? '☑' : '☐'}
          </span>
          {children(n, key)}
        </li>
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="my-2 border-l-2 border-line pl-3 text-muted">
          {children(n, key)}
        </blockquote>
      );
    case 'codeBlock':
      return (
        <pre key={key} className="my-2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-code-block)] p-3 font-mono text-[12.5px] leading-[18px]">
          {(n.content ?? []).map((c) => c.text ?? '').join('')}
        </pre>
      );
    case 'horizontalRule':
      return <hr key={key} className="my-3 border-line" />;
    case 'table':
      return (
        <div key={key} className="my-2 overflow-x-auto [&_td>p]:my-0 [&_th>p]:my-0">
          <table className="border-collapse text-body">
            <tbody>{children(n, key)}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={key}>{children(n, key)}</tr>;
    case 'tableHeader':
      return (
        <th key={key} className="border border-line bg-[var(--color-fill)] px-2 py-1 text-left font-semibold">
          {children(n, key)}
        </th>
      );
    case 'tableCell':
      return (
        <td key={key} className="border border-line px-2 py-1 align-top">
          {children(n, key)}
        </td>
      );
    case 'mention':
    case 'wikiPageLink':
      return null;
    default:
      return <Fragment key={key}>{children(n, key)}</Fragment>;
  }
}

function MarkdownView({ text }: { text: string }): ReactNode {
  const doc = useMemo(() => fromMarkdown(text), [text]);
  return (
    <div className="selectable text-body leading-6" data-testid="disk-view-markdown">
      {children(doc, 'm')}
    </div>
  );
}

// ---------------------------------------------------------------- CSV, code

function CsvView({ text, delimiter }: { text: string; delimiter: string }): ReactNode {
  const { rows, capped } = useMemo(() => parseCsv(text, delimiter), [text, delimiter]);
  const [head, ...body] = rows;
  return (
    <div className="flex flex-col gap-2" data-testid="disk-view-csv">
      <div className="selectable overflow-auto rounded-[8px] border border-line">
        <table className="w-full border-collapse text-caption">
          {head ? (
            <thead>
              <tr>
                {head.map((c, i) => (
                  <th key={i} className="whitespace-nowrap border-b border-line bg-[var(--color-fill)] px-2 py-1 text-left font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri} className="border-t border-line">
                {r.map((c, ci) => (
                  <td key={ci} className="max-w-[260px] truncate px-2 py-1" title={c}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capped ? <p className="text-caption text-muted">{t('disk.view.rowsCapped', { n: CSV_MAX_ROWS })}</p> : null}
    </div>
  );
}

function CodeView({ text, wrap }: { text: string; wrap: boolean }): ReactNode {
  return (
    <pre
      className={`selectable rounded-[var(--radius-control)] bg-[var(--color-code-block)] p-3 font-mono text-[12.5px] leading-[18px] ${wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'}`}
      data-testid="disk-view-code"
    >
      {text}
    </pre>
  );
}

/** The read-only text viewer of a file whose bytes are at API `path` (also the public Disk link page, ADR-0165). */
export function TextBody({ path, size, kind, name }: { path: string; size: bigint; kind: TextKind; name: string }): ReactNode {
  const tooLarge = textTooLarge({ size });
  const state = useFileText(path, !tooLarge);
  if (tooLarge) return <Notice testid="disk-view-large">{t('disk.view.tooLarge')}</Notice>;
  if (state.kind === 'loading') {
    return (
      <div className="grid h-40 place-items-center">
        <Spinner className="size-6" label={name} />
      </div>
    );
  }
  if (state.kind === 'error') return <Notice testid="disk-view-error" danger>{t('disk.view.failed')}</Notice>;
  if (!state.text.trim()) return <Notice testid="disk-view-empty">{t('disk.view.empty')}</Notice>;
  if (kind === 'markdown') return <MarkdownView text={state.text} />;
  if (kind === 'csv') return <CsvView text={state.text} delimiter={/\.tsv$/i.test(name) ? '\t' : ','} />;
  return <CodeView text={state.text} wrap={kind === 'text'} />;
}

function Notice({ children: c, testid, danger }: { children: ReactNode; testid: string; danger?: boolean }): ReactNode {
  return (
    <p role={danger ? 'alert' : undefined} className={`grid h-40 place-items-center text-body ${danger ? 'text-danger-text' : 'text-muted'}`} data-testid={testid}>
      {c}
    </p>
  );
}

// ---------------------------------------------------------------- the dialog

/** Are we typing or pressing a control (Space must keep its own meaning there). */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('button, a, input, textarea, select, [role="slider"], [role="group"], [contenteditable="true"]');
}

export function DiskViewDialog({ itemId, siblings, onClose }: { itemId: string; siblings: string[]; onClose: () => void }): ReactNode {
  useLocale();
  const [id, setId] = useState(itemId);
  const item = useDisk((s) => s.items[id]);
  const ids = useMemo(() => (siblings.includes(itemId) ? siblings : [itemId]), [siblings, itemId]);
  const prev = stepSibling(ids, id, -1);
  const next = stepSibling(ids, id, 1);

  // A stopped dialog stops its track: the chat's mini-player must not inherit it.
  useEffect(
    () => () => {
      if (usePlayer.getState().track?.messageId.startsWith('disk:')) usePlayer.getState().close();
    },
    [],
  );
  useEffect(() => {
    if (usePlayer.getState().track?.messageId.startsWith('disk:')) usePlayer.getState().close();
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && !onControl(e.target)) {
        e.preventDefault();
        onClose();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !onControl(e.target) && !(e.target instanceof Element && e.target.closest('[role="slider"]'))) {
        const to = e.key === 'ArrowLeft' ? prev : next;
        if (to) {
          e.preventDefault();
          setId(to);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  if (!item?.file) return null;
  const file = item.file;
  const kind = previewKind(file, useUi.getState().phone.on);
  const tk = textKind(file);
  return (
    <Modal
      open
      onClose={onClose}
      wide
      initialFocus="body"
      title={item.name}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
              openSendToChat(id);
            }}
            data-testid="disk-view-send"
          >
            <Send className="size-4 shrink-0" aria-hidden />
            {t('disk.sendToChat')}
          </Button>
          <Button variant="secondary" onClick={() => downloadItem(item)} data-testid="disk-view-download">
            <Download className="size-4 shrink-0" aria-hidden />
            {t('disk.download')}
          </Button>
        </>
      }
    >
      <div className="py-2" data-testid="disk-viewer" data-kind={kind}>
        {ids.length > 1 ? (
          <div className="mb-2 flex items-center justify-end gap-1">
            <Button variant="secondary" disabled={!prev} onClick={() => prev && setId(prev)} aria-label={t('lightbox.prev')} data-testid="disk-view-prev">
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <span className="min-w-12 text-center text-caption tabular-nums text-muted">
              {ids.indexOf(id) + 1} / {ids.length}
            </span>
            <Button variant="secondary" disabled={!next} onClick={() => next && setId(next)} aria-label={t('lightbox.next')} data-testid="disk-view-next">
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        ) : null}
        {kind === 'audio' ? (
          <div className="rec-card py-3">
            <AudioAttachment key={file.id} f={file} messageId={`disk:${id}`} roomId="" label={item.name} className="w-full" />
          </div>
        ) : tk ? (
          <TextBody key={file.id} path={filePath(file.id)} size={file.size} kind={tk} name={item.name} />
        ) : null}
      </div>
    </Modal>
  );
}

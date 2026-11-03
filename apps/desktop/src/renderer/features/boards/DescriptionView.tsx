/**
 * The read view of a task description (docs/08 «Доски»; board #107: edit and read look the same).
 * The markdown-lite text goes through the same converter the editor starts from (descriptionDoc)
 * and is drawn as the plain DOM the compact wiki editor produces — `.wiki-editor[data-compact]
 * .wiki-prose` with the shared rules of wiki/editor/prose.css — so paragraphs, lists, headings, tables,
 * links, emoji and pictures sit where they sit while editing. No editor is mounted in read mode
 * (task panels and lists stay light); only the doc → React mapping is here.
 */
import { memo, useMemo, type ReactNode } from 'react';
import type { PmMark, PmNode } from '@calaba/wiki-doc/markdown';
import { CodeBlock } from '../../lib/markdown/CodeBlock';
import { t } from '../../i18n';
import { openContentLink } from '../../services/contentLink';
import { memberName } from '../../stores/workspaces';
import '../wiki/editor/prose.css';
import { descriptionToDoc } from './descriptionDoc';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export type DescriptionImageRenderer = (id: string, alt: string) => ReactNode;

function marked(n: PmNode, k: string): ReactNode {
  let out: ReactNode = n.text ?? '';
  const marks: readonly PmMark[] = n.marks ?? [];
  // Same nesting as the editor: code innermost, link outermost.
  for (const type of ['code', 'strike', 'italic', 'bold', 'link']) {
    const m = marks.find((x) => x.type === type);
    if (!m) continue;
    if (type === 'code') out = <code>{out}</code>;
    else if (type === 'strike') out = <s>{out}</s>;
    else if (type === 'italic') out = <em>{out}</em>;
    else if (type === 'bold') out = <strong>{out}</strong>;
    else {
      const href = typeof m.attrs?.['href'] === 'string' ? m.attrs['href'] : '';
      out = (
        <a
          href={href}
          title={href}
          data-inline-target
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openContentLink(href);
          }}
        >
          {out}
        </a>
      );
    }
  }
  return <span key={k} style={{ display: 'contents' }}>{out}</span>;
}

function inline(nodes: readonly PmNode[] | undefined, ws: string, k: string): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    const key = `${k}.${i}`;
    if (n.type === 'text') return n.marks?.length ? marked(n, key) : (n.text ?? '');
    if (n.type === 'hardBreak') return <br key={key} />;
    if (n.type === 'mention') {
      const id = str(n.attrs?.['id']);
      return (
        <span key={key} className="wiki-mention">
          @{memberName(ws, id) || str(n.attrs?.['label'])}
        </span>
      );
    }
    return inline(n.content, ws, key);
  });
}

interface Ctx {
  ws: string;
  image: DescriptionImageRenderer;
}

function blocks(nodes: readonly PmNode[] | undefined, c: Ctx, k: string): ReactNode[] {
  return (nodes ?? []).map((n, i) => block(n, c, `${k}.${i}`));
}

function block(n: PmNode, c: Ctx, k: string): ReactNode {
  switch (n.type) {
    case 'paragraph':
      // An empty paragraph keeps its line like the editor's trailing break does (the blank lines the user typed).
      return <p key={k}>{n.content?.length ? inline(n.content, c.ws, k) : <br />}</p>;
    case 'heading': {
      const H = `h${Math.min(3, Math.max(1, Number(n.attrs?.['level']) || 1))}` as 'h1' | 'h2' | 'h3';
      return <H key={k}>{inline(n.content, c.ws, k)}</H>;
    }
    case 'bulletList':
      return <ul key={k}>{blocks(n.content, c, k)}</ul>;
    case 'orderedList': {
      const start = Number(n.attrs?.['start']) || 1;
      return (
        <ol key={k} {...(start !== 1 ? { start } : {})}>
          {blocks(n.content, c, k)}
        </ol>
      );
    }
    case 'listItem':
      return <li key={k}>{blocks(n.content, c, k)}</li>;
    case 'taskList':
      return (
        <ul key={k} data-type="taskList">
          {blocks(n.content, c, k)}
        </ul>
      );
    case 'taskItem': {
      const checked = n.attrs?.['checked'] === true;
      return (
        <li key={k} data-checked={checked}>
          <label>
            <input type="checkbox" checked={checked} disabled readOnly aria-label={t('boards.description')} />
          </label>
          <div>{blocks(n.content, c, k)}</div>
        </li>
      );
    }
    case 'blockquote':
      return <blockquote key={k}>{blocks(n.content, c, k)}</blockquote>;
    case 'horizontalRule':
      return <hr key={k} />;
    case 'codeBlock':
      return <CodeBlock key={k} code={(n.content ?? []).map((x) => x.text ?? '').join('')} lang={typeof n.attrs?.['language'] === 'string' ? n.attrs['language'] : ''} />;
    case 'image':
      return (
        <div key={k} className="wiki-image">
          {c.image(str(n.attrs?.['fileId']), str(n.attrs?.['alt']))}
        </div>
      );
    case 'table':
      // Same DOM as the editor's table (extensions.ts): a scrolling wrapper, cells hold paragraphs.
      return (
        // tabIndex: a wide table scrolls sideways, and a scroll area must be reachable from the keyboard.
        <div key={k} className="tableWrapper" tabIndex={0}>
          <table className="wiki-table">
            <tbody>
              {(n.content ?? []).map((row, ri) => (
                <tr key={`${k}.${ri}`}>
                  {(row.content ?? []).map((cell, ci) => {
                    const Cell = cell.type === 'tableHeader' ? 'th' : 'td';
                    return <Cell key={`${k}.${ri}.${ci}`}>{blocks(cell.content, c, `${k}.${ri}.${ci}`)}</Cell>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      // Callouts and the like (a pasted markdown): their text, nothing is dropped.
      return n.content ? <div key={k}>{blocks(n.content, c, k)}</div> : null;
  }
}

export const DescriptionView = memo(function DescriptionView({ workspaceId, description, image }: { workspaceId: string; description: string; image: DescriptionImageRenderer }): ReactNode {
  const doc = useMemo(() => descriptionToDoc(description, (id) => memberName(workspaceId, id)), [description, workspaceId]);
  return (
    <div className="wiki-editor" data-compact>
      <div className="wiki-prose" style={{ whiteSpace: 'pre-wrap' }}>
        {blocks(doc.content, { ws: workspaceId, image }, 'b')}
      </div>
    </div>
  );
});

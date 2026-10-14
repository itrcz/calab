import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeFrame, encodeSnapshotPost, encodeUpdate, FRAME_SNAPSHOT_POST, FRAME_UPDATE } from './frames';
import { docMeta, WIKI_FIELD } from './plainText';
import { wikiSchema } from './schema';
import { appendDocMarkdown, docToJSON, docToMarkdown, setDocMarkdown } from './ydoc';

const MD = `## Plan

Some **bold** and _italic_ text with [a link](https://example.com).

- [ ] open
- [x] done

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`go
fmt.Println("hi")
\`\`\`
`;

describe('wiki schema', () => {
  it('has the editor node set', () => {
    const s = wikiSchema();
    for (const n of ['doc', 'paragraph', 'heading', 'codeBlock', 'taskList', 'taskItem', 'table', 'tableRow', 'tableHeader', 'tableCell', 'image', 'callout', 'toggle', 'mention', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'hardBreak']) {
      expect(s.nodes[n], n).toBeDefined();
    }
    for (const m of ['bold', 'italic', 'strike', 'code', 'link', 'highlight']) expect(s.marks[m], m).toBeDefined();
  });
});

describe('Y doc ↔ Markdown', () => {
  it('round-trips Markdown through the fragment the editor binds to', () => {
    const doc = new Y.Doc();
    setDocMarkdown(doc, MD);
    expect(doc.getXmlFragment(WIKI_FIELD).length).toBeGreaterThan(0);
    const md = docToMarkdown(doc);
    expect(md).toContain('## Plan');
    expect(md).toContain('**bold**');
    expect(md).toContain('- [x] done');
    expect(md).toContain('| 1 | 2 |');
    expect(md).toContain('```go\nfmt.Println("hi")\n```');
    expect(docMeta(doc).plain_text).toContain('Plan');
  });

  it('syncs to another doc through an update and keeps unchanged blocks on rewrite', () => {
    const a = new Y.Doc();
    setDocMarkdown(a, 'first\n\nsecond');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(docToMarkdown(b).trim()).toBe('first\n\nsecond');
    const before = Y.encodeStateVector(a);
    setDocMarkdown(a, 'first\n\nsecond changed');
    const diff = Y.encodeStateAsUpdate(a, before);
    // A diff, not a whole new document: far smaller than the state.
    expect(diff.length).toBeLessThan(Y.encodeStateAsUpdate(a).length);
    Y.applyUpdate(b, diff);
    expect(docToMarkdown(b).trim()).toBe('first\n\nsecond changed');
  });

  it('appends after the content, replacing an empty page', () => {
    const doc = new Y.Doc();
    appendDocMarkdown(doc, 'one');
    appendDocMarkdown(doc, '- two');
    expect(docToMarkdown(doc).trim()).toBe('one\n\n- two');
    expect(docToJSON(doc).content?.[0]?.type).toBe('paragraph');
  });
});

describe('frames', () => {
  it('encode and decode an update and a snapshot post', () => {
    const u = decodeFrame(encodeUpdate(Uint8Array.of(1, 2, 3), 7));
    expect(u).toEqual({ type: FRAME_UPDATE, seq: 7, update: Uint8Array.of(1, 2, 3) });
    const p = decodeFrame(encodeSnapshotPost(5, { plain_text: 'x', title: 'T', preview: 'x' }, Uint8Array.of(9), true));
    expect(p).toMatchObject({ type: FRAME_SNAPSHOT_POST, throughSeq: 5, broadcast: true, meta: { title: 'T' } });
  });
});

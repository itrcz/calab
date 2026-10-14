/**
 * Prism highlighting of wiki code blocks (docs/08 «Код в сообщениях»): the same lazy grammars,
 * idle tokenizing and (language, text) cache as the chat (lib/markdown/syntax.ts), drawn as inline
 * decorations with the `.syn-*` token classes.
 *
 * Per transaction only the code blocks inside the changed ranges are looked at; a block whose new
 * text is not cached keeps its mapped (slightly stale) colours until the idle pass finishes, then
 * one meta transaction refreshes them. Nothing runs while nobody types.
 */
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { str } from '../../../lib/wiki/markdown';
import { cachedHighlight, grammarId, highlightIdle, type HlNode } from '../../../lib/markdown/syntax';

interface Miss {
  code: string;
  id: string;
}

interface PrismState {
  set: DecorationSet;
  misses: Miss[];
}

export const prismKey = new PluginKey<PrismState>('wikiPrism');

function runsToDecos(nodes: HlNode[], at: number, out: Decoration[]): number {
  let pos = at;
  for (const n of nodes) {
    if (typeof n === 'string') {
      pos += n.length;
      continue;
    }
    const start = pos;
    pos = runsToDecos(n.v, pos, out);
    if (pos > start) out.push(Decoration.inline(start, pos, { class: `syn-${n.c}` }));
  }
  return pos;
}

/** Re-decorates one code block at `pos`: cached runs, or keeps the mapped ones and reports a miss. */
function redoBlock(node: PmNode, pos: number, set: DecorationSet, doc: PmNode, misses: Miss[]): DecorationSet {
  const from = pos + 1;
  const to = pos + node.nodeSize - 1;
  const id = grammarId(str(node.attrs['language']));
  if (!id) return set.remove(set.find(from, to));
  const code = node.textContent;
  const runs = cachedHighlight(code, id);
  if (!runs) {
    if (code) misses.push({ code, id });
    return set;
  }
  const decos: Decoration[] = [];
  runsToDecos(runs, from, decos);
  return set.remove(set.find(from, to)).add(doc, decos);
}

function scan(doc: PmNode, from: number, to: number, set: DecorationSet, misses: Miss[]): DecorationSet {
  let out = set;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'codeBlock') {
      out = redoBlock(node, pos, out, doc, misses);
      return false;
    }
    return !node.isTextblock; // only containers can hold code blocks
  });
  return out;
}

function apply(tr: Transaction, prev: PrismState): PrismState {
  const doc = tr.doc;
  const misses: Miss[] = [];
  if (tr.getMeta(prismKey) === 'refresh') return { set: scan(doc, 0, doc.content.size, prev.set.map(tr.mapping, doc), misses), misses };
  if (!tr.docChanged) return prev;
  let set = prev.set.map(tr.mapping, doc);
  // Changed ranges in the new doc: every step's map, carried through the later steps.
  const ranges: Array<[number, number]> = [];
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = tr.mapping.slice(i + 1);
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  });
  for (const [a, b] of ranges) set = scan(doc, Math.max(0, a), Math.min(doc.content.size, Math.max(a, b)), set, misses);
  // Misses accumulate until highlighted: the view only sees the state after the LAST transaction of a
  // dispatch chain (a sync follow-up lands before its update runs), so a miss must outlive the next one.
  const pending = prev.misses.filter((m) => !cachedHighlight(m.code, m.id) && !misses.some((x) => x.id === m.id && x.code === m.code));
  return { set, misses: pending.length ? [...pending, ...misses] : misses };
}

export function prismPlugin(): Plugin<PrismState> {
  return new Plugin<PrismState>({
    key: prismKey,
    state: {
      init: (_cfg, state: EditorState) => {
        const misses: Miss[] = [];
        return { set: scan(state.doc, 0, state.doc.content.size, DecorationSet.empty, misses), misses };
      },
      apply,
    },
    props: {
      decorations: (state) => prismKey.getState(state)?.set,
    },
    view: (view) => {
      let alive = true;
      let waiting = 0;
      const asked = new Set<string>();
      const schedule = (misses: Miss[]): void => {
        for (const m of misses) {
          const key = `${m.id}\u0000${m.code}`;
          if (asked.has(key)) continue;
          asked.add(key);
          waiting++;
          void highlightIdle(m.code, m.id).then((runs) => {
            if (runs) asked.delete(key); // a block with no grammar is asked once, not on every refresh
            waiting--;
            // One refresh after the last pending block of the pass.
            if (alive && waiting === 0) view.dispatch(view.state.tr.setMeta(prismKey, 'refresh').setMeta('addToHistory', false));
          });
        }
      };
      schedule(prismKey.getState(view.state)?.misses ?? []);
      return {
        update: (v) => {
          const st = prismKey.getState(v.state);
          if (st?.misses.length) schedule(st.misses);
        },
        destroy: () => {
          alive = false;
        },
      };
    },
  });
}

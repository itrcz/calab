import { Extension, type AnyExtension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { str } from '../../../lib/wiki/markdown';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { isAllowedHref, wikiStarterKit } from '@calaba/wiki-doc/schema';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { avatarColor } from '../../../components/Avatar';
import { t } from '../../../i18n';
import { WIKI_FIELD } from '../../../lib/wiki/plainText';
import type { EditorEnv } from './env';
import { Callout, Toggle, WikiCodeBlock, WikiHighlight, WikiImage, wikiMention } from './nodes';
import { slashCommands } from './suggestions';
import { wikiPaste } from './upload';
import type { WikiEditorUser } from './types';

export { isAllowedHref };

/** A collaborator's caret: a 2 px bar in their identity colour with the name above it. */
function caret(user: Record<string, unknown>): HTMLElement {
  const color = avatarColor(str(user['id'], ''));
  const el = document.createElement('span');
  el.className = 'wiki-caret';
  el.style.setProperty('--caret', color);
  const label = document.createElement('span');
  label.className = 'wiki-caret-label';
  label.textContent = str(user['name'], '').slice(0, 40);
  el.append(label);
  return el;
}

const shortcuts = (env: EditorEnv) =>
  Extension.create({
    name: 'wikiShortcuts',
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => {
          if (!this.editor.isEditable || this.editor.state.selection.empty) return false;
          env.openLink();
          return true;
        },
        'Mod-Shift-h': () => this.editor.chain().focus().toggleHighlight({ color: 'yellow' }).run(),
      };
    },
    addProseMirrorPlugins() {
      // While editing, a plain click places the caret in a link; ⌘/Ctrl-click opens it (read-only
      // pages open links natively).
      return [
        new Plugin({
          props: {
            handleClick: (view, _pos, event) => {
              if (!view.editable || !(event.metaKey || event.ctrlKey) || !(event.target instanceof Element)) return false;
              const a = event.target.closest('a');
              const href = a?.getAttribute('href') ?? '';
              if (!a || !view.dom.contains(a) || !isAllowedHref(href)) return false;
              window.open(href, '_blank', 'noopener,noreferrer');
              return true;
            },
          },
        }),
      ];
    },
  });

export function buildExtensions(o: { doc: Y.Doc; awareness: Awareness | null; me: WikiEditorUser; env: EditorEnv }): AnyExtension[] {
  const exts: AnyExtension[] = [
    wikiStarterKit(),
    WikiCodeBlock.configure({ defaultLanguage: null, enableTabIndentation: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false, HTMLAttributes: { class: 'wiki-table' } }),
    TableRow,
    TableHeader,
    TableCell,
    WikiHighlight,
    WikiImage.configure({ env: o.env }),
    Callout.configure({ env: o.env }),
    Toggle,
    wikiMention(o.env),
    slashCommands(o.env),
    wikiPaste(o.env),
    shortcuts(o.env),
    Placeholder.configure({ placeholder: t('wiki.editor.placeholder'), showOnlyWhenEditable: true }),
    Collaboration.configure({ document: o.doc, field: WIKI_FIELD }),
  ];
  if (o.awareness) {
    exts.push(
      CollaborationCaret.configure({
        provider: { awareness: o.awareness },
        // y-tiptap warns (per remote cursor render) about any colour but #rrggbb; ours come from the id (caret/selectionRender).
        user: { id: o.me.id, name: o.me.name, color: '#8e8e93' },
        render: caret,
        selectionRender: (user: Record<string, unknown>) => ({
          class: 'wiki-remote-selection',
          style: `--caret: ${avatarColor(str(user['id'], ''))}`,
        }),
      }),
    );
  }
  return exts;
}

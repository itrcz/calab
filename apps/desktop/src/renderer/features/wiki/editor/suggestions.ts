/**
 * The two suggestion popovers: `/` blocks and `@` people. Tiptap's suggestion plugin tracks the
 * query; its render hooks only write the shared MenuStore (no DOM here), <SuggestionMenu> draws it.
 */
import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import type { MentionCandidate } from '../../../lib/mentions';
import { filterBlocks, type BlockDef } from './blocks';
import type { EditorEnv } from './env';
import { rectOf } from './menuStore';

function renderInto<T>(env: EditorEnv, kind: 'slash' | 'mention'): SuggestionOptions<T, T>['render'] {
  return () => {
    let index = 0;
    const show = (p: SuggestionProps<T, T>): void => {
      const prev = env.menu.get();
      // Keep the highlighted row while the list stays the same length (typing narrows it).
      index = prev?.kind === kind && prev.items.length === p.items.length ? prev.index : 0;
      env.menu.set({ kind, items: p.items, index, rect: rectOf(p.clientRect), pick: (item) => p.command(item as T) });
    };
    return {
      onStart: show,
      onUpdate: show,
      onExit: () => env.menu.set(null),
      onKeyDown: ({ event }) => env.menu.key(event),
    };
  };
}

export function mentionSuggestion(env: EditorEnv): Omit<SuggestionOptions<MentionCandidate, MentionCandidate>, 'editor'> {
  return {
    char: '@',
    pluginKey: new PluginKey('wikiMention'),
    allow: ({ editor }) => !editor.isActive('codeBlock') && !!env.mentions,
    items: ({ query }) => env.mentions?.search(query) ?? [],
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: 'mention', attrs: { id: props.id, label: props.name } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: renderInto<MentionCandidate>(env, 'mention'),
  };
}

function runBlock(editor: Editor, range: Range, b: BlockDef): void {
  b.run(editor.chain().focus().deleteRange(range)).run();
}

/** `/` at the start of a word opens the block menu (not inside code). */
export function slashCommands(env: EditorEnv) {
  return Extension.create({
    name: 'wikiSlash',
    addProseMirrorPlugins() {
      return [
        Suggestion<BlockDef, BlockDef>({
          editor: this.editor,
          char: '/',
          pluginKey: new PluginKey('wikiSlash'),
          allowSpaces: false,
          allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock'),
          items: ({ query, editor }) => filterBlocks(query).filter((b) => b.id !== 'image' || (!!env.upload && editor.isEditable)),
          command: ({ editor, range, props }) => runBlock(editor, range, props),
          render: renderInto<BlockDef>(env, 'slash'),
        }),
      ];
    },
  });
}

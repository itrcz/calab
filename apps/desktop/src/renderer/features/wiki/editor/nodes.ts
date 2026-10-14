/**
 * Wiki-specific nodes and marks (ADR-0096 §3): callout, toggle, image (file id only), code block
 * with Prism and a language picker, live-labelled mentions, highlight colours by name.
 * Light DOM node views where React is not needed (one React root per node costs).
 */
import { mergeAttributes } from '@tiptap/core';
import { str } from '../../../lib/wiki/markdown';
import { CodeBlock } from '@tiptap/extension-code-block';
import { CalloutNode, HighlightMark, ImageNode, ToggleNode } from '@calaba/wiki-doc/schema';
import { Mention } from '@tiptap/extension-mention';
import type { SuggestionOptions } from '@tiptap/suggestion';
import type { Node as PmNode } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { t } from '../../../i18n';
import { CalloutView, ImageView } from './NodeViews';
import type { EditorEnv } from './env';
import { prismPlugin } from './prismPlugin';
import { mentionSuggestion } from './suggestions';
import { pickImage } from './upload';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiBlocks: {
      setCallout: () => ReturnType;
      setToggle: () => ReturnType;
      pickImage: () => ReturnType;
    };
  }
}

export { DEFAULT_CALLOUT_ICON } from '@calaba/wiki-doc/schema';

export const Callout = CalloutNode.extend<{ env: EditorEnv | null }>({
  addOptions: () => ({ env: null }),
  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

/**
 * Toggle (schema: @calaba/wiki-doc): folding is local (a click on this screen), never in the
 * doc: a co-author folding a block must not fold it for everyone.
 */
export const Toggle = ToggleNode.extend({
  addCommands() {
    return {
      setToggle:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
  addNodeView() {
    return () => {
      const dom = document.createElement('div');
      dom.className = 'wiki-toggle';
      dom.dataset['toggle'] = '';
      dom.dataset['open'] = 'true';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wiki-toggle-btn';
      btn.contentEditable = 'false';
      const label = (): void => {
        const open = dom.dataset['open'] === 'true';
        btn.setAttribute('aria-expanded', String(open));
        btn.setAttribute('aria-label', t(open ? 'wiki.toggle.collapse' : 'wiki.toggle.expand'));
      };
      label();
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        dom.dataset['open'] = dom.dataset['open'] === 'true' ? 'false' : 'true';
        label();
      });
      const contentDOM = document.createElement('div');
      contentDOM.className = 'wiki-toggle-body';
      dom.append(btn, contentDOM);
      return {
        dom,
        contentDOM,
        ignoreMutation: (m) => m.type === 'attributes' && (m.target === dom || m.target === btn),
        stopEvent: (e) => e.target === btn,
      };
    };
  },
});

/** Languages offered by the picker (grammar ids of lib/markdown/syntax; '' = plain text). */
export const CODE_LANGUAGES: ReadonlyArray<[string, string]> = [
  ['', ''],
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['css', 'CSS'],
  ['go', 'Go'],
  ['html', 'HTML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['jsx', 'JSX'],
  ['kotlin', 'Kotlin'],
  ['python', 'Python'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['tsx', 'TSX'],
  ['typescript', 'TypeScript'],
  ['yaml', 'YAML'],
];

export const WikiCodeBlock = CodeBlock.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), prismPlugin()];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'wiki-code';
      const select = document.createElement('select');
      select.className = 'wiki-code-lang';
      select.contentEditable = 'false';
      select.setAttribute('aria-label', t('wiki.code.language'));
      const lang = (n: PmNode): string => str(n.attrs['language'], '');
      const fill = (current: string): void => {
        select.replaceChildren();
        const known = CODE_LANGUAGES.some(([id]) => id === current);
        for (const [id, name] of known ? CODE_LANGUAGES : [...CODE_LANGUAGES, [current, current] as [string, string]]) {
          const o = document.createElement('option');
          o.value = id;
          o.textContent = id ? name : t('wiki.code.plain');
          select.append(o);
        }
        select.value = current;
      };
      fill(lang(node));
      select.disabled = !editor.isEditable;
      select.addEventListener('change', () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'language', select.value || null));
      });
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.spellcheck = false; // no red squiggles under identifiers and commands
      pre.append(code);
      dom.append(select, pre);
      let current = node;
      return {
        dom,
        contentDOM: code,
        update: (n) => {
          if (n.type !== current.type) return false;
          if (lang(n) !== lang(current)) fill(lang(n));
          select.disabled = !editor.isEditable;
          current = n;
          return true;
        },
        ignoreMutation: (m) => m.target === select || select.contains(m.target),
        stopEvent: (e) => e.target === select,
      };
    };
  },
});

/** Image (schema: @calaba/wiki-doc): an uploaded file of the page; the picker and the view. */
export const WikiImage = ImageNode.extend<{ env: EditorEnv | null }>({
  addOptions: () => ({ env: null }),
  addCommands() {
    return {
      pickImage:
        () =>
        ({ editor }) => {
          const env = this.options.env;
          if (!env?.upload || !editor.isEditable) return false;
          pickImage(editor.view, env);
          return true;
        },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

/** Mention `@<user id>` (like chat): the label is looked up live; the stored one is a fallback. */
export function wikiMention(env: EditorEnv) {
  return Mention.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('span');
        dom.className = 'wiki-mention';
        dom.dataset['type'] = 'mention';
        const paint = (n: PmNode): void => {
          const id = str(n.attrs['id'], '');
          dom.dataset['id'] = id;
          dom.textContent = `@${env.mentions?.label(id) ?? str(n.attrs['label'])}`;
        };
        paint(node);
        return {
          dom,
          update: (n) => {
            if (n.type !== node.type) return false;
            paint(n);
            return true;
          },
        };
      };
    },
  }).configure({
    HTMLAttributes: { class: 'wiki-mention' },
    renderText: ({ node }) => `@${str(node.attrs['label']) || str(node.attrs['id'])}`,
    renderHTML: ({ node, options }) => ['span', mergeAttributes({ 'data-type': 'mention', 'data-id': str(node.attrs['id']) }, options.HTMLAttributes), `@${str(node.attrs['label'], '')}`],
    // Items are MentionCandidates; our own command inserts the node (Mention types them as attrs).
    suggestion: mentionSuggestion(env) as unknown as Partial<SuggestionOptions>,
  });
}

export { HIGHLIGHT_COLORS, type HighlightColor } from '@calaba/wiki-doc/schema';

/** Highlight colours are names (themed by CSS), never raw CSS from the doc. */
export const WikiHighlight = HighlightMark;

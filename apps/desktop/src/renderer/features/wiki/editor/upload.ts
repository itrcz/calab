/**
 * Images into a wiki page (ADR-0096 §3): paste, drop or «/Картинка» upload the file to the page and
 * insert an `image` node with its file id. While uploading, a placeholder is a widget decoration —
 * local to this screen, never in the shared doc (a co-author must not see a half-made node, and a
 * closed tab must not leave one behind). Base64 never reaches the doc.
 * Pasted markdown text (no HTML on the clipboard) is converted with lib/wiki/markdown.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { t } from '../../../i18n';
import { fromMarkdown, looksLikeMarkdown } from '../../../lib/wiki/markdown';
import type { EditorEnv } from './env';

const uploadKey = new PluginKey<DecorationSet>('wikiUpload');

type UploadMeta = { add: { id: object; pos: number; file: File } } | { remove: { id: object } };

function placeholder(file: File): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wiki-upload';
  el.setAttribute('role', 'status');
  const url = URL.createObjectURL(file);
  const img = document.createElement('img');
  img.alt = '';
  img.src = url;
  img.onload = img.onerror = () => URL.revokeObjectURL(url);
  const label = document.createElement('span');
  label.textContent = t('wiki.image.uploading');
  el.append(img, label);
  return el;
}

function uploadPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: uploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(uploadKey) as UploadMeta | undefined;
        if (meta && 'add' in meta) {
          const { id, pos, file } = meta.add;
          next = next.add(tr.doc, [Decoration.widget(pos, () => placeholder(file), { id, side: -1 })]);
        } else if (meta && 'remove' in meta) {
          next = next.remove(next.find(undefined, undefined, (spec) => (spec as { id?: object }).id === meta.remove.id));
        }
        return next;
      },
    },
    props: {
      decorations: (state) => uploadKey.getState(state),
    },
  });
}

function findPlaceholder(view: EditorView, id: object): number | null {
  const found = uploadKey.getState(view.state)?.find(undefined, undefined, (spec) => (spec as { id?: object }).id === id);
  return found?.[0]?.from ?? null;
}

const isImage = (f: File): boolean => /^image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i.test(f.type);

/** Uploads `file` and inserts the image at `pos` (mapped through edits made meanwhile). */
export function startUpload(view: EditorView, env: EditorEnv, file: File, pos: number): void {
  const upload = env.upload;
  if (!upload) return;
  const id = {};
  view.dispatch(view.state.tr.setMeta(uploadKey, { add: { id, pos, file } } satisfies UploadMeta));
  upload(file).then(
    (img) => {
      if (view.isDestroyed) return;
      const at = findPlaceholder(view, id);
      const tr = view.state.tr.setMeta(uploadKey, { remove: { id } } satisfies UploadMeta);
      const type = view.state.schema.nodes['image'];
      if (at !== null && type) tr.replaceRangeWith(at, at, type.create({ fileId: img.fileId, width: img.width || null, height: img.height || null, alt: file.name.slice(0, 300) }));
      view.dispatch(tr);
    },
    () => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(uploadKey, { remove: { id } } satisfies UploadMeta));
      env.onError(t('wiki.image.failed'));
    },
  );
}

/** «/Картинка»: the system file picker, then uploads at the selection. */
export function pickImage(view: EditorView, env: EditorEnv): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.addEventListener('change', () => {
    const pos = view.state.selection.from;
    for (const f of Array.from(input.files ?? []).filter(isImage)) startUpload(view, env, f, pos);
  });
  input.click();
}

function markdownSlice(editor: Editor, text: string, env: EditorEnv): Slice | null {
  const json = fromMarkdown(text, { mentionLabel: (id) => env.mentions?.label(id) ?? '' });
  try {
    const nodes = (json.content ?? []).map((n) => editor.schema.nodeFromJSON(n));
    return new Slice(Fragment.fromArray(nodes), 0, 0);
  } catch {
    return null;
  }
}

/** Paste / drop handling: image files upload, markdown text converts. */
export function wikiPaste(env: EditorEnv) {
  return Extension.create({
    name: 'wikiPaste',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        uploadPlugin(),
        new Plugin({
          props: {
            handlePaste: (view, event) => {
              if (!view.editable) return false;
              const data = event.clipboardData;
              if (!data) return false;
              const images = Array.from(data.files).filter(isImage);
              if (images.length) {
                if (!env.upload) return true; // never fall back to a base64 paste
                const pos = view.state.selection.from;
                if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection());
                for (const f of images) startUpload(view, env, f, pos);
                return true;
              }
              const text = data.getData('text/plain');
              const html = data.getData('text/html');
              const fromCodeEditor = data.types.includes('vscode-editor-data');
              if (!text || (html && !fromCodeEditor) || editor.isActive('codeBlock') || !looksLikeMarkdown(text)) return false;
              const slice = markdownSlice(editor, text, env);
              if (!slice) return false;
              view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
              return true;
            },
            handleDrop: (view, event, _slice, moved) => {
              if (moved || !view.editable) return false;
              const files = Array.from(event.dataTransfer?.files ?? []).filter(isImage);
              if (!files.length) return false;
              event.preventDefault();
              if (!env.upload) return true;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
              for (const f of files) startUpload(view, env, f, at);
              return true;
            },
          },
        }),
      ];
    },
  });
}

import { memo, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { t } from '../../i18n';

/**
 * The composer's body (owner 12.10, Apple Mail): an uncontrolled `contenteditable` — typed
 * paragraphs, the signature and the quoted original in one editable text. Its HTML is set once
 * (already sanitized, editor.ts) and read by the sheet on send / save, so typing never re-renders
 * React. Pasted text goes in as plain text; pasted files go to the attachment strip. ⌘B / ⌘I are
 * Chromium's own editing commands. The box is `contain: paint`: nothing in a quoted message can
 * draw outside it. Links do not navigate.
 */
export const ComposeEditor = memo(function ComposeEditor({
  initialHtml,
  editorRef,
  onEdited,
  onFiles,
}: {
  initialHtml: string;
  editorRef: RefObject<HTMLDivElement | null>;
  onEdited: (on: true) => void;
  onFiles: (files: File[]) => void;
}): ReactNode {
  const edited = useRef(false);
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = initialHtml;
    // New lines are paragraphs (not <div>s): the text part and the quote styling expect <p>.
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only API for a contenteditable's paragraph separator
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {
      // jsdom / older engines: the default separator is fine.
    }
  }, [initialHtml, editorRef]);
  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={t('mbox.editor')}
      spellCheck
      className="selectable relative mt-3 min-h-[220px] w-full cursor-text break-words text-[14px] leading-[1.5] text-fg outline-none [contain:paint] [&_a]:text-accent-text [&_a]:underline [&_blockquote]:my-1 [&_blockquote]:ml-1 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_img]:h-auto [&_img]:max-w-full [&_p]:m-0 [&_table]:max-w-full"
      data-testid="compose-text"
      onInput={() => {
        if (edited.current) return;
        edited.current = true;
        onEdited(true);
      }}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest('a')) e.preventDefault();
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        e.preventDefault();
        if (files.length) {
          onFiles(files);
          return;
        }
        const text = e.clipboardData.getData('text/plain');
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- insertText keeps the editor's undo stack; there is no replacement API
        if (text) document.execCommand('insertText', false, text);
      }}
    />
  );
});

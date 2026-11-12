/**
 * The composer's expanded editor (docs/08 «Расширенный редактор», like Telegram): the same draft as
 * the field — `text` is the composer's own state, nothing is stored here — in a near-full-window
 * dialog with a formatting bar. Enter is a newline; ⌘/Ctrl+Enter or «Отправить» sends; Esc and
 * «Свернуть» go back to the field (draft kept); «Удалить» clears it after a confirmation.
 */
import { Bold, Code, Italic, Link, Redo2, Strikethrough, Undo2 } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, IconButton, MOD, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { applyEdit, editorKey, formatSelection, type FormatKind } from './editorLogic';

export interface Sel {
  start: number;
  end: number;
}

interface BarProps {
  onFormat: (k: FormatKind) => void;
  onHistory: (cmd: 'undo' | 'redo') => void;
}

/** Buttons keep the focus in the field (`mousedown` default is prevented), so the selection survives a click. */
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

/** The formatting bar: only what messages already render. Memo: props are stable, typing never re-renders it. */
const FormatBar = memo(function FormatBar({ onFormat, onHistory }: BarProps): ReactNode {
  const b = (label: string, shortcut: string | undefined, icon: ReactNode, run: () => void, testId: string): ReactNode => (
    <IconButton label={label} {...(shortcut ? { shortcut } : {})} onMouseDown={keepFocus} onClick={run} data-testid={testId} className="mobile:size-11">
      {icon}
    </IconButton>
  );
  return (
    <div role="toolbar" aria-label={t('chat.editor.format')} className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line py-1.5" data-testid="editor-toolbar">
      {b(t('chat.editor.undo'), `${MOD}Z`, <Undo2 className="size-4" aria-hidden />, () => onHistory('undo'), 'editor-undo')}
      {b(t('chat.editor.redo'), `${MOD}⇧Z`, <Redo2 className="size-4" aria-hidden />, () => onHistory('redo'), 'editor-redo')}
      <span className="mx-1.5 h-4 w-px shrink-0 bg-line" aria-hidden />
      {b(t('chat.editor.bold'), `${MOD}B`, <Bold className="size-4" aria-hidden />, () => onFormat('bold'), 'editor-bold')}
      {b(t('chat.editor.italic'), `${MOD}I`, <Italic className="size-4" aria-hidden />, () => onFormat('italic'), 'editor-italic')}
      {b(t('chat.editor.strike'), `${MOD}⇧X`, <Strikethrough className="size-4" aria-hidden />, () => onFormat('strike'), 'editor-strike')}
      {b(t('chat.editor.code'), `${MOD}E`, <Code className="size-4" aria-hidden />, () => onFormat('code'), 'editor-code')}
      {b(t('chat.editor.link'), undefined, <Link className="size-4" aria-hidden />, () => onFormat('link'), 'editor-link')}
    </div>
  );
});

export function ExpandedEditor({
  title,
  text,
  setText,
  maxLength,
  initialSel,
  attachments,
  canSubmit,
  editing,
  onSend,
  onCollapse,
  onDelete,
}: {
  /** Where the text goes: «Сообщение в #общий», «Сообщение для Анны»… */
  title: string;
  text: string;
  /** The composer's own setter: the field and the editor are one draft. */
  setText: (s: string) => void;
  maxLength: number;
  /** The field's selection when the editor opened: the caret stays where it was. */
  initialSel: Sel;
  /** The staged files (the composer's own grid), shown above the buttons. */
  attachments: ReactNode;
  /** There is something to send. */
  canSubmit: boolean;
  /** Editing a sent message: «Сохранить» instead of «Отправить». */
  editing: boolean;
  /** Sends; true when it went (the composer then collapses the editor). */
  onSend: () => void;
  /** Back to the field with the editor's selection. */
  onCollapse: (sel: Sel) => void;
  /** Clears the draft (after the confirmation here). */
  onDelete: () => void;
}): ReactNode {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // The selection to restore after a re-render that replaced the text (the no-execCommand fallback).
  const pendingSel = useRef<Sel | null>(null);
  // The field's selection when the editor opened, read once on mount: later it is the user's.
  const initialSelRef = useRef(initialSel);

  // The textarea sits in a Radix portal that mounts one pass after this component, so «on mount» is
  // the moment the node is attached (a layout effect on first render sees `ref.current === null`
  // and would apply `initialSel` on the first keystroke instead — CBF-178).
  const attach = useCallback((el: HTMLTextAreaElement | null): void => {
    ref.current = el;
    if (!el) return;
    const sel = initialSelRef.current;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
    // Bring the caret into view (focus() alone leaves a long text at its top).
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
    const row = el.value.slice(0, sel.start).split('\n').length - 1;
    el.scrollTop = Math.max(0, row * line - el.clientHeight / 2);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pendingSel.current) return;
    el.setSelectionRange(pendingSel.current.start, pendingSel.current.end);
    pendingSel.current = null;
  }, [text]);

  const collapse = useCallback((): void => {
    const el = ref.current;
    onCollapse(el ? { start: el.selectionStart, end: el.selectionEnd } : initialSel);
  }, [onCollapse, initialSel]);

  const onFormat = useCallback(
    (kind: FormatKind): void => {
      const el = ref.current;
      if (!el) return;
      const edit = formatSelection(el.value, el.selectionStart, el.selectionEnd, kind);
      el.focus();
      el.setSelectionRange(edit.from, edit.to);
      // execCommand keeps the field's own undo stack (⌘Z takes a bold back); without it the state is set directly.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only way to edit a textarea without losing its undo stack
      if (document.execCommand('insertText', false, edit.insert)) {
        el.setSelectionRange(edit.selStart, edit.selEnd);
      } else {
        const next = applyEdit(el.value, edit);
        pendingSel.current = { start: next.selStart, end: next.selEnd };
        setText(next.text);
      }
    },
    [setText],
  );

  const onHistory = useCallback((cmd: 'undo' | 'redo'): void => {
    ref.current?.focus();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- drives the field's own undo stack
    document.execCommand(cmd);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const a = editorKey(e.nativeEvent);
    if (!a) return;
    e.preventDefault();
    if (a.type === 'send') {
      if (canSubmit) onSend();
    } else onFormat(a.kind);
  };

  const remove = (): void => {
    void confirmAction(t('chat.editor.deleteTitle'), t('chat.editor.deleteText'), t('common.delete')).then((ok) => {
      if (ok) onDelete();
    });
  };

  return (
    <Modal
      full
      open
      onClose={collapse}
      title={title}
      initialFocus={ref}
      focusOnPhone
      footer={
        <>
          <Button variant="destructive" className="mr-auto mobile:mr-0" onClick={remove} disabled={!text && !attachments} data-testid="editor-delete">
            {t('common.delete')}
          </Button>
          <Button variant="secondary" onClick={collapse} data-testid="editor-collapse">
            {t('chat.editor.collapse')}
          </Button>
          <Button variant="primary" onClick={onSend} disabled={!canSubmit} data-testid="editor-send">
            {editing ? t('common.save') : t('chat.send')}
          </Button>
        </>
      }
    >
      <FormatBar onFormat={onFormat} onHistory={onHistory} />
      <textarea
        ref={attach}
        value={text}
        maxLength={maxLength}
        aria-label={title}
        placeholder={t('chat.editor.placeholder')}
        data-testid="editor-field"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="selectable min-h-0 w-full flex-1 resize-none bg-transparent py-3 text-list leading-6 placeholder:text-faint focus:outline-none"
      />
      {text.length > maxLength - 200 ? (
        <div className="shrink-0 pb-2 text-right text-micro text-warn">
          {text.length}/{maxLength}
        </div>
      ) : null}
      {attachments ? <div className="shrink-0 pb-3">{attachments}</div> : null}
    </Modal>
  );
}

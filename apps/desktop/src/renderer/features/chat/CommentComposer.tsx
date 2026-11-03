/**
 * The comments' composer (owner 23.10: canvas and meeting comments write like the chat): the chat's
 * field, emoji, @ list, Enter to send / Shift+Enter for a line, the edit strip with Esc — from
 * ComposerField, like the chat's Composer. No attachments, slash commands, voice or stickers. The
 * wire text keeps the feature's format: `@<user_id>` for the members the caller offers.
 * Typing re-renders this component only (the text lives here).
 */
import { Pencil } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../../i18n';
import { applyMention, exactNames, filterCandidates, fromWire, toWire, type MentionCandidate } from '../../lib/mentions';
import { asBlock, htmlTableToMarkdown } from '../../lib/markdown/table';
import { autoFocusAllowed } from '../../lib/mobile';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { ComposerField, ContextBar, MentionList, SendButton, insertAt, useFieldAutosize, useMentionPicker } from './ComposerField';
import { enterInsertsNewline, trimMessage } from './composerText';
import type { MentionOption } from './MentionPopover';
import { previewPartsOf } from './mentionText';
import { PreviewRuns } from './PreviewRuns';

const NO_MENTIONS: ReadonlyMap<string, string> = new Map();

/** Who the @ list offers (the caller decides who may be called) and every name the field may hold. */
export interface CommentMentionSource {
  candidates: readonly MentionCandidate[];
  guests: ReadonlySet<string>;
  /** Members with the name shown in the field (a typed exact name becomes `@<id>` too). */
  all: ReadonlyArray<{ id: string; name: string }>;
}

/** A comment being edited in the composer. */
export interface CommentEdit {
  id: string;
  /** Its wire text. */
  wire: string;
}

export interface CommentComposerProps {
  workspaceId: string;
  placeholder: string;
  maxLength: number;
  mentions?: CommentMentionSource | undefined;
  /** The field got focus (the canvas asks who may be called only then). */
  onFieldFocus?: (() => void) | undefined;
  /** A limit of distinct mentions: past it the composer says so and does not send. */
  mentionLimit?: { max: number; label: string; count: (wire: string) => number } | undefined;
  editing?: CommentEdit | null | undefined;
  onCancelEdit?: (() => void) | undefined;
  /** Writes (or, with `editId`, edits); resolves true when done — the field clears. */
  onSubmit: (wire: string, editId?: string) => Promise<boolean>;
  /** Esc with nothing else to close (a new thread's draft). */
  onEscape?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
  /** A strip above the field while not editing (a new thread: «Новая ветка» ×). */
  bar?: ReactNode;
  className?: string | undefined;
  testId?: string | undefined;
  sendTestId?: string | undefined;
}

export function CommentComposer({
  workspaceId,
  placeholder,
  maxLength,
  mentions,
  onFieldFocus,
  mentionLimit,
  editing,
  onCancelEdit,
  onSubmit,
  onEscape,
  autoFocus = false,
  bar,
  className,
  testId,
  sendTestId,
}: CommentComposerProps): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(NO_MENTIONS);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string): string | undefined => (useWorkspaces.getState().byId[workspaceId]?.members[id] ? memberName(workspaceId, id) : undefined);

  // Edit mode uses the same field (like the chat): the draft is kept aside and comes back afterwards.
  const [editTrack, setEditTrack] = useState<string | undefined>(undefined);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState<{ text: string; picked: ReadonlyMap<string, string> } | null>(null);
  if (editing?.id !== editTrack) {
    setEditTrack(editing?.id);
    if (editing) {
      if (draftBeforeEdit === null) setDraftBeforeEdit({ text, picked });
      const w = fromWire(editing.wire, nameOf);
      setText(w.text);
      setPicked(w.mentions);
    } else if (draftBeforeEdit !== null) {
      setText(draftBeforeEdit.text);
      setPicked(draftBeforeEdit.picked);
      setDraftBeforeEdit(null);
    }
  }
  useEffect(() => {
    if (!editTrack) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editTrack]);
  useEffect(() => {
    if (autoFocus && autoFocusAllowed()) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, []);

  const mention = useMentionPicker(text, caret, (q) =>
    mentions ? filterCandidates(q.query, mentions.candidates).map((c): MentionOption => ({ kind: 'member', c, guest: mentions.guests.has(c.id) })) : [],
  );
  const pick = (o: MentionOption): void => {
    const q = mention.query;
    if (!q || o.kind !== 'member') return;
    const next = applyMention(text, q.start, caret, o.c.name);
    setText(next.text);
    setCaret(next.caret);
    setPicked((m) => new Map(m).set(o.c.name, o.c.id));
    // The completed @ stays closed while the caret is still after it (a name may hold spaces).
    mention.dismiss();
    pendingCaret.current = next.caret;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);
  const multi = useFieldAutosize(ref, text);

  const wire = (): string => toWire(trimMessage(text), new Map([...exactNames(mentions?.all ?? []), ...picked]));
  const overLimit = !!mentionLimit && text.includes('@') && mentionLimit.count(wire()) > mentionLimit.max;

  const cancelEdit = (): void => onCancelEdit?.();
  const send = (): void => {
    const w = wire();
    if (!w || busy || overLimit || w.length > maxLength) return;
    if (editing && w === editing.wire) {
      cancelEdit();
      return;
    }
    setBusy(true);
    void onSubmit(w, editing?.id).then((ok) => {
      setBusy(false);
      if (!ok) return;
      if (editing) {
        cancelEdit();
        return;
      }
      setText('');
      setPicked(NO_MENTIONS);
      ref.current?.focus();
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention.onKey(e, pick)) {
      // Esc closes the list only, not the panel or the card around the field.
      if (e.key === 'Escape') e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Inside an unclosed ``` block Enter is a new line of code (the textarea inserts it).
      if (enterInsertsNewline(text, e.currentTarget.selectionStart)) return;
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape' && (editing || onEscape)) {
      e.preventDefault();
      e.stopPropagation();
      if (editing) cancelEdit();
      else onEscape?.();
    }
  };

  const insert = (s: string): void => {
    const next = insertAt(ref.current, text, s);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
  };

  const editParts = editing ? previewPartsOf(workspaceId, editing.wire, 160) : [];
  return (
    <div className={className ?? 'px-2 pb-2 pt-1.5'} data-testid={testId ? `${testId}-box` : undefined}>
      {editing ? <ContextBar icon={<Pencil className="size-4" aria-hidden />} title={t('chat.editing')} text={editParts.length ? <PreviewRuns parts={editParts} /> : ''} onClose={cancelEdit} /> : bar}
      <ComposerField
        fieldRef={ref}
        text={text}
        placeholder={placeholder}
        maxLength={maxLength}
        multi={multi}
        onEmoji={insert}
        popover={<MentionList m={mention} onPick={pick} />}
        field={{
          'data-testid': testId,
          onChange: (e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          },
          onSelect: () => setCaret(ref.current?.selectionStart ?? 0),
          onFocus: () => {
            mention.undismiss();
            onFieldFocus?.();
          },
          onBlur: mention.dismiss,
          'aria-autocomplete': 'list',
          'aria-controls': mention.open ? mention.listId : undefined,
          'aria-activedescendant': mention.activeId,
          onKeyDown: onKey,
          onPaste: (e) => {
            const table = htmlTableToMarkdown(e.clipboardData.getData('text/html'), maxLength - text.length);
            if (!table) return;
            e.preventDefault();
            insert(asBlock(table, text, ref.current?.selectionStart ?? text.length));
          },
        }}
        action={text.trim() ? <SendButton editing={!!editing} onClick={send} testId={sendTestId} /> : null}
      />
      {overLimit ? <div className="mt-1 px-2 text-caption text-danger-text">{mentionLimit.label}</div> : null}
    </div>
  );
}

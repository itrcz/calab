import { BillingState, RoomType, type PermissionBits, type Room, type Sticker } from '@calaba/protocol';
import * as Dropdown from '../../components/radix/dropdown-menu';
import { Camera, CornerUpLeft, FileText, Image as ImageIcon, Paperclip, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CLOSE_HIT, IconButton, Tip, cx } from '../../components/ui';
import { asBlock, htmlTableToMarkdown } from '../../lib/markdown/table';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { MENTION_EVENT, takeMention, type MentionRequest } from './mentionRequest';
import { type MentionCandidate, applyMention, exactNames, filterCandidates, filterSpecial, fromWire, mentionQuery, toWire } from '../../lib/mentions';
import { can } from '../../lib/permissions';
import { systemPreview } from '../../lib/recording';
import { autoFocusAllowed, useMobile } from '../../lib/mobile';
import { MAX_ATTACHMENTS, MAX_CONTENT, editMessage, loadPresent, notifyTyping, sendMessage, type OutgoingFile } from '../../services/chat';
import { messageById, useMessages } from '../../stores/messages';
import { myUserId, useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useDms } from '../../stores/dms';
import { sendSticker } from '../../services/stickers';
import type { StickerPlace } from '../../lib/stickers';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useBillingState } from '../workspace/billing/BillingPaywall';
import { StickerButton } from './stickers/StickerPicker';
import { StickerSuggest, type StickerSuggestHandle } from './stickers/StickerSuggest';
import { singleEmoji } from '../../lib/stickerSuggest';
import { useMentionables, type MentionOption } from './MentionPopover';
import { ComposerField, ContextBar, MentionList, SendButton, insertAt, useFieldAutosize, useMentionPicker } from './ComposerField';
import { CommandPopover } from './CommandPopover';
import { applyCommand, commandKey, commandQuery, filterCommands, type CommandOption } from '../../lib/botCommands';
import { loadRoomCommands } from '../../services/bots';
import { useBots } from '../../stores/bots';
import { previewPartsOf } from './mentionText';
import { enterInsertsNewline, trimMessage } from './composerText';
import { ExpandedEditor, type Sel } from './ExpandedEditor';
import { isExpandHotkey, offersExpand } from './editorLogic';
import { shouldFocusOnAttach } from './attachFocus';
import { PreviewRuns } from './PreviewRuns';
import { roomLabel } from './roomLabel';
import { menuBox, menuItem } from './MessageMenu';
import { useVoiceRecorder } from './VoiceRecorder';
import { voiceFileName } from '../../lib/voiceNote';
import { IMAGE_ACCEPT } from '../../lib/image';
import { namedHeif } from '../../lib/image/decode';
import { voiceSupported, type VoiceResult } from '../../services/voiceRecorder';

import { loadDraft, saveDraft } from './drafts';
/** Task rooms: members without board access go after those with it (stable), then the usual cap of 8. */
function rankOutsidersLast(list: MentionCandidate[], outsiders: ReadonlyMap<string, unknown>): MentionCandidate[] {
  if (outsiders.size === 0) return list;
  return [...list.filter((c) => !outsiders.has(c.id)), ...list.filter((c) => outsiders.has(c.id))].slice(0, 8);
}

const NO_MENTIONS: ReadonlyMap<string, string> = new Map();

export function toOutgoing(f: File): OutgoingFile {
  const name = f.name || `image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  // HEIC has no preview in Chromium: a file chip until it is converted to JPEG on send.
  const preview = f.type.startsWith('image/') && !namedHeif(name, f.type);
  return { file: f, name, ...(preview ? { previewUrl: URL.createObjectURL(f) } : {}) };
}

/** Telegram-like composer (docs/09 #37): rounded field, 📎 left, emoji + round send right. */
export function Composer({
  workspaceId,
  room,
  perms,
  files,
  setFiles,
  addFiles,
  autoFocus = true,
}: {
  workspaceId: string;
  room: Room;
  perms: PermissionBits;
  files: OutgoingFile[];
  setFiles: (f: OutgoingFile[]) => void;
  addFiles: (f: File[]) => void;
  /** Focus the field when the room opens (desktop); off where it is not the main thing (a full-screen task). */
  autoFocus?: boolean;
}): ReactNode {
  const [text, setText] = useState(() => loadDraft(useSession.getState().me?.user?.id ?? '', room.id).text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const mobile = useMobile();
  const pendingCaret = useRef<number | null>(null);
  // docs/09 #149: a file staged from outside the field (drag-and-drop above all) leaves it
  // unfocused — Enter then does nothing until a click. `files` only grows on staging, never on
  // the box being cleared by a send, so this never re-steals focus at the wrong moment.
  const filesCount = useRef(files.length);
  const replyTo = useUi((s) => s.replyTo[room.id]);
  const setReply = useUi((s) => s.setReply);
  const editing = useUi((s) => s.editing);
  const setEditing = useUi((s) => s.setEditing);
  const replyMsg = useMessages((s) => (replyTo ? messageById(s, room.id, replyTo) : undefined));
  const editMsg = useMessages((s) => (editing ? messageById(s, room.id, editing) : undefined));
  const me = useSession((s) => s.me?.user?.id ?? '');
  const canSend = can(perms, 'SEND_MESSAGES');
  // A suspended workspace is read-only (docs/09 #32): the server refuses, the field explains.
  const suspended = useWorkspaces((s) => !!workspaceId && !!s.byId[workspaceId]?.ws.suspension);
  // «Тариф не активен» (ADR-0086 amendment): the server refuses writing; the field says why.
  const planInactive = useBillingState(workspaceId) === BillingState.LAPSED;
  const canAttach = can(perms, 'ATTACH_FILES');
  // Edit mode uses the same field: the draft is kept aside and comes back afterwards
  // (derived during render when the edited message changes — no effect cascade).
  const [editTrack, setEditTrack] = useState<string | undefined>(undefined);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState<{ text: string; mentions: ReadonlyMap<string, string> } | null>(null);
  // Mentions picked in the field (name → id); `@<id>` is what goes over the wire.
  const [mentions, setMentions] = useState<ReadonlyMap<string, string>>(() => loadDraft(useSession.getState().me?.user?.id ?? '', room.id).mentions ?? NO_MENTIONS);
  if (editMsg?.id !== editTrack) {
    setEditTrack(editMsg?.id);
    if (editMsg) {
      if (draftBeforeEdit === null) setDraftBeforeEdit({ text, mentions });
      // The field shows names: `@<id>` → `@Имя` for members known here.
      const w = fromWire(editMsg.content, (id) => (useWorkspaces.getState().byId[workspaceId]?.members[id] ? memberName(workspaceId, id) : undefined));
      setText(w.text);
      setMentions(w.mentions);
    } else if (draftBeforeEdit !== null) {
      setText(draftBeforeEdit.text);
      setMentions(draftBeforeEdit.mentions);
      setDraftBeforeEdit(null);
    }
  }

  useEffect(() => {
    if (draftBeforeEdit !== null) return;
    saveDraft(me, room.id, text, mentions);
  }, [me, room.id, text, mentions, draftBeforeEdit]);

  // ---- mention autocomplete (docs/05, «Упоминания»)
  const [caret, setCaret] = useState(0);
  // The popover is open (an @query under the caret): the task rooms ask the server who sees the board.
  const mentionables = useMentionables(workspaceId, room, me, mentionQuery(text, caret) !== null);
  const mention = useMentionPicker(text, caret, (q) => [
    ...rankOutsidersLast(filterCandidates(q.query, mentionables.candidates, mentionables.outsiders.size ? 100 : 8), mentionables.outsiders).map((c): MentionOption => ({ kind: 'member', c, guest: mentionables.guests.has(c.id), outsider: mentionables.outsiders.get(c.id), role: mentionables.roles.get(c.id)?.role, custom: mentionables.roles.get(c.id)?.custom })),
    // @everyone / @here only with MENTION_EVERYONE in this room (guests never have it, ADR-0016).
    ...(!can(perms, 'MENTION_EVERYONE') ? [] : filterSpecial(q.query).map((v): MentionOption => ({ kind: 'special', v }))),
  ]);
  const mq = mention.query;
  const popover = mention.open;
  const syncCaret = (): void => setCaret(ref.current?.selectionStart ?? 0);

  // ---- bot commands (ADR-0031 §6): `/` at the start hints the room's bots' commands
  const cmdListId = useId();
  const slash = !editMsg && text.startsWith('/');
  const roomCommands = useBots((s) => s.commands[room.id]?.bots);
  useEffect(() => {
    if (slash) void loadRoomCommands(room.id);
  }, [slash, room.id, roomCommands]);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  if (!slash && cmdDismissed) setCmdDismissed(false);
  const cq = slash && !cmdDismissed ? commandQuery(text, caret) : null;
  const cmdOptions: CommandOption[] = cq && roomCommands ? filterCommands(cq, roomCommands) : [];
  const cmdPopover = cmdOptions.length > 0;
  const [cmdSel, setCmdSel] = useState(0);
  const cmdIdx = Math.min(cmdSel, Math.max(0, cmdOptions.length - 1));
  const [cmdTrack, setCmdTrack] = useState<string | null>(null);
  const cmdKeyNow = cq ? `${cq.name}@${cq.bot ?? ''}` : null;
  if (cmdKeyNow !== cmdTrack) {
    setCmdTrack(cmdKeyNow);
    setCmdSel(0);
  }
  const pickCommand = (o: CommandOption): void => {
    if (!cq) return;
    const next = applyCommand(text, cq, o);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
  };

  const pick = (o: MentionOption): void => {
    if (!mq) return;
    const name = o.kind === 'member' ? o.c.name : o.v;
    const next = applyMention(text, mq.start, caret, name);
    setText(next.text);
    setCaret(next.caret);
    if (o.kind === 'member') setMentions((m) => new Map(m).set(name, o.c.id));
    // Placed right after the re-render (not in a frame callback: fast typing would land before it).
    pendingCaret.current = next.caret;
  };

  // «Упомянуть» from a member menu (mentionRequest.ts): append `@name ` and focus the field.
  // A request for a given room (birthday «Поздравить») waits for that room's composer.
  const roomIdRef = useRef(room.id);
  useEffect(() => {
    roomIdRef.current = room.id;
  }, [room.id]);
  const applyMentionRequest = useCallback((d: MentionRequest): void => {
    setText((cur) => {
      const next = `${cur && !/\s$/.test(cur) ? `${cur} ` : cur}@${d.name} `;
      pendingCaret.current = next.length;
      return next;
    });
    setMentions((m) => new Map(m).set(d.name, d.userId));
    ref.current?.focus();
  }, []);
  useEffect(() => {
    const onMention = (e: Event): void => {
      const d = (e as CustomEvent<MentionRequest>).detail;
      const req = d.roomId ? takeMention(roomIdRef.current) : d;
      if (req) applyMentionRequest(req);
    };
    window.addEventListener(MENTION_EVENT, onMention);
    return () => window.removeEventListener(MENTION_EVENT, onMention);
  }, [applyMentionRequest]);
  useEffect(() => {
    const req = takeMention(room.id);
    if (req) applyMentionRequest(req);
  }, [room.id, applyMentionRequest]);

  /** Field text → wire format: picked names and exact member names become `@<id>`. */
  const wire = (content: string): string => toWire(content, new Map([...exactNames(mentionables.all), ...mentions]));

  useEffect(() => {
    if (!editTrack) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editTrack]);

  // Opening a room focuses the field on desktop (type right away); on phones only a tap does
  // (iOS would scroll to it and raise the keyboard, lib/mobile.ts). «Ответить» is the user's own
  // request to write: it focuses the field everywhere.
  useEffect(() => {
    if (autoFocus && autoFocusAllowed()) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a room change only
  }, [room.id]);
  useEffect(() => {
    if (replyTo || (autoFocus && autoFocusAllowed())) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a reply change only
  }, [replyTo]);
  // Staging a file (drop, paste, the paperclip, the camera) always focuses the field, on phones
  // too — like «Ответить» above, it is the user's own request to keep writing (docs/09 #149).
  useEffect(() => {
    if (shouldFocusOnAttach(filesCount.current, files.length)) ref.current?.focus();
    filesCount.current = files.length;
  }, [files.length]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);
  // Phone: a second line moves the text to a row of its own above the buttons.
  const multi = useFieldAutosize(ref, text);

  const cancelEdit = (): void => setEditing(null);

  // Expanded editor (#97): another view over the same `text`; `editorSel` is the field's selection
  // at the moment it opened, `restoreSel` the editor's selection to put back into the field.
  const [editorSel, setEditorSel] = useState<Sel | null>(null);
  const restoreSel = useRef<Sel | null>(null);
  const openEditor = (): void => {
    const el = ref.current;
    setEditorSel({ start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length });
  };
  const collapseEditor = useCallback((sel: Sel): void => {
    restoreSel.current = sel;
    setEditorSel(null);
  }, []);
  const editorOpen = editorSel !== null;
  useEffect(() => {
    if (editorOpen) return;
    const sel = restoreSel.current;
    restoreSel.current = null;
    if (!sel) return;
    // After the dialog has given the focus back (Radix does it on unmount).
    const id = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(sel.start, sel.end);
    }, 30);
    return () => window.clearTimeout(id);
  }, [editorOpen]);

  // Voice messages (docs/09 #43): recorded, then sent at once as a message of its own.
  const sendVoice = (r: VoiceResult): void => {
    if (useMessages.getState().rooms[room.id]?.hasMoreAfter) void loadPresent(room.id);
    const file = { file: r.blob, name: voiceFileName(new Date()), voice: { durationMs: r.durationMs, waveform: r.waveform } };
    void sendMessage(workspaceId, room.id, '', [file], replyTo);
    setReply(room.id, undefined);
  };
  const voice = useVoiceRecorder({ onSend: sendVoice });

  // Stickers (ADR-0030): a message of their own, like a voice message; not while editing.
  // A notes shelf (ADR-0039): the packs of my workspaces, as in a DM with myself.
  const dmPeer = useDms((s) => (room.type === RoomType.DM ? (s.byRoom[room.id]?.peerId ?? '') : room.type === RoomType.NOTES ? myUserId() : ''));
  const stickerPlace = useMemo<StickerPlace | null>(() => (workspaceId ? { workspaceId } : dmPeer ? { dmPeerId: dmPeer } : null), [workspaceId, dmPeer]);
  const stickers =
    stickerPlace && canSend && !suspended && !editMsg
      ? {
          place: stickerPlace,
          onSend: (s: Parameters<typeof sendSticker>[2]) => {
            if (useMessages.getState().rooms[room.id]?.hasMoreAfter) void loadPresent(room.id);
            void sendSticker(workspaceId, room.id, s, replyTo);
            setReply(room.id, undefined);
          },
        }
      : undefined;

  // Stickers by emoji (docs/08 «Композер — подсказка стикеров»): exactly one emoji in the field →
  // the strip above it. It gets only the emoji and stable callbacks, so typing does not re-render it.
  const suggestRef = useRef<StickerSuggestHandle>(null);
  const [suggestOff, setSuggestOff] = useState<string | null>(null);
  if (suggestOff !== null && suggestOff !== text) setSuggestOff(null);
  const suggestEmoji = stickers && files.length === 0 && !voice.active && suggestOff !== text ? singleEmoji(text) : null;
  const latest = useRef({ text, send: stickers?.onSend });
  useLayoutEffect(() => {
    latest.current = { text, send: stickers?.onSend };
  });
  const onSuggestSend = useCallback((s: Sticker) => {
    latest.current.send?.(s);
    setText('');
    setMentions(NO_MENTIONS);
  }, []);
  const onSuggestDismiss = useCallback(() => setSuggestOff(latest.current.text), []);

  const send = (): boolean => {
    const content = wire(trimMessage(text));
    if (content.length > MAX_CONTENT) return false;
    if (editMsg) {
      if (!content && editMsg.attachments.length === 0) return false;
      if (content !== editMsg.content) void editMessage(editMsg.id, content);
      cancelEdit();
      return true;
    }
    if (!content && files.length === 0) return false;
    // Viewing older history: go back to the present so the new message is visible.
    if (useMessages.getState().rooms[room.id]?.hasMoreAfter) void loadPresent(room.id);
    void sendMessage(workspaceId, room.id, content, files, replyTo);
    setText('');
    setMentions(NO_MENTIONS);
    setFiles([]);
    setReply(room.id, undefined);
    return true;
  };

  /** Sends from the editor: on success it closes (the draft is gone), otherwise it stays with the text. */
  const sendFromEditor = (): void => {
    if (send()) setEditorSel(null);
  };

  const deleteDraft = (): void => {
    setText('');
    setMentions(NO_MENTIONS);
    if (!editMsg) setFiles([]);
    setEditorSel(null);
    // The field, now empty, takes the focus back.
    window.setTimeout(() => ref.current?.focus(), 30);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isExpandHotkey(e.nativeEvent)) {
      e.preventDefault();
      openEditor();
      return;
    }
    if (suggestEmoji && suggestRef.current?.onKey(e)) return;
    if (cmdPopover && !e.nativeEvent.isComposing) {
      const o = cmdOptions[cmdIdx];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdSel((cmdIdx + (e.key === 'ArrowDown' ? 1 : cmdOptions.length - 1)) % cmdOptions.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (o) pickCommand(o);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdDismissed(true);
        return;
      }
    }
    if (mention.onKey(e, pick)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Inside an unclosed ``` block Enter is a new line of code (the textarea inserts it).
      if (enterInsertsNewline(text, e.currentTarget.selectionStart)) return;
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape') {
      if (editMsg) {
        e.preventDefault();
        cancelEdit();
      } else if (replyTo) {
        e.preventDefault();
        setReply(room.id, undefined);
      }
      return;
    }
    if (e.key === 'ArrowUp' && !text && !editMsg) {
      // Edit my last message (Telegram / Discord habit).
      const items = useMessages.getState().rooms[room.id]?.items ?? [];
      const mine = [...items].reverse().find((c) => c.status === 'sent' && c.msg.authorId === me);
      // A sticker message (ADR-0030) or a forwarded copy (ADR-0033) cannot be edited: ↑ does nothing then.
      if (mine && !mine.msg.sticker && !mine.msg.forward) {
        e.preventDefault();
        setEditing(mine.key);
      }
    }
  };

  const onPaste = (e: ClipboardEvent): void => {
    // A table copied from a sheet or a page comes as text and a picture of it: the text (a pipe table) wins (board #148).
    const table = htmlTableToMarkdown(e.clipboardData.getData('text/html'), MAX_CONTENT - text.length);
    if (table) {
      e.preventDefault();
      insert(asBlock(table, text, ref.current?.selectionStart ?? text.length));
      return;
    }
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length && canAttach && !editMsg) {
      e.preventDefault();
      addFiles(imgs);
    }
  };

  const insert = (s: string): void => {
    const el = ref.current;
    const next = insertAt(el, text, s);
    setText(next.text);
    setCaret(next.caret);
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    }
  };

  if (suspended) {
    return (
      <div className="mx-4 my-3 rounded-[var(--radius-card)] bg-hover px-4 py-3 text-body text-muted" data-testid="composer-suspended">
        {t('suspended.composer')}
      </div>
    );
  }
  if (planInactive) {
    return (
      <div className="mx-4 my-3 rounded-[var(--radius-card)] bg-hover px-4 py-3 text-body text-muted" data-testid="composer-plan-inactive">
        {t('billing.lapsed.composer')}
      </div>
    );
  }
  if (!canSend) {
    return <div className="mx-4 my-3 rounded-[var(--radius-card)] bg-hover px-4 py-3 text-body text-muted">{t('chat.noSend')}</div>;
  }

  const hasContent = !!text.trim() || (!editMsg && files.length > 0);
  // The mic replaces «send» while there is nothing to send (Telegram); it stays during a recording.
  const showMic = voice.active || (!hasContent && !editMsg && canAttach && voiceSupported());
  const placeholder =
    room.type === RoomType.DM
      ? t('dm.placeholder', { name: roomLabel(room) })
      : room.type === RoomType.NOTES
        ? t('notes.placeholder', { name: room.name })
        : room.type === RoomType.TASK
          ? t('boards.commentPlaceholder')
          : t('chat.placeholderIn', { room: roomLabel(room) });
  const editorTitle = editMsg
    ? t('chat.editor.titleEdit')
    : room.type === RoomType.DM
      ? t('chat.editor.titleDm', { name: roomLabel(room) })
      : room.type === RoomType.NOTES
        ? t('chat.editor.titleNotes', { name: room.name })
        : room.type === RoomType.TASK
          ? t('chat.editor.titleTask')
          : t('chat.editor.titleRoom', { room: roomLabel(room) });
  const bar = editMsg ? (
    <ContextBar
      icon={<Pencil className="size-4" aria-hidden />}
      title={t('chat.editing')}
      text={snippet(workspaceId, editMsg.content)}
      onClose={cancelEdit}
    />
  ) : replyMsg ? (
    <ContextBar
      icon={<CornerUpLeft className="size-4" aria-hidden />}
      title={t('chat.replyTo', { name: memberName(workspaceId, replyMsg.authorId) })}
      text={systemPreview(replyMsg) || snippet(workspaceId, replyMsg.content, t('chat.attachment'))}
      onClose={() => setReply(room.id, undefined)}
    />
  ) : null;

  return (
    <div className="px-4 pb-3 pt-2 mobile:px-2 mobile:pb-2 mobile:pt-3">
      {editorSel ? (
        <ExpandedEditor
          title={editorTitle}
          text={text}
          setText={setText}
          maxLength={MAX_CONTENT}
          initialSel={editorSel}
          attachments={files.length > 0 && !editMsg ? <AttachmentGrid files={files} setFiles={setFiles} /> : null}
          canSubmit={hasContent}
          editing={!!editMsg}
          onSend={sendFromEditor}
          onCollapse={collapseEditor}
          onDelete={deleteDraft}
        />
      ) : null}
      {bar}
      {files.length > 0 && !editMsg ? <AttachmentGrid files={files} setFiles={setFiles} /> : null}
      <ComposerField
        fieldRef={ref}
        text={text}
        placeholder={placeholder}
        maxLength={MAX_CONTENT}
        multi={multi}
        hidden={voice.active}
        onExpand={offersExpand(text) && !voice.active ? openEditor : undefined}
        onEmoji={insert}
        popover={
          cmdPopover ? (
            <CommandPopover id={cmdListId} options={cmdOptions} sel={cmdIdx} onPick={pickCommand} onHover={setCmdSel} />
          ) : popover ? (
            <MentionList m={mention} onPick={pick} />
          ) : suggestEmoji && stickerPlace ? (
            <StickerSuggest key={suggestEmoji} ref={suggestRef} emoji={suggestEmoji} place={stickerPlace} me={me} onSend={onSuggestSend} onDismiss={onSuggestDismiss} />
          ) : null
        }
        strip={voice.strip}
        leading={(isMulti) => (
            canAttach && !editMsg ? (
            <Dropdown.Root modal={false}>
              <Tip label={t('chat.attach')}>
                <Dropdown.Trigger asChild>
                  <IconButton tip={false} label={t('chat.attach')} className={cx('mb-1 rounded-full mobile:mb-0 mobile:size-11', isMulti && 'mobile:row-start-2')} disabled={files.length >= MAX_ATTACHMENTS}>
                    <Paperclip className="size-5" />
                  </IconButton>
                </Dropdown.Trigger>
              </Tip>
              <Dropdown.Portal>
                <Dropdown.Content side="top" align="start" sideOffset={8} className={menuBox}>
                  <Dropdown.Item className={menuItem} onSelect={() => imageInput.current?.click()}>
                    <ImageIcon className="size-4" aria-hidden /> {t('chat.attachImage')}
                  </Dropdown.Item>
                  <Dropdown.Item className={menuItem} onSelect={() => fileInput.current?.click()}>
                    <FileText className="size-4" aria-hidden /> {t('chat.attachFile')}
                  </Dropdown.Item>
                  {mobile ? (
                    // Phone layout (ADR-0021): straight to the camera (`capture`), next to the gallery and files.
                    <Dropdown.Item className={menuItem} onSelect={() => cameraInput.current?.click()}>
                      <Camera className="size-4" aria-hidden /> {t('mobile.takePhoto')}
                    </Dropdown.Item>
                  ) : null}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : (
            <span className="w-2 mobile:hidden" />
          )
        )}
        hiddenInputs={
          <>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          {mobile ? (
            <input
              ref={cameraInput}
              type="file"
              accept={`${IMAGE_ACCEPT},video/*`}
              capture="environment"
              hidden
              data-testid="composer-camera-input"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          ) : null}
          <input
            ref={imageInput}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          </>
        }
        extra={stickers ? <StickerButton place={stickers.place} onSend={stickers.onSend} /> : null}
        field={{
          onChange: (e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            if (e.target.value && !editMsg) notifyTyping(room.id);
          },
          onSelect: syncCaret,
          onBlur: () => {
            mention.dismiss();
            if (slash) setCmdDismissed(true);
          },
          onFocus: () => {
            mention.undismiss();
            setCmdDismissed(false);
          },
          'aria-autocomplete': 'list',
          'aria-controls': cmdPopover ? cmdListId : popover ? mention.listId : undefined,
          'aria-activedescendant': cmdPopover && cmdOptions[cmdIdx] ? `${cmdListId}-${commandKey(cmdOptions[cmdIdx])}` : mention.activeId,
          onKeyDown: onKey,
          onPaste,
        }}
        action={showMic ? voice.button : hasContent ? <SendButton editing={!!editMsg} onClick={send} /> : null}
      />
    </div>
  );
}

function snippet(workspaceId: string, content: string, empty = ''): ReactNode {
  const parts = previewPartsOf(workspaceId, content, 160);
  return parts.length ? <PreviewRuns parts={parts} /> : empty;
}

function AttachmentGrid({ files, setFiles }: { files: OutgoingFile[]; setFiles: (f: OutgoingFile[]) => void }): ReactNode {
  return (
    <div className="mb-2 flex max-h-[200px] flex-wrap gap-2 overflow-y-auto" data-testid="composer-attachments">
      {files.map((f, i) => (
        <div
          key={`${f.name}-${i}`}
          className={cx(
            'relative shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line bg-elev',
            f.previewUrl ? 'size-20' : 'flex h-20 w-44 items-center gap-2 px-2',
          )}
          title={f.name}
        >
          {f.previewUrl ? (
            <img src={f.previewUrl} alt={f.name} className="size-full object-cover" />
          ) : (
            <>
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-fg">
                <FileText className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-body font-medium">{f.name}</span>
                <span className="block text-caption text-muted">{fmt.size(f.file.size)}</span>
              </span>
            </>
          )}
          <Tip label={t('chat.removeAttachment', { name: f.name })}>
            <button
              type="button"
              className={cx(CLOSE_HIT, 'absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-[rgb(0_0_0/55%)] text-[color:var(--color-on-accent)] hover:bg-[rgb(0_0_0/70%)]')}
              aria-label={t('chat.removeAttachment', { name: f.name })}
              onClick={() => setFiles(files.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        </div>
      ))}
    </div>
  );
}

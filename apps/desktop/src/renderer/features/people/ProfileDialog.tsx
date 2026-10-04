import * as DialogP from '@radix-ui/react-dialog';
import { WorkspaceRole } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Cake, Ellipsis, MessageCircle, Phone, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Avatar, avatarColor } from '../../components/Avatar';
import { Logo } from '../../components/Logo';
import { MediaImg, useMediaUrl } from '../../components/MediaImg';
import { Button, CLOSE_HIT, Tip, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { api, thumbnailPath } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { startDm } from '../../services/dms';
import { LocalTime } from './LocalTime';
import { ClientVersion } from './ClientVersion';
import { BirthdayInfo } from './Birthday';
import { ProfileDialogAchievements } from './ProfileAchievements';
import { isGuest, rolesOf, useMemberName, useMemberRoles, useRoleLook, useWorkspaces } from '../../stores/workspaces';
import { useSession } from '../../stores/session';
import { canEditMemberBirthday } from './members';
import { MemberBirthdayDialog } from './MemberBirthdayDialog';
import { requestMention } from '../chat/mentionRequest';
import { useCanCall, useCanDm } from '../dm/canDm';
import { useOnCall } from '../call/CallBits';
import { startCall } from '../../services/call';
import { promoteGuest, toggleMemberRole } from './actions';
import { MemberPicker } from './MemberPicker';
import type { PeoplePickItem, RolePickItem } from './memberPickItems';
import { roleColorCss } from '../../lib/roles';
import { BotBadge, GuestBadge, roleName, roleTextClass, roleTextStyle } from './MemberBits';
import { BotActions, BotAvatarControls, BotDetails, BotHandle } from './BotProfile';
import { EditBadge } from './ProfileBadge';
import { BadgeOrRoleMark } from './MemberBadge';
import { MemberContextMenu, useMemberActions } from './MemberContextMenu';
import { NOTE_MAX, createNoteSaver, type NoteSaveState, type NoteSaver } from './noteSaver';

/** Role dot colour: owner / admin tokens, the rest neutral. */
function roleDot(role: WorkspaceRole): string {
  if (role === WorkspaceRole.OWNER) return 'bg-[var(--color-role-owner)]';
  if (role === WorkspaceRole.ADMIN) return 'bg-[var(--color-role-admin)]';
  return 'bg-[var(--color-label-tertiary)]';
}

/**
 * Banner colour (docs/09 #20: «цвет из аватара»): the average colour of the avatar picture, or the
 * identity colour behind the initial. A picture the canvas may not read (another origin) falls
 * back to the identity colour.
 */
function useBannerColor(userId: string, fileId: string | undefined): string {
  const url = useMediaUrl(fileId ? thumbnailPath(fileId) : null);
  const [picked, setPicked] = useState<{ url: string; color: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const g = c.getContext('2d');
        if (!g) return;
        g.drawImage(img, 0, 0, 1, 1); // the browser averages the picture into one pixel
        const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
        if (alive) setPicked({ url, color: `rgb(${r} ${gr} ${b})` });
      } catch {
        // tainted canvas: keep the identity colour
      }
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return picked && picked.url === url ? picked.color : avatarColor(userId);
}

/**
 * Member profile (docs/09 #20, reference: Discord profile): banner in
 * the avatar's colour, avatar 80 with presence, name + profile name, local time «UTC+3 · 14:05», «Написать»
 * (accent) · «Упомянуть» · «…» (the member menu), «Участник с» (registration · this workspace),
 * «Роли» chips with × and + (by rights; the server re-checks), and «Заметка (видна только вам)»
 * saved as you type (800 ms debounce, GET/PUT /api/users/{id}/note).
 */
export function ProfileDialog({
  workspaceId,
  userId,
  focusNote,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  focusNote: boolean;
  onClose: () => void;
}): ReactNode {
  const m = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const name = useMemberName(workspaceId, userId);
  const look = useRoleLook(workspaceId, userId);
  const canDm = useCanDm(workspaceId, userId);
  const canCall = useCanCall(userId, workspaceId);
  const onCall = useOnCall(userId);
  const u = m?.user;
  const banner = useBannerColor(userId, u?.avatarFileId || undefined);
  const content = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // The member left (or the workspace is gone) while the dialog was open.
  useEffect(() => {
    if (!m?.user) onClose();
  }, [m, onClose]);
  if (!m || !u) return null;
  const statusLine = [u.statusEmoji, u.statusText].filter(Boolean).join(' ');
  const registered = u.createdAt ? timestampDate(u.createdAt) : null;
  const joined = m.joinedAt ? timestampDate(m.joinedAt) : null;
  const leave = (then: () => void): void => {
    onClose();
    then();
  };
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          ref={content}
          aria-modal="true"
          aria-label={t('people.openProfile', { name })}
          data-testid="profile-dialog"
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // The dialog itself (Radix would focus the close box first and show its tooltip); the
            // note on «Добавить заметку» (read-only until loaded, but focusable).
            e.preventDefault();
            (focusNote ? noteRef.current : content.current)?.focus();
          }}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[calc(100vh-64px)] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] text-body focus:outline-none',
            'mobile:anim-sheet mobile:inset-x-0 mobile:bottom-0 mobile:top-auto mobile:max-h-[calc(var(--app-height)-var(--safe-top)-16px)] mobile:w-full mobile:max-w-none mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-b-none mobile:rounded-t-[16px] mobile:pb-[var(--safe-bottom)]',
          )}
        >
          {/* Banner and body scroll together: the avatar overlaps the banner edge and must not be
              clipped by the scroll box. The close box stays on top, outside the scroller. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="h-[88px]" style={{ background: banner }} data-testid="profile-banner" />
            <div className="px-5 pb-5">
              {/* Avatar 80 over the banner edge, ringed with the sheet colour (presence dot too). */}
              <div className="relative -mt-11 mb-2 inline-flex rounded-full bg-[var(--color-popover-solid)] p-1.5">
                <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={80} presence ring="var(--color-popover-solid)" />
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <DialogP.Title className={cx('min-w-0 truncate text-title font-semibold leading-tight', roleTextClass(m.role, 'role', look))} style={roleTextStyle(m.role, 'role', look)} title={name}>
                  {name}
                </DialogP.Title>
                {/* 20 px inline after the name, no text line (docs/08 «Бейдж»); its name is the tooltip. */}
                <BadgeOrRoleMark workspaceId={workspaceId} userId={userId} role={m.role} custom={look} size={20} />
                {isGuest(m) ? <GuestBadge /> : null}
                {u.isBot ? <BotBadge /> : null}
              </div>
              {m.nickname && m.nickname !== u.displayName ? (
                <div className="truncate text-body text-muted" title={u.displayName}>
                  {u.displayName}
                </div>
              ) : null}
              {u.isBot ? <BotHandle botUserId={userId} /> : null}
              <DialogP.Description className={statusLine ? 'selectable mt-1 break-words text-body' : 'sr-only'}>{statusLine || name}</DialogP.Description>
              {onCall ? (
                // ADR-0034: in a one-to-one call now (with whom is not disclosed).
                <div className="mt-1 flex items-center gap-1.5 text-body text-muted">
                  <Phone className="size-4 shrink-0 text-ok" aria-hidden />
                  {t('call.onCall')}
                </div>
              ) : null}
              <LocalTime userId={userId} variant="line" />
              {u.isBot ? null : <ClientVersion userId={userId} />}
              <BirthdayInfo userId={userId} variant="line" />
              <EditBirthday workspaceId={workspaceId} userId={userId} />
              <EditBadge workspaceId={workspaceId} userId={userId} />

              <div className="mt-4 flex items-center gap-2">
                {canDm ? (
                  <Button size="lg" onClick={() => leave(() => void startDm(userId))}>
                    <MessageCircle className="size-4" aria-hidden />
                    {t('dm.write')}
                  </Button>
                ) : null}
                <Button size="lg" variant="secondary" onClick={() => leave(() => requestMention(userId, name))}>
                  <AtSign className="size-4" aria-hidden />
                  {t('people.menu.mention')}
                </Button>
                {canCall ? (
                  // ADR-0034: «Позвонить» — a round button like «…» (three labelled buttons do not fit 440).
                  <Tip label={t('call.call')}>
                    <button
                      type="button"
                      aria-label={t('call.call')}
                      data-testid="profile-call"
                      onClick={() => leave(() => void startCall(userId))}
                      className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-fg transition-[filter] duration-[var(--motion-fast)] hover:brightness-125"
                    >
                      <Phone className="size-4" aria-hidden />
                    </button>
                  </Tip>
                ) : null}
                <MoreButton workspaceId={workspaceId} userId={userId} />
              </div>

              {u.isBot ? (
                // ADR-0031: what the bot is and does; add it elsewhere or block it.
                <div className="mt-4 flex flex-col gap-3">
                  <BotDetails botUserId={userId} />
                  <BotActions botUserId={userId} />
                  <BotAvatarControls workspaceId={workspaceId} botUserId={userId} />
                </div>
              ) : null}

              {registered || joined ? (
                <Section title={t('people.profile.memberSince')}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
                    {registered ? (
                      <span className="inline-flex items-center gap-1.5" title={t('people.profile.registered', { date: fmt.date(registered) })}>
                        <Logo size={16} className="rounded-[4px]" />
                        {fmt.shortDate(registered)}
                      </span>
                    ) : null}
                    {registered && joined ? (
                      <span className="text-faint" aria-hidden>
                        •
                      </span>
                    ) : null}
                    {joined && ws ? (
                      <span className="inline-flex items-center gap-1.5" title={t('people.profile.joinedWs', { ws: ws.name, date: fmt.date(joined) })}>
                        <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-hover text-[10px] font-semibold" aria-hidden>
                          {ws.iconFileId ? <MediaImg path={thumbnailPath(ws.iconFileId)} alt="" className="size-full object-cover" /> : (ws.name.trim()[0] ?? '?').toUpperCase()}
                        </span>
                        {fmt.shortDate(joined)}
                      </span>
                    ) : null}
                  </div>
                </Section>
              ) : null}

              <Section title={t('people.profile.roles')}>
                <RoleChips workspaceId={workspaceId} userId={userId} />
              </Section>

              <ProfileDialogAchievements workspaceId={workspaceId} userId={userId} />

              <NoteEditor userId={userId} textareaRef={noteRef} />
            </div>
          </div>
          <DialogP.Close
            aria-label={t('common.close')}
            className={cx(CLOSE_HIT, 'absolute right-3 top-3 grid size-7 place-items-center rounded-full bg-scrim text-white transition-[filter] duration-[var(--motion-fast)] hover:brightness-125')}
          >
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </DialogP.Close>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/**
 * «Изменить день рождения» (docs/09 #77) under the date line, for who may set it
 * (canEditMemberBirthday: MANAGE_NICKNAMES + hierarchy); a boolean selector, so presence or voice
 * changes of the workspace do not re-render it.
 */
function EditBirthday({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const allowed = useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    const m = e?.members[userId];
    return !!m && canEditMemberBirthday(rolesOf(e, me), rolesOf(e, userId), m, userId === me);
  });
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  return (
    <>
      <button
        type="button"
        data-testid="profile-edit-birthday"
        className="mt-1 flex items-center gap-1.5 rounded-[var(--radius-control)] text-caption text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg"
        onClick={() => setOpen(true)}
      >
        <Cake className="size-3.5" aria-hidden />
        {t('birthday.edit')}
      </button>
      {open ? <MemberBirthdayDialog workspaceId={workspaceId} userId={userId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }): ReactNode {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 flex items-center justify-between gap-2 text-caption font-semibold text-muted">
        <span>{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** «…»: the member menu (the same one as a right click), opened under the button. */
function MoreButton({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  return (
    <MemberContextMenu workspaceId={workspaceId} userId={userId} inProfile>
      <button
        type="button"
        aria-label={t('people.profile.more')}
        aria-haspopup="menu"
        data-testid="profile-more"
        className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-fg transition-[filter] duration-[var(--motion-fast)] hover:brightness-125"
        onClick={(e) => {
          // Radix opens a context menu at the pointer: a synthetic contextmenu under the button.
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
        }}
      >
        <Ellipsis className="size-4" aria-hidden />
      </button>
    </MemberContextMenu>
  );
}

/**
 * «Роли» (ADR-0026): the member's roles as chips, highest first — the built-in one (owner /
 * admin / member / guest; «Участник» is left out next to owner / admin) and every custom role
 * with its colour dot. × and «+» by the same rules as the menu's «Роли ›» (memberActions.roles);
 * «+» opens the picker with the roles I may give (and «Участник» for a guest: «Сделать
 * участником»). The server re-checks; MEMBER_UPDATE updates the chips.
 */
function RoleChips({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const a = useMemberActions(workspaceId, userId);
  const roles = useMemberRoles(workspaceId, userId);
  const [adding, setAdding] = useState(false);
  const full = roles.some((r) => r.builtin === WorkspaceRole.OWNER || r.builtin === WorkspaceRole.ADMIN);
  const shown = roles.filter((r) => !(full && r.builtin === WorkspaceRole.MEMBER));
  const toggles = new Map((a?.roles ?? []).map((x) => [x.role.id, x]));
  const items: RolePickItem[] = (a?.roles ?? [])
    .filter((x) => x.enabled && !x.on)
    .map((x) => ({ kind: 'role', id: x.role.id, roleId: x.role.id, role: x.role.builtin, color: x.role.color, label: roleName(x.role), note: '', search: [roleName(x.role)] }));
  if (a?.promote) {
    items.push({ kind: 'role', id: 'promote', roleId: '', role: WorkspaceRole.MEMBER, color: 0, label: t('role.member'), note: t('people.menu.promote'), search: [t('role.member')] });
  }
  const pick = (item: PeoplePickItem): void => {
    setAdding(false);
    if (item.kind !== 'role') return;
    if (item.id === 'promote') {
      promoteGuest(workspaceId, userId);
      return;
    }
    const x = toggles.get(item.roleId);
    if (x) void toggleMemberRole(workspaceId, userId, x.role, true);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((r) => {
        const label = roleName(r);
        const removable = toggles.get(r.id)?.enabled === true;
        return (
          <span key={r.id} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line pl-2.5 pr-2.5 text-caption" data-testid="role-chip">
            <span className={cx('size-2.5 shrink-0 rounded-full', roleDot(r.builtin))} style={r.builtin === WorkspaceRole.UNSPECIFIED && r.color ? { background: roleColorCss(r.color) } : undefined} aria-hidden />
            <span className="min-w-0 truncate">{label}</span>
            {removable ? (
              <button
                type="button"
                aria-label={t('people.profile.removeRole', { role: label })}
                className={cx(CLOSE_HIT, '-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg')}
                onClick={() => void toggleMemberRole(workspaceId, userId, r, false)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </span>
        );
      })}
      {items.length > 0 ? (
        <MemberPicker
          open={adding}
          onOpenChange={setAdding}
          groups={[{ id: 'roles', label: '', items }]}
          onSelect={pick}
          placeholder={t('roles.search')}
          label={t('people.profile.addRole')}
          testId="role-picker"
          width={260}
          align="start"
        >
          <button
            type="button"
            aria-label={t('people.profile.addRole')}
            className="grid size-7 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </MemberPicker>
      ) : null}
    </div>
  );
}

const SAVE_LABEL: Partial<Record<NoteSaveState, MessageKey>> = {
  saving: 'people.profile.noteSaving',
  saved: 'people.profile.noteSaved',
  error: 'people.profile.noteFailed',
};

/**
 * «Заметка (видна только вам)»: an inline, auto-growing field; saved 800 ms after the last
 * keystroke and at once on blur / close (noteSaver.ts). Loaded per open (no gateway event: only
 * the author ever sees it).
 */
function NoteEditor({ userId, textareaRef }: { userId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['user-note', userId], queryFn: ({ signal }) => api.users.note(userId, signal), staleTime: 0 });
  const loaded = q.data ? (q.data.note?.text ?? '') : null;
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<NoteSaveState>('idle');
  const saver = useRef<NoteSaver | null>(null);
  if (loaded !== null && text === null) setText(loaded);
  useEffect(() => {
    if (loaded === null || saver.current) return;
    saver.current = createNoteSaver({
      initial: loaded,
      save: async (value) => {
        const r = await api.users.setNote(userId, value);
        qc.setQueryData(['user-note', userId], r);
        return r.note?.text ?? '';
      },
      onState: setState,
    });
  }, [loaded, userId, qc]);
  // Closing the dialog keeps the last keystrokes.
  useEffect(
    () => () => {
      void saver.current?.flush();
      saver.current?.dispose();
    },
    [],
  );
  // Auto-grow: the field is as tall as its text.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, textareaRef]);
  const status = SAVE_LABEL[state];
  return (
    <Section
      title={t('people.profile.note')}
      aside={
        status ? (
          <span className={cx('font-normal', state === 'error' ? 'text-danger-text' : 'text-faint')} role="status" data-testid="note-status">
            {t(status)}
          </span>
        ) : null
      }
    >
      <textarea
        ref={textareaRef}
        data-testid="profile-note"
        aria-label={t('people.profile.note')}
        rows={1}
        maxLength={NOTE_MAX}
        readOnly={text === null}
        aria-busy={text === null || undefined}
        value={text ?? ''}
        placeholder={t('people.profile.notePlaceholder')}
        className="selectable -ml-1.5 block w-[calc(100%+6px)] resize-none rounded-[6px] bg-transparent px-1.5 py-1 text-body leading-5 text-fg outline-none transition-colors duration-[var(--motion-fast)] placeholder:italic placeholder:text-faint hover:bg-hover focus:bg-hover"
        onChange={(e) => {
          setText(e.target.value);
          saver.current?.change(e.target.value);
        }}
        onBlur={() => void saver.current?.flush()}
      />
    </Section>
  );
}

import type { Achievement } from '@calaba/protocol';
import { Search } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Input, MOD, Modal, Spinner, Switch, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { invalidateMemberAchievements, useAchievementCatalog } from '../../lib/achievementCatalog';
import { NOTE_MAX, grantable, gridStep, noteValid } from '../../lib/achievements';
import { greetingRoomId, useRooms } from '../../stores/rooms';
import { useToasts } from '../../stores/toasts';
import { useMemberName } from '../../stores/workspaces';
import { AchievementImg } from './AchievementImg';
import { openGrantInChat } from './AchievementView';

/** «Вручить» is enabled: an achievement chosen, «за что» 1..120 after trimming, not sending. */
export const canGrant = (achievementId: string, note: string, busy: boolean): boolean => !!achievementId && noteValid(note) && !busy;

/**
 * «Вручить ачивку — Имя» (ADR-0061 §5, docs/08 «Ачивки»): a 440 px dialog — search by title, a
 * grid of 88 px tiles (picture 64 + title in two lines; the chosen one has the accent ring), the
 * required «За что» (1..120 with a counter), «Рассказать в общем чате → #room» (on by default;
 * hidden with a note when the workspace has no text room) and «Вручить». Keys: ↑↓←→ move over
 * the grid, ⌘↩ grants. After it — a toast «Ачивка вручена» with «Открыть в чате» when a card was
 * posted. Opened from the member menu and the profile (MANAGE_MEMBERS, not self / guest / bot;
 * the server re-checks).
 */
export function GrantAchievementDialog({ workspaceId, userId, initial, onClose }: { workspaceId: string; userId: string; initial?: string; onClose: () => void }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const catalog = useAchievementCatalog();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(initial ?? '');
  const [note, setNote] = useState('');
  const [announce, setAnnounce] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomId = useRooms((s) => greetingRoomId(s.byId, s.categories, workspaceId) ?? '');
  const roomName = useRooms((s) => (roomId ? (s.byId[roomId]?.name ?? '') : ''));
  const items = useMemo(() => (catalog ? grantable(catalog, query) : []), [catalog, query]);
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const ok = canGrant(picked, note, busy);

  const submit = async (): Promise<void> => {
    if (!canGrant(picked, note, busy)) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api.achievements.grant(workspaceId, userId, { achievementId: picked, note: note.trim(), announce: announce && !!roomId });
      invalidateMemberAchievements(workspaceId, userId);
      const action = g.messageId && g.roomId ? { label: t('ach.view.openChat'), run: () => openGrantInChat(workspaceId, g) } : undefined;
      useToasts.getState().push('success', t('ach.grant.done'), action);
      onClose();
    } catch (e) {
      setError(errorText(e, t('ach.grant.failed')));
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const cols = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').filter(Boolean).length || 1 : 4;
    const at = items.findIndex((a) => a.id === picked);
    const next = items[gridStep(at, e.key, items.length, cols)];
    if (!next) return;
    setPicked(next.id);
    grid.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
  };

  const pick = useCallback((id: string) => setPicked(id), []);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('ach.grant.title', { name })}
      initialFocus={search}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <GrantSubmit enabled={ok} busy={busy} onClick={() => void submit()} />
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={onKey} data-testid="grant-achievement">
        <Input ref={search} type="search" icon={<Search className="size-3.5" aria-hidden />} placeholder={t('ach.grant.search')} aria-label={t('ach.grant.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {!catalog ? (
          <Spinner className="mx-auto my-6" />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-body text-muted">{query ? t('ach.grant.none') : t('ach.grant.emptyCatalog')}</p>
        ) : (
          <div
            ref={grid}
            role="listbox"
            aria-label={t('ach.grant.pick')}
            onKeyDown={onGridKey}
            className="grid max-h-[260px] grid-cols-[repeat(auto-fill,88px)] justify-between gap-2 overflow-y-auto p-0.5"
          >
            {items.map((a, i) => (
              <Tile key={a.id} a={a} selected={a.id === picked} tabbable={a.id === picked || (!picked && i === 0)} onPick={pick} />
            ))}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="flex items-center justify-between text-caption font-medium text-muted">
            <span>{t('ach.grant.note')}</span>
            <span className={cx('tabular-nums', note.trim().length > NOTE_MAX ? 'text-danger-text' : 'text-faint')} aria-hidden>
              {note.trim().length}/{NOTE_MAX}
            </span>
          </span>
          <Input
            data-testid="grant-note"
            required
            maxLength={NOTE_MAX}
            placeholder={t('ach.grant.notePh')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {roomId ? (
          <Switch checked={announce} onChange={setAnnounce} label={t('ach.grant.announce', { room: roomName })} />
        ) : (
          <p className="text-caption text-muted" data-testid="grant-no-room">
            {t('ach.grant.noRoom')}
          </p>
        )}
        {error ? (
          <p role="alert" className="text-caption text-danger-text">
            {error}
          </p>
        ) : (
          <p className="text-caption text-faint">{t('ach.grant.keys', { mod: MOD })}</p>
        )}
      </div>
    </Modal>
  );
}

/** The primary action: disabled until an achievement is chosen and «за что» is filled. */
export function GrantSubmit({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: () => void }): ReactNode {
  return (
    <Button disabled={!enabled} busy={busy} onClick={onClick} data-testid="grant-submit">
      {t('ach.grant.submit')}
    </Button>
  );
}

const Tile = memo(function Tile({ a, selected, tabbable, onPick }: { a: Achievement; selected: boolean; tabbable: boolean; onPick: (id: string) => void }): ReactNode {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-id={a.id}
      tabIndex={tabbable ? 0 : -1}
      title={a.description || a.title}
      onClick={() => onPick(a.id)}
      className={cx(
        'flex h-[112px] w-[88px] flex-col items-center gap-1 rounded-[var(--radius-card)] px-1 pt-2 text-center transition-colors duration-[var(--motion-fast)]',
        selected ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] ring-2 ring-accent' : 'hover:bg-hover',
      )}
    >
      <AchievementImg achievement={a} size={64} />
      <span className="line-clamp-2 text-caption leading-[14px]">{a.title}</span>
    </button>
  );
});

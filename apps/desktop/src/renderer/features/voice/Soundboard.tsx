import type { Sound } from '@calaba/protocol';
import * as Popover from '@radix-ui/react-popover';
import { Music, Play, Search, Settings, Star } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { IconButton, Input, Tip, cx } from '../../components/ui';
import { t, useLocale, type MessageKey } from '../../i18n';
import { builtinBoard, builtinSound } from '../../lib/builtinSounds';
import { autoFocusAllowed } from '../../lib/phone';
import { boardSections, isBuiltin, type BoardSound, type SectionId } from '../../lib/soundboard';
import { pressSound, previewSound, toggleFavorite } from '../../services/soundboard';
import { usePrefs } from '../../stores/prefs';
import { useSounds, useWorkspaceSounds } from '../../stores/sounds';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useMemberName } from '../../stores/workspaces';

/*
 * Soundboard (ADR-0036 §3, docs/08 «Саундборд»; Discord's soundboard): the «Звуки» button in the
 * voice island (and in the phone's call strip), a popover — a centred card on a phone — with
 * search and the sections «Избранное», «Часто используемые», «Звуки пространства», «Стандартные»;
 * tiles of emoji + name, two a row. A click plays to everyone in the call (then every tile locks
 * for 2 s), ▶ on a tile plays it only for me, ☆ stars it. The chip «🥁 Ba dum tss · Илья» under
 * the island's header shows who pressed what for 2 s.
 */

const SECTION_TITLE: Record<SectionId, MessageKey> = {
  favorites: 'snd.favorites',
  frequent: 'snd.frequent',
  workspace: 'snd.workspace',
  builtin: 'snd.builtin',
  results: 'snd.results',
};

/** The island / strip trigger: `className` is the host's button style. */
export function SoundboardButton({ className, testId = 'soundboard-button' }: { className: string; testId?: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const connected = useVoice((s) => s.phase === 'connected');
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={t('snd.button')}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={t('snd.button')} data-testid={testId} disabled={!connected} className={className}>
            <Music className="size-5" aria-hidden />
          </button>
        </Popover.Trigger>
      </Tip>
      <SoundboardContent onClose={() => setOpen(false)} />
    </Popover.Root>
  );
}

/**
 * The same panel opened from elsewhere (the phone strip's «Ещё» in push-to-talk mode, where the
 * strip has no room for one more button): anchored to `children`.
 */
export function SoundboardAnchored({ open, onOpenChange, children }: { open: boolean; onOpenChange: (v: boolean) => void; children: ReactNode }): ReactNode {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <SoundboardContent onClose={() => onOpenChange(false)} />
    </Popover.Root>
  );
}

function SoundboardContent({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Popover.Portal>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        aria-label={t('snd.title')}
        data-testid="soundboard"
        // A phone focuses a field only by a tap (docs/08 «Мобильный веб»): no keyboard on open.
        onOpenAutoFocus={(e) => (autoFocusAllowed() ? undefined : e.preventDefault())}
        className="mat-popover dense anim-in z-[var(--z-popover)] flex h-[min(440px,var(--radix-popover-content-available-height))] w-[360px] flex-col overflow-hidden rounded-[var(--radius-panel)] mobile:h-[min(70dvh,520px)]"
      >
        <SoundboardPanel onSettings={onClose} />
      </Popover.Content>
    </Popover.Portal>
  );
}

const toBoard = (s: Sound): BoardSound => ({ id: s.id, emoji: s.emoji || '🔊', name: s.name, fileId: s.fileId, durationMs: s.durationMs });

/** Search + sections; mounted only while the popover is open. */
function SoundboardPanel({ onSettings }: { onSettings: () => void }): ReactNode {
  const locale = useLocale();
  const wsId = useVoice((s) => s.workspaceId);
  const wsSounds = useWorkspaceSounds(wsId);
  const favorites = usePrefs((s) => s.soundboardFavorites);
  const usage = usePrefs((s) => s.soundboardUsage);
  const openDialog = useUi((s) => s.openDialog);
  const [query, setQuery] = useState('');
  const workspace = useMemo(() => wsSounds.map(toBoard), [wsSounds]);
  const sections = useMemo(
    () => boardSections({ builtin: builtinBoard(locale), workspace, favorites, usage, query }),
    [locale, workspace, favorites, usage, query],
  );
  const fav = useMemo(() => new Set(favorites), [favorites]);
  const cooldown = useSounds((s) => s.cooldown);
  const locked = cooldown !== null;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Input
          aria-label={t('snd.search')}
          placeholder={t('snd.search')}
          icon={<Search className="size-3.5" />}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          data-testid="soundboard-search"
          className="rounded-full"
        />
        <IconButton
          label={t('snd.settings')}
          onClick={() => {
            onSettings();
            openDialog({ kind: 'settings', tab: 'voice' });
          }}
        >
          <Settings className="size-4" aria-hidden />
        </IconButton>
      </div>
      {/* The 2 s lock after a press: a hairline that runs out (a finite transition, none with reduced motion). */}
      <div className="h-0.5 shrink-0 overflow-hidden" aria-hidden>
        {cooldown ? <div key={cooldown.until} className="snd-cooldown h-full bg-accent" style={{ animationDuration: `${cooldown.ms}ms` }} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" role="group" aria-busy={locked ? true : undefined} data-testid="soundboard-sections">
        {sections.length === 0 ? <p className="py-6 text-center text-caption text-muted">{t('snd.none')}</p> : null}
        {sections.map((sec) => (
          <section key={sec.id} aria-label={t(SECTION_TITLE[sec.id])}>
            <h3 className="pb-1.5 pt-3 text-micro font-semibold uppercase tracking-wide text-muted">{t(SECTION_TITLE[sec.id])}</h3>
            {/* Phone: one column — ▶ and ☆ are 44 px targets there, two columns left the name ~40 px
                and the ▶ was drawn over it. */}
            <div className="grid grid-cols-2 gap-1.5 mobile:grid-cols-1">
              {sec.sounds.map((s) => (
                <SoundTile key={s.id} sound={s} favorite={fav.has(s.id)} locked={locked} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

/** One sound: the tile plays it to the call; ▶ (hover / focus) plays it only for me; ☆ stars it. */
const SoundTile = memo(function SoundTile({ sound, favorite, locked }: { sound: BoardSound; favorite: boolean; locked: boolean }): ReactNode {
  return (
    <div className="group relative" data-testid="sound-tile">
      <button
        type="button"
        aria-disabled={locked || undefined}
        onClick={locked ? undefined : () => void pressSound(sound.id)}
        title={sound.name}
        className={cx(
          'flex h-10 w-full min-w-0 items-center gap-2 rounded-[var(--radius-card)] bg-[var(--color-fill)] pl-2.5 text-left text-body text-fg transition-colors duration-[var(--motion-fast)] group-focus-within:pr-14 group-hover:pr-14 mobile:pr-24',
          // The name keeps the width the ▶ / ☆ buttons do not need: they show on hover (a starred one keeps its ★).
          favorite ? 'pr-8' : 'pr-2.5',
          locked ? 'cursor-default opacity-50' : 'hover:bg-[var(--color-fill-hover)] active:bg-[var(--color-fill-hover)]',
        )}
      >
        <span className="text-[18px] leading-none" aria-hidden>
          {sound.emoji}
        </span>
        <span className="min-w-0 flex-1 truncate">{sound.name}</span>
      </button>
      <span className="absolute inset-y-0 right-1 flex items-center gap-0.5">
        <button
          type="button"
          aria-label={t('snd.preview', { name: sound.name })}
          onClick={() => previewSound(sound.id)}
          className="grid size-6 place-items-center rounded-full text-muted opacity-0 mobile:size-11 transition-opacity duration-[var(--motion-fast)] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 mobile:opacity-100"
        >
          <Play className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={favorite ? t('snd.unfavorite', { name: sound.name }) : t('snd.favorite', { name: sound.name })}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(sound.id)}
          className={cx(
            'grid size-6 place-items-center rounded-full transition-opacity mobile:size-11 duration-[var(--motion-fast)] hover:bg-hover focus-visible:opacity-100',
            favorite ? 'text-warn' : 'text-muted opacity-0 hover:text-fg group-hover:opacity-100 mobile:opacity-100',
          )}
        >
          <Star className="size-3.5" fill={favorite ? 'currentColor' : 'none'} aria-hidden />
        </button>
      </span>
    </div>
  );
});

/** «🥁 Ba dum tss · Илья» for 2 s after a sound played in my call (a leaf: the island does not re-render). */
export function SoundChip({ className }: { className?: string }): ReactNode {
  const chip = useSounds((s) => s.chip);
  const locale = useLocale();
  const who = useMemberName(chip?.workspaceId ?? null, chip?.userId ?? '');
  const ws = useSounds((s) => (chip && !isBuiltin(chip.soundId) ? s.byWs[chip.workspaceId]?.find((x) => x.id === chip.soundId) : undefined));
  if (!chip) return null;
  const b = isBuiltin(chip.soundId) ? builtinSound(chip.soundId) : undefined;
  const emoji = b?.emoji ?? (ws?.emoji || '🔊');
  const name = b ? (b.names[locale] ?? b.names.en ?? '') : (ws?.name ?? '');
  if (!name) return null;
  return (
    <div className={cx('flex min-w-0', className)} role="status" data-testid="sound-chip">
      <span className="anim-in inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[var(--color-fill)] px-2.5 text-caption text-fg">
        <span aria-hidden>{emoji}</span>
        <span className="min-w-0 truncate">
          {name} · <span className="text-muted">{who}</span>
        </span>
      </span>
    </div>
  );
}

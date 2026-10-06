import * as DialogP from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight, Lock, Search } from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { MOBILE_QUERY } from '../lib/phone';
import { useMediaQuery } from '../lib/useMediaQuery';
import { getSettingsQuery, setSettingsQuery } from '../lib/settingsQuery';
import { openSettingsSection } from '../lib/phoneNav';
import { useUi } from '../stores/ui';
import { PhoneHeader } from './PhoneHeader';
import { highlight, hintExcerpt, labelMatches, queryWords, searchSettings, type SettingsEntry } from './settingsSearch';
import { CloseButton, IconButton, cx } from './ui';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
  /** Red label (e.g. «Удалить пространство»). */
  destructive?: boolean;
  /** Feature is unavailable on the current plan; the section explains access. */
  locked?: boolean;
  /** A small accent pill after the label (e.g. «Обновление» on «О программе», docs/09 #125). */
  badge?: string;
  /** Extra words the search matches the section by (e.g. «обновление» for «О программе»). */
  keywords?: string;
}

/**
 * A section's name in the list / search results; with a badge, its accent pill goes under the
 * name (the phone's pill row keeps it beside). White on the selected (accent) row.
 */
function SectionLabel({ label, badge }: { label: string; badge: string | undefined }): ReactNode {
  if (!badge) return <span className="min-w-0 truncate">{label}</span>;
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5 mobile:flex-row mobile:items-center mobile:gap-1.5">
      <span className="min-w-0 max-w-full truncate">{label}</span>
      <span
        className="shrink-0 rounded-full bg-accent-strong px-1.5 text-[10px] font-semibold leading-4 text-accent-fg group-data-[state=active]:bg-white group-data-[state=active]:text-[var(--color-accent-strong)]"
        data-testid="settings-section-badge"
      >
        {badge}
      </span>
    </span>
  );
}

/**
 * Set by the phone's settings screen (features/shell/SettingsScreen.tsx): the window renders as a
 * screen of the phone stack (ADR-0073, owner 07.10) — no sheet; `section` null = the list.
 */
const SettingsPage = createContext<{ section: string | null } | null>(null);
export const SettingsPageProvider = SettingsPage.Provider;

/** Opens another section of the enclosing settings window (a cross-link between sections). */
const SettingsNav = createContext<((section: string) => void) | null>(null);

/** Null outside a SettingsWindow (e.g. onboarding): render no cross-link then. */
export function useSettingsNav(): ((section: string) => void) | null {
  return useContext(SettingsNav);
}

/**
 * Collects the searchable labels of every mounted section: elements marked with
 * `data-settings-label` (components/ui.tsx Row, Card titles, custom rows), optionally with
 * `data-settings-hint`. Index-based keys stay valid while the panels stay mounted.
 */
function harvest(root: HTMLElement, sections: SettingsSection[]): SettingsEntry[] {
  const out: SettingsEntry[] = [];
  for (const s of sections) {
    const panel = root.querySelector<HTMLElement>(`[data-settings-panel="${CSS.escape(s.id)}"]`);
    if (!panel) continue;
    panel.querySelectorAll<HTMLElement>('[data-settings-label]').forEach((el, n) => {
      out.push({ key: `${s.id}:${n}`, section: s.id, label: el.textContent.trim(), hint: el.dataset['settingsHint'] });
    });
  }
  return out;
}

/** Text with the matching parts in semibold: shows why a search result matched. */
function Marked({ text, words }: { text: string; words: string[] }): ReactNode {
  return highlight(text, words).map((p, i) =>
    p.hit ? (
      <strong key={i} className="font-semibold text-fg">
        {p.text}
      </strong>
    ) : (
      p.text
    ),
  );
}

/** Below this many sections a search field is more than the window needs (room settings). */
const SEARCH_MIN_SECTIONS = 5;

const sameEntries = (a: SettingsEntry[], b: SettingsEntry[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Arrow keys between the buttons of a list (search results). */
function arrowNav(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[e.key === 'ArrowDown' ? i + 1 : i - 1];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/**
 * System-Settings-like window (docs/08 «UX-правила», docs/09 #18): 920×640 (shrinks with the
 * window), a search field and the list of sections with icons on the left, the selected
 * section on the right as card groups («label left — control right»). Esc closes (or clears
 * the search first). While searching, every section is mounted (hidden) so its row labels can
 * be matched; picking a result opens the section and highlights the row.
 */
export function SettingsWindow({
  title,
  sections,
  initial,
  onClose,
  footer,
  titleIcon,
  fallback,
}: {
  title: string;
  /** Glyph before the title (room: # / speaker; workspace: its initials). */
  titleIcon?: ReactNode;
  sections: SettingsSection[];
  /** Section opened first; on the phone it is opened straight away (no list). */
  initial?: string | undefined;
  /** Section the desktop starts on when `initial` is absent; the phone starts on the list instead. */
  fallback?: string | undefined;
  onClose: () => void;
  /** Extra items under the section list (e.g. «Выйти»). */
  footer?: ReactNode;
}): ReactNode {
  // The phone layout's media query (lib/mobile.ts useMobile minus its platform check, which would pull the
  // platform into this module: Electron's window is ≥ 960 px, the query never matches there).
  const phone = useMediaQuery(MOBILE_QUERY);
  const page = useContext(SettingsPage);
  const wanted = initial ?? fallback;
  const [value, setValue] = useState(wanted && sections.some((s) => s.id === wanted) ? wanted : (sections[0]?.id ?? ''));
  // Phone: the root is the list of sections (iOS Settings), a tap opens one full-screen with «← Title».
  const [view, setView] = useState<'list' | 'section'>(initial && sections.some((s) => s.id === initial) ? 'section' : 'list');
  // On the phone the list and a section are different screens: the search text outlives the hop.
  const [query, setQueryState] = useState(page ? getSettingsQuery() : '');
  const setQuery = (q: string): void => {
    setQueryState(q);
    if (page) setSettingsQuery(q);
  };
  const [entries, setEntries] = useState<SettingsEntry[]>([]);
  const [hit, setHit] = useState<string | null>(null);
  const panels = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLElement>(null);
  const searching = query.trim() !== '';
  const words = useMemo(() => queryWords(query), [query]);
  const searchable = sections.length >= SEARCH_MIN_SECTIONS;

  // Harvest labels while searching; sections render asynchronously (queries), so watch the DOM.
  useLayoutEffect(() => {
    const root = panels.current;
    if (!searching || !root) return;
    const update = (): void => setEntries((prev) => {
      const next = harvest(root, sections);
      return sameEntries(prev, next) ? prev : next;
    });
    update();
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [searching, sections]);

  const groups = useMemo(() => (searching ? searchSettings(sections, entries, query) : []), [searching, sections, entries, query]);

  // Live preview: while the selected section has no matches, the right pane shows the first
  // matching one (System Settings does the same); picking a result makes it the selection.
  const firstSection = groups[0]?.section;
  const tab = page ? (page.section ?? value) : searching && firstSection && !groups.some((g) => g.section === value) ? firstSection : value;
  const current = sections.find((s) => s.id === tab);

  // The highlighted row (data-settings-hit): scrolled into view after its section is shown.
  useEffect(() => {
    const root = panels.current;
    if (!root) return;
    root.querySelectorAll('[data-settings-hit]').forEach((el) => el.removeAttribute('data-settings-hit'));
    if (!hit || !searching) return;
    const [section, n] = hit.split(':');
    const panel = root.querySelector<HTMLElement>(`[data-settings-panel="${CSS.escape(section ?? '')}"]`);
    const label = panel?.querySelectorAll<HTMLElement>('[data-settings-label]')[Number(n)];
    const row = label?.closest<HTMLElement>('[data-settings-row]') ?? label;
    if (!row) return;
    row.setAttribute('data-settings-hit', 'true');
    row.scrollIntoView({ block: 'nearest' });
  }, [hit, searching, tab]);

  const openSection = (id: string): void => {
    if (page) {
      useUi.getState().setPhone((n) => openSettingsSection(n, id));
      return;
    }
    setValue(id);
    setHit(null);
    setView('section');
  };
  const goTo = (id: string): void => {
    setQuery('');
    openSection(id);
  };
  const jump = (e: SettingsEntry): void => {
    if (page) {
      openSection(e.section);
      return;
    }
    setValue(e.section);
    setHit(e.key);
    setView('section');
  };
  const first = (): void => {
    const g = groups[0];
    if (!g) return;
    const row = g.rows[0];
    if (row) jump(row);
    else openSection(g.section);
  };

  // The window's three parts, shared by the dialog (desktop) and the phone's screen.
  const searchField = searchable ? (
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2 size-3.5 text-muted mobile:left-3 mobile:size-4" aria-hidden />
        <input
          type="search"
          role="searchbox"
          aria-label={t('settings.search')}
          placeholder={t('common.search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              first();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              results.current?.querySelector<HTMLElement>('button')?.focus();
            }
          }}
          className="selectable h-7 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev pl-7 pr-2 text-body mobile:h-11 mobile:pl-9 mobile:text-[16px] text-fg shadow-[var(--shadow-card)] placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
  ) : null;
  const listPart = (
    <>
      {searching ? (
        <nav ref={results} aria-label={t('settings.searchResults')} className="-m-1 flex min-h-0 flex-col gap-px overflow-y-auto p-1 mobile:m-0 mobile:overflow-visible mobile:p-0" onKeyDown={arrowNav}>
          {groups.length === 0 ? <p className="px-2 py-2 text-body text-muted">{t('settings.searchNone')}</p> : null}
          {groups.map((g) => {
            const s = sections.find((x) => x.id === g.section);
            if (!s) return null;
            return (
              <div key={g.section} className="flex flex-col gap-px">
                <button
                  type="button"
                  onClick={() => openSection(s.id)}
                  aria-current={tab === s.id && !hit ? 'true' : undefined}
                  className={cx(
                    'flex items-center gap-2.5 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover mobile:min-h-11',
                    s.badge ? 'min-h-8 py-1' : 'h-8',
                    tab === s.id && !hit ? 'bg-active' : '',
                    s.destructive ? 'text-danger-text' : 'text-fg',
                  )}
                >
                  <s.icon className="size-4 shrink-0" aria-hidden />
                  <SectionLabel label={s.label} badge={s.badge} />
                  {s.locked ? <Lock className="ml-auto size-3.5 shrink-0" aria-label={t('identity.plan')} /> : null}
                </button>
                {g.rows.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => jump(r)}
                    aria-current={hit === r.key ? 'true' : undefined}
                    title={r.hint ? `${r.label}\n${r.hint}` : r.label}
                    className={cx(
                      'flex min-h-7 flex-col justify-center rounded-[var(--radius-row)] py-1 pl-[34px] pr-2 text-left text-body text-muted hover:bg-hover hover:text-fg mobile:min-h-11',
                      hit === r.key ? 'bg-active text-fg' : '',
                    )}
                  >
                    <span className="min-w-0 truncate">
                      <Marked text={r.label} words={words} />
                    </span>
                    {/* Found by its description: show the matching words from it. */}
                    {r.hint && !labelMatches(r.label, words) ? (
                      <span className="min-w-0 truncate text-caption text-muted">
                        <Marked text={hintExcerpt(r.hint, words)} words={words} />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
      ) : (
        <Tabs.List aria-label={title} className="-m-1 flex min-h-0 flex-col gap-px overflow-y-auto p-1 mobile:m-0 mobile:shrink-0 mobile:gap-0 mobile:divide-y mobile:divide-[var(--color-card-line)] mobile:overflow-hidden mobile:rounded-[var(--radius-card)] mobile:bg-[var(--color-card)] mobile:p-0">
          {sections.map((s) => (
            <Tabs.Trigger
              key={s.id}
              value={s.id}
              // Phone: a 52 px row of the list (the active state is the opened section, not shown).
              onClick={() => (page ? openSection(s.id) : setView('section'))}
              // On the phone the list is navigation: its section is a screen of its own, nothing to control here.
              {...(page ? { 'aria-controls': undefined } : {})}
              className={cx(
                'group flex shrink-0 items-center gap-2.5 rounded-[var(--radius-row)] px-2 text-left text-body mobile:h-[52px] mobile:w-full mobile:gap-3 mobile:rounded-none mobile:px-4 mobile:text-[16px]',
                // A badged row takes a second line for its pill: the 200 px column has no room beside the label.
                s.badge ? 'min-h-8 py-1 mobile:py-0' : 'h-8',
                'hover:bg-hover data-[state=active]:bg-accent-strong data-[state=active]:text-accent-fg data-[state=active]:hover:bg-accent-strong mobile:data-[state=active]:bg-transparent mobile:data-[state=active]:text-fg mobile:data-[state=active]:hover:bg-hover',
                s.destructive ? 'text-danger-text' : 'text-fg',
              )}
            >
              <s.icon className="size-4 shrink-0 mobile:size-5" aria-hidden />
              <SectionLabel label={s.label} badge={s.badge} />
              {s.locked ? <Lock className="ml-auto size-3.5 shrink-0" aria-label={t('identity.plan')} /> : null}
              <ChevronRight className={cx('hidden size-4 shrink-0 text-faint mobile:block', s.locked ? 'ml-2' : 'ml-auto')} aria-hidden />
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      )}
    </>
  );
  const footerPart = footer ? (
        <div className="mt-auto flex flex-col gap-px border-t border-line pt-2 mobile:mt-0 mobile:shrink-0 mobile:gap-0 mobile:divide-y mobile:divide-[var(--color-card-line)] mobile:overflow-hidden mobile:rounded-[var(--radius-card)] mobile:border-t-0 mobile:bg-[var(--color-card)] mobile:pt-0">
          {footer}
        </div>
  ) : null;
  const sectionPanels = (
    <>
      {sections.map((s) => (
        <Tabs.Content
          key={s.id}
          value={s.id}
          data-settings-panel={s.id}
          forceMount={searching ? true : undefined}
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5 focus-visible:-outline-offset-2 data-[state=inactive]:hidden mobile:px-4 mobile:pb-[calc(var(--safe-bottom)+20px)]"
        >
          <div className="mx-auto flex max-w-[640px] flex-col gap-6">
            <SettingsNav.Provider value={goTo}>{s.content}</SettingsNav.Provider>
          </div>
        </Tabs.Content>
      ))}
    </>
  );

  if (page) {
    const showList = !page.section;
    return (
      <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="settings-page" data-phone-view={showList ? 'list' : 'section'}>
        <PhoneHeader
          title={
            showList ? (
              <span className="flex min-w-0 items-center gap-2">
                {titleIcon}
                <span className="min-w-0 truncate">{title}</span>
              </span>
            ) : (
              current?.label
            )
          }
        />
        <Tabs.Root value={tab} orientation="vertical" className="flex min-h-0 flex-1 flex-col">
          {showList ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[var(--color-sheet-pane)] p-4 pb-[calc(var(--safe-bottom)+16px)] pt-3">
              {searchField}
              {listPart}
              {footerPart}
            </div>
          ) : null}
          {/* The list while searching keeps every section mounted (hidden): its row labels are what the search matches. */}
          {!showList || searching ? (
            <div ref={panels} className={cx('min-h-0 flex-1 flex-col bg-[var(--color-sheet-pane)]', showList ? 'hidden' : 'flex')}>
              {sectionPanels}
            </div>
          ) : null}
        </Tabs.Root>
      </section>
    );
  }

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Focus the window itself: no ring on a section opened with the mouse, and the
            // search field (first tabbable) is one Tab away.
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
          }}
          onEscapeKeyDown={(e) => {
            // A field that owns Esc (inline editors, data-own-escape) handles it itself: Radix
            // listens in the capture phase, before the field could stop the event.
            if (e.target instanceof Element && e.target.closest('[data-own-escape]')) {
              e.preventDefault();
              return;
            }
            // Esc clears the search first (macOS search fields), then closes the window.
            if (query) {
              e.preventDefault();
              setQuery('');
              setHit(null);
            }
          }}
          // Centred while the window is tall enough; in a short window (960×600) the sheet hangs
          // 46 px from the top — below the 38 px title bar, like a macOS sheet — and shrinks to
          // 100vh − 62 px (16 px bottom margin). Not centred then, hence data-layout-anchor.
          data-layout-anchor=""
          className="mat-sheet anim-in fixed left-1/2 top-[max(46px,calc(50vh-320px))] z-[var(--z-modal)] flex h-[min(640px,calc(100vh-62px))] w-[min(920px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-[var(--radius-panel)] focus:outline-none mobile:inset-x-0 mobile:bottom-[var(--kb-inset)] mobile:top-[calc(var(--safe-top)+8px)] mobile:h-auto mobile:w-full mobile:translate-x-0 mobile:rounded-b-none mobile:rounded-t-[16px] mobile:border-b-0"
          // Phone layout (ADR-0021): a full-height sheet; the section list becomes a row of pills on top.
        >
          <Tabs.Root value={tab} onValueChange={openSection} orientation="vertical" className="flex min-w-0 flex-1 mobile:flex-col">
            <div
              data-phone-view={view}
              className="mat-sheet-side flex w-[220px] shrink-0 flex-col gap-2 border-r border-line p-2 max-[1000px]:w-[200px] mobile:min-h-0 mobile:w-full mobile:flex-1 mobile:gap-3 mobile:overflow-y-auto mobile:border-r-0 mobile:bg-[var(--color-sheet-pane)] mobile:p-4 mobile:pb-[calc(var(--safe-bottom)+16px)] mobile:pt-1 mobile:data-[phone-view=section]:hidden"
            >
              <div className="flex items-center justify-between gap-2">
                <DialogP.Title className="flex min-w-0 items-center gap-2 px-2 pt-2 text-body font-semibold text-fg mobile:px-0 mobile:pt-0 mobile:text-headline">
                  {titleIcon}
                  <span className="min-w-0 truncate" title={title}>
                    {title}
                  </span>
                </DialogP.Title>
                {phone ? <CloseButton label={t('settings.close')} onClick={onClose} size="md" className="mobile:size-11" /> : null}
              </div>
              {searchField}
              {listPart}
              {footerPart}
            </div>
            {/* min-h-0: in the phone's column layout the pane must shrink so its section scrolls. */}
            <div data-phone-view={view} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-sheet-pane)] mobile:data-[phone-view=list]:hidden">
              <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3 mobile:h-14 mobile:pl-2">
                {phone ? (
                  <IconButton
                    label={t('onb.back')}
                    tip={false}
                    onClick={() => {
                      setHit(null);
                      setView('list');
                    }}
                    className="mobile:size-11"
                  >
                    <ChevronLeft className="size-6" aria-hidden />
                  </IconButton>
                ) : null}
                <h2 className="min-w-0 flex-1 truncate text-headline font-semibold mobile:pr-11 mobile:text-center">{current?.label}</h2>
                {phone ? null : <CloseButton label={t('settings.close')} onClick={onClose} />}
              </div>
              <div ref={panels} className="flex min-h-0 flex-1 flex-col">
                {sectionPanels}
              </div>
            </div>
          </Tabs.Root>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** Sidebar footer item (not a section), e.g. «Выйти». */
export function SettingsAction({ label, icon: Icon, onClick, destructive }: { label: string; icon: LucideIcon; onClick: () => void; destructive?: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex h-8 items-center gap-2.5 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover mobile:h-[52px] mobile:gap-3 mobile:rounded-none mobile:px-4 mobile:text-[16px]', destructive ? 'text-danger-text' : 'text-fg')}
    >
      <Icon className="size-4 shrink-0 mobile:size-5" aria-hidden />
      {label}
    </button>
  );
}

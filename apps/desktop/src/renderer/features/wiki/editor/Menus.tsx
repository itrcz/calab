/**
 * Floating UI of the wiki editor: the `/` and `@` suggestion popover, the selection bubble bar
 * (marks, highlight colour, link, «Превратить в») and the table bar. Each subscribes narrowly:
 * the popover to the MenuStore, the bars to `useEditorState` selectors returning primitives, so a
 * keystroke re-renders a bar only when what it shows changes. All are portalled to <body>.
 */
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Bold,
  Check,
  ChevronRight,
  Code,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image,
  Italic,
  Lightbulb,
  Link,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Rows3,
  SquareCode,
  Strikethrough,
  Table,
  Trash,
  Type,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../../../components/Avatar';
import { cx } from '../../../components/ui';
import { t } from '../../../i18n';
import type { MentionCandidate } from '../../../lib/mentions';
import { str } from '../../../lib/wiki/markdown';
import { BLOCKS, currentBlock, type BlockDef, type BlockId } from './blocks';
import type { EditorEnv } from './env';
import { isAllowedHref } from './extensions';
import type { MenuState } from './menuStore';
import { HIGHLIGHT_COLORS, type HighlightColor } from './nodes';

export const BLOCK_ICONS: Record<BlockId, LucideIcon> = {
  text: Type,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bullet: List,
  ordered: ListOrdered,
  task: ListTodo,
  quote: Quote,
  divider: Minus,
  code: SquareCode,
  table: Table,
  image: Image,
  callout: Lightbulb,
  toggle: ListCollapse,
};

const MENU_W = 280;
const GAP = 6;

/** Clamps a popover to the viewport (16 px gutter). */
function clampX(x: number, w: number): number {
  return Math.max(16, Math.min(x, window.innerWidth - w - 16));
}

// ---------------------------------------------------------------- suggestion popover

const SlashRow = memo(function SlashRow({ b, active, onPick, onHover, i }: { b: BlockDef; active: boolean; i: number; onPick: (i: number) => void; onHover: (i: number) => void }): ReactNode {
  const Icon = BLOCK_ICONS[b.id];
  return (
    <li
      role="option"
      aria-selected={active}
      ref={active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(i);
      }}
      onMouseMove={() => (active ? undefined : onHover(i))}
      className={cx('flex h-9 cursor-default items-center gap-2.5 rounded-[var(--radius-row)] px-2 text-body mobile:tap-min-h', active ? 'bg-active text-accent-text' : 'text-fg')}
    >
      <span className={cx('grid size-6 shrink-0 place-items-center rounded-[var(--radius-row)]', 'bg-hover')}>
        <Icon className="size-4" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{t(b.label)}</span>
      {b.hint ? <span className={cx('shrink-0 font-mono text-caption', active ? 'text-accent-text' : 'text-muted')}>{b.hint}</span> : null}
    </li>
  );
});

const MentionRow = memo(function MentionRow({ c, active, onPick, onHover, i }: { c: MentionCandidate; active: boolean; i: number; onPick: (i: number) => void; onHover: (i: number) => void }): ReactNode {
  return (
    <li
      role="option"
      aria-selected={active}
      ref={active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(i);
      }}
      onMouseMove={() => (active ? undefined : onHover(i))}
      className={cx('flex h-9 cursor-default items-center gap-2.5 rounded-[var(--radius-row)] px-2 text-body mobile:tap-min-h', active ? 'bg-active text-accent-text' : 'text-fg')}
    >
      <Avatar userId={c.id} name={c.name} size={24} />
      <span className="min-w-0 truncate font-medium">{c.name}</span>
      {c.nick ? <span className={cx('min-w-0 truncate', active ? 'text-accent-text' : 'text-muted')}>@{c.nick}</span> : null}
    </li>
  );
});

/**
 * `/` blocks and `@` people. On the phone (ADR-0096 §7) the block menu is a card in the middle of
 * the screen above the keyboard, with a backdrop that closes it; the `@` list hangs from the caret.
 */
export function SuggestionMenu({ env, phone = false }: { env: EditorEnv; phone?: boolean }): ReactNode {
  const s = useSyncExternalStore(env.menu.subscribe, env.menu.get);
  const pick = useCallback((i: number) => {
    const st = env.menu.get();
    const item = st?.items[i];
    if (st && item !== undefined) st.pick(item);
  }, [env]);
  const hover = useCallback((i: number) => {
    const st = env.menu.get();
    if (st) env.menu.set({ ...st, index: i });
  }, [env]);
  if (!s?.rect) return null;
  const below = s.rect.bottom + 320 < window.innerHeight;
  const style = below ? { left: clampX(s.rect.left, MENU_W), top: s.rect.bottom + GAP } : { left: clampX(s.rect.left, MENU_W), bottom: window.innerHeight - s.rect.top + GAP };
  const label = s.kind === 'slash' ? t('wiki.slash.title') : t('chat.mentionList');
  if (s.kind === 'mention' && !s.items.length) return null;
  const rows = s.items.length ? (
    <ul
      role="listbox"
      aria-label={label}
      className={cx(
        'overflow-y-auto p-1 pt-0',
        // Phone card: the list scrolls inside the card; the last 20 px fade out as the «more below» cue (padding keeps the end row clear).
        phone && s.kind === 'slash' ? 'min-h-0 flex-1 pb-5 [mask-image:linear-gradient(to_bottom,#000_calc(100%-20px),transparent)]' : 'max-h-[min(320px,40vh)]',
      )}
      {...(phone ? { tabIndex: 0, onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } : {})}
    >
      {s.kind === 'slash'
        ? (s as MenuState<BlockDef>).items.map((b, i) => <SlashRow key={b.id} b={b} i={i} active={i === s.index} onPick={pick} onHover={hover} />)
        : (s as MenuState<MentionCandidate>).items.map((c, i) => <MentionRow key={c.id} c={c} i={i} active={i === s.index} onPick={pick} onHover={hover} />)}
    </ul>
  ) : (
    <div className="px-3 pb-3 pt-1 text-body text-muted">{t('wiki.slash.empty')}</div>
  );
  if (phone && s.kind === 'slash') {
    return createPortal(
      <div
        className="fixed inset-x-0 top-0 bottom-[var(--kb-inset,0px)] z-[var(--z-popover)] box-border grid place-items-center px-4 pb-[calc(44px+var(--space-4))] pt-4"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            env.menu.set(null);
          }
        }}
        data-testid="wiki-block-menu-backdrop"
      >
        <div className="mat-popover anim-in flex max-h-[70%] w-[var(--phone-card-w,min(360px,calc(100vw-32px)))] flex-col overflow-hidden rounded-[var(--radius-card)] shadow-[var(--shadow-popover)]" data-testid="wiki-block-menu">
          <div className="px-3 pb-1 pt-2.5 text-micro font-semibold text-muted" aria-hidden>
            {label}
          </div>
          {rows}
        </div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div className="mat-popover anim-in fixed z-[var(--z-popover)] w-[280px] overflow-hidden rounded-[var(--radius-card)]" style={style}>
      <div className="px-3 pb-1 pt-2 text-micro font-semibold text-muted" aria-hidden>
        {label}
      </div>
      {rows}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- bubble bar

function BarButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx('grid size-7 place-items-center rounded-[var(--radius-icon)] mobile:tap-size', active ? 'bg-hover text-accent' : 'text-fg hover:bg-hover')}
    >
      {children}
    </button>
  );
}

type Place = { left: number; top: number } | null;

/**
 * Keeps a fixed bar where `compute` says: writes its style directly (no state, no extra render)
 * and follows scroll / resize while active (event-driven, no timers).
 */
function usePlaced(ref: RefObject<HTMLDivElement | null>, compute: (bar: HTMLElement) => Place, active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const apply = (): void => {
      const el = ref.current;
      if (!el) return;
      const p = compute(el);
      el.style.visibility = p ? '' : 'hidden';
      if (p) {
        el.style.left = `${p.left}px`;
        el.style.top = `${p.top}px`;
      }
    };
    apply();
    window.addEventListener('scroll', apply, true);
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('scroll', apply, true);
      window.removeEventListener('resize', apply);
    };
  }, [ref, compute, active]);
}

const MARKS = [
  { mark: 'bold', label: 'wiki.mark.bold', Icon: Bold, run: (e: Editor) => e.chain().focus().toggleBold().run() },
  { mark: 'italic', label: 'wiki.mark.italic', Icon: Italic, run: (e: Editor) => e.chain().focus().toggleItalic().run() },
  { mark: 'strike', label: 'wiki.mark.strike', Icon: Strikethrough, run: (e: Editor) => e.chain().focus().toggleStrike().run() },
  { mark: 'code', label: 'wiki.mark.code', Icon: Code, run: (e: Editor) => e.chain().focus().toggleCode().run() },
] as const;

type Panel = 'link' | 'turn' | 'color';

export function BubbleBar({ editor, env }: { editor: Editor; env: EditorEnv }): ReactNode {
  // A sub-panel belongs to the selection it was opened on: another selection shows the bar alone.
  const [open, setOpen] = useState<{ panel: Panel; from: number } | null>(null);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      const show = e.isEditable && !sel.empty && !(sel instanceof NodeSelection) && !e.isActive('codeBlock');
      return {
        show,
        focused: e.isFocused,
        from: sel.from,
        to: sel.to,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        highlight: show ? (str(e.getAttributes('highlight')['color']) as HighlightColor | '') : '',
        link: show ? str(e.getAttributes('link')['href']) : '',
        block: show ? currentBlock(e) : 'text',
      };
    },
  });
  const from = s.from;
  useEffect(() => env.onOpenLink(() => setOpen({ panel: 'link', from: editor.state.selection.from })), [env, editor]);
  const panel = s.show && open?.from === from ? open.panel : null;
  const setPanel = useCallback((p: Panel | null) => setOpen(p ? { panel: p, from } : null), [from]);
  const visible = s.show && (s.focused || panel !== null);
  const ref = useRef<HTMLDivElement>(null);
  const to = s.to;
  const compute = useCallback(
    (bar: HTMLElement): Place => {
      if (editor.isDestroyed) return null;
      try {
        const a = editor.view.coordsAtPos(from);
        const b = editor.view.coordsAtPos(to, -1);
        const w = bar.offsetWidth;
        const h = bar.offsetHeight;
        const mid = (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2;
        const top = a.top - h - 8 < 8 ? Math.max(a.bottom, b.bottom) + 8 : a.top - h - 8;
        return { left: clampX(mid - w / 2, w), top };
      } catch {
        return null;
      }
    },
    [editor, from, to],
  );
  usePlaced(ref, compute, visible);
  if (!visible) return null;
  const BlockIcon = BLOCK_ICONS[s.block];
  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('wiki.formatting')}
      className="mat-popover anim-in fixed z-[var(--z-popover)] flex flex-col rounded-[var(--radius-card)] p-1"
      style={{ left: -9999, top: -9999 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setPanel(null);
          editor.commands.focus();
        }
      }}
    >
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPanel(panel === 'turn' ? null : 'turn')}
          aria-expanded={panel === 'turn'}
          className="flex h-7 items-center gap-1 rounded-[var(--radius-icon)] px-1.5 text-control text-fg hover:bg-hover mobile:tap-h"
          title={t('wiki.turnInto')}
        >
          <BlockIcon className="size-4" strokeWidth={1.75} aria-hidden />
          <span className="max-w-[120px] truncate">{t(BLOCKS.find((b) => b.id === s.block)?.label ?? 'wiki.block.text')}</span>
          <ChevronRight className={cx('size-3.5 text-muted', panel === 'turn' && 'rotate-90')} aria-hidden />
        </button>
        <span className="mx-0.5 h-5 w-px bg-[var(--color-separator)]" aria-hidden />
        {MARKS.map(({ mark, label, Icon, run }) => (
          <BarButton key={mark} label={t(label)} active={s[mark]} onClick={() => run(editor)}>
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
          </BarButton>
        ))}
        <BarButton label={t('wiki.mark.highlight')} active={!!s.highlight || panel === 'color'} onClick={() => setPanel(panel === 'color' ? null : 'color')}>
          <Highlighter className="size-4" strokeWidth={1.75} aria-hidden />
        </BarButton>
        <BarButton label={t('wiki.link')} active={!!s.link || panel === 'link'} onClick={() => setPanel(panel === 'link' ? null : 'link')}>
          <Link className="size-4" strokeWidth={1.75} aria-hidden />
        </BarButton>
      </div>
      {panel === 'turn' ? <TurnInto editor={editor} current={s.block} onDone={() => setPanel(null)} /> : null}
      {panel === 'color' ? <Colors editor={editor} current={s.highlight} onDone={() => setPanel(null)} /> : null}
      {panel === 'link' ? <LinkField editor={editor} href={s.link} onDone={() => setPanel(null)} /> : null}
    </div>,
    document.body,
  );
}

function TurnInto({ editor, current, onDone }: { editor: Editor; current: BlockId; onDone: () => void }): ReactNode {
  return (
    <ul role="menu" aria-label={t('wiki.turnInto')} className="mt-1 border-t border-line pt-1">
      {BLOCKS.filter((b) => b.turnInto).map((b) => {
        const Icon = BLOCK_ICONS[b.id];
        return (
          <li key={b.id} role="none">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={b.id === current}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // Lists toggle: turning a list into itself would unwrap it.
                if (b.id !== current) b.run(editor.chain().focus()).run();
                onDone();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-body text-fg hover:bg-hover mobile:tap-min-h"
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">{t(b.label)}</span>
              {b.id === current ? <Check className="size-4 text-accent" aria-hidden /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Colors({ editor, current, onDone }: { editor: Editor; current: HighlightColor | ''; onDone: () => void }): ReactNode {
  return (
    <div role="group" aria-label={t('wiki.mark.highlight')} className="mt-1 flex items-center gap-1 border-t border-line px-1 pt-1">
      <button
        type="button"
        aria-label={t('wiki.color.none')}
        title={t('wiki.color.none')}
        aria-pressed={!current}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          editor.chain().focus().unsetHighlight().run();
          onDone();
        }}
        className="wiki-swatch grid size-7 place-items-center rounded-full mobile:tap-size"
        data-color="none"
      />
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={t(`wiki.color.${c}`)}
          title={t(`wiki.color.${c}`)}
          aria-pressed={current === c}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            editor.chain().focus().setHighlight({ color: c }).run();
            onDone();
          }}
          className="wiki-swatch grid size-7 place-items-center rounded-full mobile:tap-size"
          data-color={c}
        />
      ))}
    </div>
  );
}

function LinkField({ editor, href, onDone }: { editor: Editor; href: string; onDone: () => void }): ReactNode {
  const [value, setValue] = useState(href);
  const apply = (): void => {
    const v = value.trim();
    const url = !v ? '' : /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
    if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else if (isAllowedHref(url)) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    onDone();
  };
  return (
    <form
      className="mt-1 flex items-center gap-1 border-t border-line pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('wiki.link.placeholder')}
        aria-label={t('wiki.link')}
        className="h-7 min-w-0 flex-1 rounded-full border border-line bg-[var(--color-bg)] px-3 text-control text-fg mobile:tap-h"
        spellCheck={false}
      />
      <BarButton label={t('wiki.link.apply')} onClick={apply}>
        <Check className="size-4" strokeWidth={1.75} aria-hidden />
      </BarButton>
      {href ? (
        <BarButton
          label={t('wiki.link.remove')}
          onClick={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            onDone();
          }}
        >
          <Unlink className="size-4" strokeWidth={1.75} aria-hidden />
        </BarButton>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------- table bar

const TABLE_ACTIONS = [
  { label: 'wiki.table.rowAbove', Icon: ArrowUpToLine, run: (e: Editor) => e.chain().focus().addRowBefore().run() },
  { label: 'wiki.table.rowBelow', Icon: ArrowDownToLine, run: (e: Editor) => e.chain().focus().addRowAfter().run() },
  { label: 'wiki.table.colLeft', Icon: ArrowLeftToLine, run: (e: Editor) => e.chain().focus().addColumnBefore().run() },
  { label: 'wiki.table.colRight', Icon: ArrowRightToLine, run: (e: Editor) => e.chain().focus().addColumnAfter().run() },
  { label: 'wiki.table.deleteRow', Icon: Rows3, run: (e: Editor) => e.chain().focus().deleteRow().run() },
  { label: 'wiki.table.deleteCol', Icon: Columns3, run: (e: Editor) => e.chain().focus().deleteColumn().run() },
  { label: 'wiki.table.delete', Icon: Trash, run: (e: Editor) => e.chain().focus().deleteTable().run() },
] as const;

/** Row / column actions above the table the caret is in (only with a collapsed selection). */
export function TableBar({ editor }: { editor: Editor }): ReactNode {
  const at = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e.isEditable || !e.isFocused || !e.state.selection.empty || !e.isActive('table')) return -1;
      // The table's start: walk up from the caret.
      const $from = e.state.selection.$from;
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return $from.before(d);
      return -1;
    },
  });
  const ref = useRef<HTMLDivElement>(null);
  const compute = useCallback(
    (bar: HTMLElement): Place => {
      const dom = at >= 0 && !editor.isDestroyed ? editor.view.nodeDOM(at) : null;
      if (!(dom instanceof HTMLElement)) return null;
      const r = dom.getBoundingClientRect();
      return { left: clampX(r.left, bar.offsetWidth), top: Math.max(8, r.top - bar.offsetHeight - 6) };
    },
    [editor, at],
  );
  usePlaced(ref, compute, at >= 0);
  if (at < 0) return null;
  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('wiki.table.menu')}
      className="mat-popover anim-in fixed z-[var(--z-popover)] flex items-center gap-0.5 rounded-[var(--radius-card)] p-1"
      style={{ left: -9999, top: -9999 }}
    >
      {TABLE_ACTIONS.map(({ label, Icon, run }) => (
        <BarButton key={label} label={t(label)} onClick={() => run(editor)}>
          <Icon className="size-4" strokeWidth={1.75} aria-hidden />
        </BarButton>
      ))}
    </div>,
    document.body,
  );
}

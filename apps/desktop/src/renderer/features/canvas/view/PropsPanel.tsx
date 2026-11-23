import * as Popover from '@radix-ui/react-popover';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalDistributeCenter, ArrowLeftRight, ArrowRight, BringToFront, Check, CopyPlus, Group, Layers, ExternalLink, Lock, LockOpen, Minus, Unlink, SendToBack, Shapes, Slash, Trash2, Ungroup,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { rotateHandlePoint } from '../../../lib/canvas/geometry';
import { MARKER_WIDTHS, PEN_WIDTHS } from '../../../lib/canvas/ink';
import { Button, IconButton, MOD, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { ArrangeOp } from '../../../lib/canvas/arrange';
import { FontSizeField } from './FontSizeField';
import { FrameTitleField } from './FrameTitleField';
import { RouteIcon } from './RouteIcon';
import { ShapeIcon } from './ShapeIcon';
import { splitFill, type Arrow, type ObjectKind, type ObjectPatch, type RouteKind, type ShapeKind } from '../../../lib/canvas/types';
import { readableInk, resolveColor, resolveFill, resolveSticky, type CanvasEngine, type CanvasPalette } from '../engine';
import { ROTATE_OFFSET_PX } from '../engine/overlay';
import { DIVIDER, MENU_BOX, PANEL, keepFocus } from './chrome';
import { NO_INSETS, placePanel, type Insets } from './layout';
import {
  ARROW_DEFS, FILL_PICKER, FRAME_FILLS, INK_COLORS, ROUTE_DEFS, SHAPE_DEFS, STICKY_COLORS, STROKE_COLORS, STROKE_WIDTHS,
} from './model';
import { createSelectionModel } from './selectionModel';

const ICON = 'size-4';

/** The screen's floating panels, by test id, and the edge each one hangs from. */
const CHROME: readonly { id: string; edge: keyof Insets }[] = [
  { id: 'canvas-toolbar', edge: 'left' },
  { id: 'canvas-frames-panel', edge: 'left' },
  { id: 'canvas-history', edge: 'bottom' },
  { id: 'canvas-zoom', edge: 'bottom' },
  { id: 'canvas-presence', edge: 'top' },
  { id: 'canvas-status', edge: 'top' },
];

/** How far the floating panels reach into the canvas (px from each edge of `host`). Reads layout: call on change, not per frame. */
export function measureChrome(host: HTMLElement): Insets {
  const box = host.getBoundingClientRect();
  const out = { ...NO_INSETS };
  for (const { id, edge } of CHROME) {
    const el = host.querySelector(`[data-testid="${id}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const reach = edge === 'left' ? r.right - box.left : edge === 'top' ? r.bottom - box.top : box.bottom - r.top;
    out[edge] = Math.max(out[edge], Math.ceil(reach));
  }
  return out;
}

/** `frame`: a hue as a frame draws it (its soft tone). */
type ColorKind = 'sticky' | 'ink' | 'fill' | 'frame';

export function swatchCss(palette: CanvasPalette, kind: ColorKind, token: string): string | null {
  if (kind === 'sticky') return resolveSticky(palette, token).bg;
  if (kind === 'frame') return resolveFill(palette, token, true);
  const f = splitFill(token);
  return kind === 'fill' ? resolveFill(palette, f.fill, f.soft) : resolveColor(palette, token);
}

export function colorLabel(token: string): string {
  const f = splitFill(token);
  if (f.soft) return t('canvasBoard.color.softOf', { color: colorLabel(f.fill).toLowerCase() });
  const key = `canvasBoard.color.${token}`;
  const s = t(key as Parameters<typeof t>[0]);
  return s === key ? token : s;
}

export function Swatch({ css, none, size = 18 }: { css: string | null; none?: boolean; size?: number }): ReactNode {
  return (
    <span
      aria-hidden
      className="relative grid place-items-center overflow-hidden rounded-full ring-1 ring-inset ring-[var(--color-separator)]"
      style={{ width: size, height: size, background: css ?? 'transparent' }}
    >
      {none || css === null ? <Slash className="size-3 text-muted" strokeWidth={2} /> : null}
    </span>
  );
}

const GRID_COLS = 5;

/**
 * The swatch grid inside the popover: a radio group with roving focus (arrows move by cell, Home/End jump,
 * Enter/Space pick, Esc is Radix's). Focus opens on the current color; the hovered/focused color's name is
 * shown below so the color is never identified by its look alone.
 */
function SwatchGrid({
  label, kind, tokens, value, palette, onPick, testId,
}: {
  label: string;
  kind: ColorKind;
  tokens: readonly string[];
  value: string | undefined;
  palette: CanvasPalette;
  onPick: (token: string) => void;
  testId: string;
}): ReactNode {
  const [hot, setHot] = useState<string | undefined>(value);
  const start = Math.max(0, value === undefined ? 0 : tokens.indexOf(value));
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = cells.current.findIndex((c) => c === document.activeElement);
    if (at < 0) return;
    const last = tokens.length - 1;
    const to: Record<string, number> = {
      ArrowLeft: Math.max(at - 1, 0),
      ArrowRight: Math.min(at + 1, last),
      ArrowUp: at - GRID_COLS >= 0 ? at - GRID_COLS : at,
      ArrowDown: at + GRID_COLS <= last ? at + GRID_COLS : at,
      Home: 0,
      End: last,
    };
    const next = to[e.key];
    if (next === undefined) return;
    e.preventDefault();
    cells.current[next]?.focus();
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
        onKeyDown={move}
      >
        {tokens.map((tok, i) => {
          const css = swatchCss(palette, kind, tok);
          const selected = tok === value;
          return (
            <Popover.Close asChild key={tok}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={colorLabel(tok)}
                data-testid={`${testId}-${tok}`}
                ref={(n) => {
                  cells.current[i] = n;
                }}
                tabIndex={i === start ? 0 : -1}
                onClick={() => onPick(tok)}
                onMouseEnter={() => setHot(tok)}
                onFocus={() => setHot(tok)}
                className={cx(
                  'grid size-8 place-items-center rounded-[var(--radius-icon)] hover:bg-hover',
                  selected && 'bg-active',
                )}
              >
                <span className="relative grid place-items-center">
                  <Swatch css={css} none={tok === 'none'} size={22} />
                  {selected && css ? <Check className="absolute size-3" style={{ color: readableInk(css, '#ffffff') }} strokeWidth={3} aria-hidden /> : null}
                </span>
              </button>
            </Popover.Close>
          );
        })}
      </div>
      <div className="mt-1.5 truncate px-1 text-caption text-muted" aria-hidden>{hot === undefined ? '\u00a0' : colorLabel(hot)}</div>
    </div>
  );
}

/** A color button that opens a grid of palette swatches. `value` undefined = the selection differs. */
function SwatchMenu({
  label, kind, tokens, value, palette, onPick, focusCanvas, testId,
}: {
  label: string;
  kind: ColorKind;
  tokens: readonly string[];
  value: string | undefined;
  palette: CanvasPalette;
  onPick: (token: string) => void;
  focusCanvas: () => void;
  testId: string;
}): ReactNode {
  const current = value === undefined ? null : swatchCss(palette, kind, value);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={label} size="sm" onMouseDown={keepFocus} data-testid={testId}>
          <Swatch css={current} none={value === 'none'} size={20} />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          className={cx(MENU_BOX, 'w-auto min-w-0 p-2')}
          onOpenAutoFocus={(e) => {
            // Radix would focus the first tabbable; the grid focuses the current color itself.
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          aria-label={label}
        >
          <SwatchGrid label={label} kind={kind} tokens={tokens} value={value} palette={palette} onPick={onPick} testId={testId} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Seg<T extends string | number>({
  label, items, value, onPick, testId,
}: {
  label: string;
  items: readonly { id: T; label: string; node: ReactNode }[];
  value: T | undefined;
  onPick: (v: T) => void;
  testId: string;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {items.map((it) => (
        <IconButton
          key={String(it.id)}
          label={it.label}
          size="sm"
          active={it.id === value}
          className={cx(it.id === value && 'bg-active text-fg')}
          onMouseDown={keepFocus}
          onClick={() => onPick(it.id)}
          data-testid={`${testId}-${String(it.id)}`}
        >
          {it.node}
        </IconButton>
      ))}
    </div>
  );
}

const arrowNode: Record<Arrow, ReactNode> = {
  none: <Minus className={ICON} strokeWidth={1.75} aria-hidden />,
  end: <ArrowRight className={ICON} strokeWidth={1.75} aria-hidden />,
  both: <ArrowLeftRight className={ICON} strokeWidth={1.75} aria-hidden />,
};

const routeNode = (route: RouteKind): ReactNode => <RouteIcon route={route} className={ICON} />;

const shapeNode = (kind: ShapeKind): ReactNode => <ShapeIcon kind={kind} className={ICON} />;

/** Shape picker: the current outline on the button, the eleven in a 4-column grid (an inline row would not fit the panel). */
function ShapeMenu({ value, onPick, focusCanvas }: { value: ShapeKind | undefined; onPick: (k: ShapeKind) => void; focusCanvas: () => void }): ReactNode {
  const label = t('canvasBoard.props.shape');
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={label} size="sm" onMouseDown={keepFocus} data-testid="canvas-prop-shape">
          {value ? shapeNode(value) : <Shapes className={ICON} strokeWidth={1.75} aria-hidden />}
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          className={cx(MENU_BOX, 'w-auto min-w-0 p-1')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          aria-label={label}
        >
          <div role="group" aria-label={label} className="grid grid-cols-4 gap-0.5">
            {SHAPE_DEFS.map((d) => (
              <IconButton
                key={d.kind}
                label={t(d.label)}
                size="sm"
                active={d.kind === value}
                className={cx(d.kind === value && 'bg-active text-fg')}
                onMouseDown={keepFocus}
                onClick={() => onPick(d.kind)}
                data-testid={`canvas-prop-shape-${d.kind}`}
              >
                {shapeNode(d.kind)}
              </IconButton>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function widthNode(w: number): ReactNode {
  return <svg viewBox="0 0 16 16" className={ICON} aria-hidden><rect x="2" y={8 - w / 2} width="12" height={w} rx={w / 2} fill="currentColor" /></svg>;
}

/** The pen's (or the marker's) three widths, drawn thin / medium / thick whatever their size in the world. */
export function inkWidthItems(marker: boolean): { id: number; label: string; node: ReactNode }[] {
  return (marker ? MARKER_WIDTHS : PEN_WIDTHS).map((w, i) => {
    const def = STROKE_WIDTHS[i];
    return { id: w, label: def ? t(def.label) : String(w), node: widthNode([1.5, 3, 5][i] ?? 3) };
  });
}

const ALIGN_DEFS: readonly { op: ArrangeOp; label: Parameters<typeof t>[0]; Icon: LucideIcon }[] = [
  { op: 'left', label: 'canvasBoard.props.align.left', Icon: AlignStartVertical },
  { op: 'hcenter', label: 'canvasBoard.props.align.hcenter', Icon: AlignCenterVertical },
  { op: 'right', label: 'canvasBoard.props.align.right', Icon: AlignEndVertical },
  { op: 'top', label: 'canvasBoard.props.align.top', Icon: AlignStartHorizontal },
  { op: 'vmiddle', label: 'canvasBoard.props.align.vmiddle', Icon: AlignCenterHorizontal },
  { op: 'bottom', label: 'canvasBoard.props.align.bottom', Icon: AlignEndHorizontal },
];
const DISTRIBUTE_DEFS: readonly { op: ArrangeOp; label: Parameters<typeof t>[0]; Icon: LucideIcon }[] = [
  { op: 'hspace', label: 'canvasBoard.props.distribute.h', Icon: AlignHorizontalDistributeCenter },
  { op: 'vspace', label: 'canvasBoard.props.distribute.v', Icon: AlignVerticalDistributeCenter },
];

/** Align / distribute: one button, the operations in a small popover (the panel stays narrow). Distribute needs three things. */
function ArrangeMenu({ engine, units, focusCanvas }: { engine: CanvasEngine; units: number; focusCanvas: () => void }): ReactNode {
  const defs = units >= 3 ? [...ALIGN_DEFS, ...DISTRIBUTE_DEFS] : ALIGN_DEFS;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={t('canvasBoard.props.align')} size="sm" onMouseDown={keepFocus} data-testid="canvas-prop-align">
          <AlignStartVertical className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          className={cx(MENU_BOX, 'w-auto min-w-0 p-1')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          aria-label={t('canvasBoard.props.align')}
        >
          <div role="group" aria-label={t('canvasBoard.props.align')} className="flex items-center gap-0.5">
            {defs.map(({ op, label, Icon }, i) => (
              <Fragment key={op}>
                {i === ALIGN_DEFS.length ? <div className={DIVIDER} aria-hidden /> : null}
                <Popover.Close asChild>
                  <IconButton label={t(label)} size="sm" onMouseDown={keepFocus} onClick={() => engine.arrange(op)} data-testid={`canvas-prop-arrange-${op}`}>
                    <Icon className={ICON} strokeWidth={1.75} aria-hidden />
                  </IconButton>
                </Popover.Close>
              </Fragment>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The floating properties panel (ADR-0126 §5). It appears above the selected object and follows it by
 * writing `transform` directly from the engine's view events — React renders it only when the selection's
 * displayed values change (selectionModel), never per frame of a drag or pan. Hidden during gestures and
 * text editing.
 */
/** The site of a link as people read it: the host without `www.`. */
function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export const PropsPanel = memo(function PropsPanel({
  engine, palette, focusCanvas,
}: {
  engine: CanvasEngine;
  palette: CanvasPalette;
  focusCanvas: () => void;
}): ReactNode {
  useLocale();
  const store = useMemo(() => createSelectionModel(engine), [engine]);
  const m = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const present = m !== null;
  const el = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const chrome = useRef<Insets>(NO_INSETS);
  /** Chrome insets are re-read only when something could have moved them (selection, resize, becoming visible), never per frame. */
  const stale = useRef(true);
  const shown = useRef<boolean | null>(null);

  const place = useCallback((): void => {
    const node = el.current;
    if (!node) return;
    const s = engine.getState();
    let visible = false;
    if (s.selectionCount > 0 && !s.editing && !s.readOnly && engine.activeGesture === null) {
      const b = engine.scene.bounds(engine.selection);
      if (b) {
        if (stale.current && node.offsetParent instanceof HTMLElement) {
          chrome.current = measureChrome(node.offsetParent);
          stale.current = false;
        }
        const f = engine.selectionFrame();
        const knob = f?.rotate ? rotateHandlePoint(f.rect, f.rot, engine.px(ROTATE_OFFSET_PX)) : null;
        const p = placePanel(b, engine.camera, engine.viewport, size.current, chrome.current, knob);
        visible = p.visible;
        if (visible) node.style.transform = `translate(${p.x}px, ${p.y}px)`;
      }
    }
    if (shown.current !== visible) {
      shown.current = visible;
      if (!visible) stale.current = true;
      node.style.visibility = visible ? 'visible' : 'hidden';
    }
  }, [engine]);

  // Measure after the contents change, then position; keep following through the engine's own events.
  useLayoutEffect(() => {
    const node = el.current;
    if (node) size.current = { w: node.offsetWidth, h: node.offsetHeight };
    stale.current = true;
    place();
  }, [m, place]);
  useEffect(() => {
    const host = el.current?.offsetParent;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      stale.current = true;
      place();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [place, present]);
  useEffect(() => {
    const offView = engine.subscribeView(place);
    const offSel = engine.subscribeSelection(place);
    const offState = engine.subscribe(place);
    return () => {
      offView();
      offSel();
      offState();
    };
  }, [engine, place]);

  if (!m) return null;
  const patch = (p: ObjectPatch, kinds?: readonly ObjectKind[]): void => {
    engine.updateSelected(p, kinds);
  };
  const run = (fn: () => void) => (): void => {
    fn();
    focusCanvas();
  };

  return (
    <div
      ref={el}
      role="toolbar"
      aria-label={t('canvasBoard.props.label')}
      data-testid="canvas-props"
      className={cx(PANEL, 'absolute left-0 top-0 z-10 flex w-max items-center gap-1')}
      style={{ visibility: 'hidden' }}
    >
      {!m.locked && m.frameTitle !== undefined ? (
        <FrameTitleField
          // A new selection starts a fresh draft.
          key={engine.getState().selectedId ?? ''}
          value={m.frameTitle}
          label={t('canvasBoard.props.frameTitle')}
          placeholder={t('canvasBoard.frames.untitled')}
          onCommit={(title) => patch({ title }, ['frame'])}
          onDone={focusCanvas}
          className="h-7 w-40"
          testId="canvas-prop-frame-title"
        />
      ) : null}
      {!m.locked && m.hasFrame ? (
        <SwatchMenu label={t('canvasBoard.props.fill')} kind="frame" tokens={FRAME_FILLS} value={m.frameFill} palette={palette} onPick={(c) => patch({ fill: c }, ['frame'])} focusCanvas={focusCanvas} testId="canvas-prop-frame-fill" />
      ) : null}
      {m.hasSticky && !m.locked ? (
        <>
          <SwatchMenu label={t('canvasBoard.props.color')} kind="sticky" tokens={STICKY_COLORS} value={m.stickyColor} palette={palette} onPick={(c) => patch({ color: c }, ['sticky'])} focusCanvas={focusCanvas} testId="canvas-prop-sticky-color" />
          {/* A pad hands out stickies of its colour (owner 30.10, Miro-style). */}
          <IconButton
            size="sm"
            label={m.stickyPad ? `${t('canvasBoard.props.unpad')} · ${t('canvasBoard.props.padHint')}` : `${t('canvasBoard.props.pad')} · ${t('canvasBoard.props.padHint')}`}
            active={m.stickyPad === true}
            onClick={() => patch({ pad: m.stickyPad !== true }, ['sticky'])}
            data-testid="canvas-prop-sticky-pad"
          >
            <Layers className="size-4" aria-hidden />
          </IconButton>
        </>
      ) : null}
      {!m.locked && m.hasText ? (
        <>
          <SwatchMenu label={t('canvasBoard.props.color')} kind="ink" tokens={INK_COLORS} value={m.textColor} palette={palette} onPick={(c) => patch({ color: c }, ['text'])} focusCanvas={focusCanvas} testId="canvas-prop-text-color" />
        </>
      ) : null}
      {!m.locked && (m.hasText || m.hasSticky || m.hasShape) ? (
        // One px for all kinds: the doc spells it as a text object's size or a sticky's / shape's token + exact size.
        <FontSizeField value={m.fontPx} onCommit={(px) => patch({ fontPx: px })} release={focusCanvas} testId="canvas-prop-size" />
      ) : null}
      {!m.locked && m.hasShape ? (
        <>
          <ShapeMenu value={m.shape} onPick={(shape) => patch({ shape })} focusCanvas={focusCanvas} />
          <SwatchMenu label={t('canvasBoard.props.fill')} kind="fill" tokens={FILL_PICKER} value={m.fill} palette={palette} onPick={(c) => patch({ fill: c }, ['shape'])} focusCanvas={focusCanvas} testId="canvas-prop-fill" />
        </>
      ) : null}
      {!m.locked && (m.hasShape || m.hasConnector) ? (
        <>
          <SwatchMenu label={t('canvasBoard.props.stroke')} kind="ink" tokens={STROKE_COLORS} value={m.stroke} palette={palette} onPick={(c) => patch({ stroke: c }, ['shape', 'connector'])} focusCanvas={focusCanvas} testId="canvas-prop-stroke" />
          <Seg
            label={t('canvasBoard.props.strokeWidth')}
            testId="canvas-prop-width"
            value={m.strokeWidth}
            items={STROKE_WIDTHS.map((w) => ({ id: w.width, label: t(w.label), node: widthNode(w.width) }))}
            onPick={(strokeWidth) => patch({ strokeWidth }, ['shape', 'connector'])}
          />
        </>
      ) : null}
      {!m.locked && m.hasInk ? (
        <>
          <SwatchMenu label={t('canvasBoard.props.color')} kind="ink" tokens={STROKE_COLORS} value={m.inkColor} palette={palette} onPick={(c) => patch({ stroke: c }, ['ink'])} focusCanvas={focusCanvas} testId="canvas-prop-ink-color" />
          <Seg
            label={t('canvasBoard.props.strokeWidth')}
            testId="canvas-prop-ink-width"
            value={m.inkWidth}
            items={inkWidthItems(m.inkMarker === true)}
            onPick={(strokeWidth) => patch({ strokeWidth }, ['ink'])}
          />
        </>
      ) : null}
      {!m.locked && m.hasConnector ? (
        <>
          <Seg
            label={t('canvasBoard.props.route')}
            testId="canvas-prop-route"
            value={m.route}
            items={ROUTE_DEFS.map((d) => ({ id: d.route, label: t(d.label), node: routeNode(d.route) }))}
            onPick={(route) => patch({ route })}
          />
          <Seg
            label={t('canvasBoard.props.arrow')}
            testId="canvas-prop-arrow"
            value={m.arrow}
            items={ARROW_DEFS.map((d) => ({ id: d.arrow, label: t(d.label), node: arrowNode[d.arrow] }))}
            onPick={(arrow) => patch({ arrow })}
          />
        </>
      ) : null}
      {!m.locked && m.units >= 2 ? <ArrangeMenu engine={engine} units={m.units} focusCanvas={focusCanvas} /> : null}
      {m.canGroup ? (
        <IconButton label={t('canvasBoard.props.group')} shortcut={`${MOD}G`} size="sm" onMouseDown={keepFocus} onClick={run(() => engine.groupSelection())} data-testid="canvas-prop-group">
          <Group className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
      {m.canUngroup ? (
        <IconButton label={t('canvasBoard.props.ungroup')} shortcut={`⇧${MOD}G`} size="sm" onMouseDown={keepFocus} onClick={run(() => engine.ungroupSelection())} data-testid="canvas-prop-ungroup">
          <Ungroup className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
      {m.link !== undefined ? (
        <>
          {/* Where a click on the object leads: the site's name on the button (a pill under the object would sit under this panel). */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-[180px] text-fg"
            aria-label={`${t('canvasBoard.props.openLink')}: ${linkHost(m.link)}`}
            onMouseDown={keepFocus}
            onClick={() => engine.openLink(m.link ?? '')}
            data-testid="canvas-prop-open-link"
          >
            <ExternalLink className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="truncate">{linkHost(m.link)}</span>
          </Button>
          {m.locked ? null : (
            <IconButton label={t('canvasBoard.props.removeLink')} size="sm" onMouseDown={keepFocus} onClick={run(() => patch({ link: null }))} data-testid="canvas-prop-remove-link">
              <Unlink className={ICON} strokeWidth={1.75} aria-hidden />
            </IconButton>
          )}
        </>
      ) : null}
      {/* Locked: one labelled button says both the state and the way out (an icon toggle next to a «locked» badge read as two locks). */}
      {m.locked ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-fg"
          title={`${t('canvasBoard.props.locked')} · ⇧${MOD}L`}
          aria-pressed
          onMouseDown={keepFocus}
          onClick={run(() => engine.toggleLock())}
          data-testid="canvas-prop-lock"
        >
          <Lock className="size-3.5" strokeWidth={1.75} aria-hidden />
          {t('canvasBoard.props.unlock')}
        </Button>
      ) : (
        <IconButton label={t('canvasBoard.props.lock')} shortcut={`⇧${MOD}L`} size="sm" onMouseDown={keepFocus} onClick={run(() => engine.toggleLock())} data-testid="canvas-prop-lock">
          <LockOpen className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      )}
      <div className={DIVIDER} aria-hidden />
      <IconButton label={t('canvasBoard.props.front')} shortcut={`⇧${MOD}]`} size="sm" onMouseDown={keepFocus} onClick={run(() => engine.reorder(1, true))} data-testid="canvas-prop-front">
        <BringToFront className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={t('canvasBoard.props.back')} shortcut={`⇧${MOD}[`} size="sm" onMouseDown={keepFocus} onClick={run(() => engine.reorder(-1, true))} data-testid="canvas-prop-back">
        <SendToBack className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={t('canvasBoard.props.duplicate')} shortcut={`${MOD}D`} size="sm" onMouseDown={keepFocus} onClick={run(() => engine.duplicateSelection())} data-testid="canvas-prop-duplicate">
        <CopyPlus className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {m.locked ? null : (
        <IconButton label={t('canvasBoard.props.delete')} shortcut="Del" size="sm" danger onMouseDown={keepFocus} onClick={run(() => engine.deleteSelection())} data-testid="canvas-prop-delete">
          <Trash2 className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      )}
    </div>
  );
});


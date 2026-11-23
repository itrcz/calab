import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalDistributeCenter, ArrowLeftRight, ArrowRight, Check, CopyPlus, ExternalLink, Group, ListChecks, Lock, LockOpen, Minus, Palette, Pencil, Shapes, Trash2, Ungroup, type LucideIcon,
} from 'lucide-react';
import { memo, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { plural, t, useLocale } from '../../../i18n';
import type { ArrangeOp } from '../../../lib/canvas/arrange';
import type { Arrow, ObjectKind, ObjectPatch, RouteKind } from '../../../lib/canvas/types';
import { readableInk, type CanvasEngine, type CanvasPalette } from '../engine';
import { keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import { ARROW_DEFS, FILL_PICKER, INK_COLORS, ROUTE_DEFS, SHAPE_DEFS, STICKY_COLORS, STROKE_COLORS, STROKE_WIDTHS } from './model';
import { FontSizeField } from './FontSizeField';
import { PhoneBtn, SHEET } from './PhoneEditBar';
import { Swatch, colorLabel, swatchCss } from './PropsPanel';
import { ShapeIcon } from './ShapeIcon';
import { createSelectionModel, type PanelModel } from './selectionModel';
import { RouteIcon } from './RouteIcon';

/**
 * The properties of the selection on the phone (ADR-0127 wave 5b): a sheet above the tool bar instead of the desktop's
 * floating panel. One row of 44 px targets that scrolls sideways (color, text size, lock, duplicate, delete, group and
 * align, a connector's arrow and route, «Выбрать несколько»); a color, shape or align button opens its choices in a
 * grid above the row. It renders from the same selection snapshot as the desktop panel (selectionModel) — never for
 * a drag — and holds no timer or subscription of its own beyond that.
 */

const ICON = 'size-[22px]';
type PanelId = 'sticky' | 'ink' | 'fill' | 'stroke' | 'shape' | 'arrange';

const arrowNode: Record<Arrow, ReactNode> = {
  none: <Minus className={ICON} strokeWidth={1.75} aria-hidden />,
  end: <ArrowRight className={ICON} strokeWidth={1.75} aria-hidden />,
  both: <ArrowLeftRight className={ICON} strokeWidth={1.75} aria-hidden />,
};
const routeNode = (route: RouteKind): ReactNode => <RouteIcon route={route} className={ICON} />;
const widthNode = (w: number): ReactNode => <svg viewBox="0 0 16 16" className={ICON} aria-hidden><rect x="2" y={8 - w / 2} width="12" height={w} rx={w / 2} fill="currentColor" /></svg>;

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

const SEP = <div className="mx-0.5 h-6 w-px shrink-0 self-center bg-line" aria-hidden />;

export const PhoneProps = memo(function PhoneProps({ engine, palette, focusCanvas }: { engine: CanvasEngine; palette: CanvasPalette; focusCanvas: () => void }): ReactNode {
  useLocale();
  const store = useMemo(() => createSelectionModel(engine), [engine]);
  const m = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const multi = useEngineValue(engine, (s) => s.multiSelect);
  const [panel, setPanel] = useState<PanelId | null>(null);
  // Nothing selected (or the panel's subject is gone): its grid goes with it.
  if (m === null && panel !== null) setPanel(null);
  if (!m && !multi) return null;

  const patch = (p: ObjectPatch, kinds?: readonly ObjectKind[]): void => engine.updateSelected(p, kinds);
  const run = (fn: () => unknown) => (): void => {
    fn();
    focusCanvas();
  };
  const toggle = (id: PanelId) => (): void => setPanel(panel === id ? null : id);
  const pickColor = (p: ObjectPatch) => (): void => {
    patch(p);
    setPanel(null);
  };
  const free = !!m && !m.locked;

  return (
    <div className={cx(SHEET, 'flex flex-col')} role="toolbar" aria-label={t('canvasBoard.props.label')} data-testid="canvas-phone-props">
      {m && panel ? <PanelGrid id={panel} m={m} palette={palette} engine={engine} onPatch={(p) => { patch(p, panel === 'sticky' ? ['sticky'] : panel === 'ink' ? ['text'] : undefined); setPanel(null); }} onDone={() => setPanel(null)} pickColor={pickColor} /> : null}
      <div className="flex items-center gap-0.5 overflow-x-auto px-1 py-1" data-testid="canvas-phone-props-row">
        {m ? (
          <span className="shrink-0 px-2 text-control tabular-nums text-muted" data-testid="canvas-phone-count">
            {plural('canvasPhone.selected', m.count)}
          </span>
        ) : (
          <span className="shrink-0 px-2 text-control text-muted" data-testid="canvas-phone-multi-hint">{t('canvasPhone.multiHint')}</span>
        )}
        {free && m.count === 1 && (m.hasSticky || m.hasText || m.hasShape) ? (
          <PhoneBtn label={t('canvasPhone.editText')} onClick={() => void engine.startTextEdit()} testId="canvas-prop-edit-text">
            <Pencil className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ) : null}
        {free && m.hasSticky ? (
          <PhoneBtn label={t('canvasBoard.props.color')} active={panel === 'sticky'} onClick={toggle('sticky')} testId="canvas-prop-sticky-color">
            <Swatch css={m.stickyColor === undefined ? null : swatchCss(palette, 'sticky', m.stickyColor)} size={22} />
          </PhoneBtn>
        ) : null}
        {free && m.hasText ? (
          <PhoneBtn label={t('canvasBoard.props.color')} active={panel === 'ink'} onClick={toggle('ink')} testId="canvas-prop-text-color">
            <Swatch css={m.textColor === undefined ? null : swatchCss(palette, 'ink', m.textColor)} size={22} />
          </PhoneBtn>
        ) : null}
        {free && m.hasShape ? (
          <>
            <PhoneBtn label={t('canvasBoard.props.shape')} active={panel === 'shape'} onClick={toggle('shape')} testId="canvas-prop-shape">
              {m.shape ? <ShapeIcon kind={m.shape} className={ICON} /> : <Shapes className={ICON} strokeWidth={1.75} aria-hidden />}
            </PhoneBtn>
            <PhoneBtn label={t('canvasBoard.props.fill')} active={panel === 'fill'} onClick={toggle('fill')} testId="canvas-prop-fill">
              <Swatch css={m.fill === undefined ? null : swatchCss(palette, 'fill', m.fill)} none={m.fill === 'none'} size={22} />
            </PhoneBtn>
          </>
        ) : null}
        {free && (m.hasShape || m.hasConnector) ? (
          <PhoneBtn label={t('canvasBoard.props.stroke')} active={panel === 'stroke'} onClick={toggle('stroke')} testId="canvas-prop-stroke">
            <Palette className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ) : null}
        {free && (m.hasText || m.hasSticky || m.hasShape) ? (
          <FontSizeField touch value={m.fontPx} onCommit={(px) => patch({ fontPx: px })} release={focusCanvas} testId="canvas-prop-size" />
        ) : null}
        {free && (m.hasShape || m.hasConnector) ? (
          <Seg
            label={t('canvasBoard.props.strokeWidth')}
            testId="canvas-prop-width"
            value={m.strokeWidth}
            items={STROKE_WIDTHS.map((w) => ({ id: w.width, label: t(w.label), node: widthNode(w.width) }))}
            onPick={(strokeWidth) => patch({ strokeWidth })}
          />
        ) : null}
        {free && m.hasConnector ? (
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
        {free && m.units >= 2 ? (
          <PhoneBtn label={t('canvasBoard.props.align')} active={panel === 'arrange'} onClick={toggle('arrange')} testId="canvas-prop-align">
            <AlignStartVertical className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ) : null}
        {m?.canGroup ? (
          <PhoneBtn label={t('canvasBoard.props.group')} onClick={run(() => engine.groupSelection())} testId="canvas-prop-group">
            <Group className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ) : null}
        {m?.canUngroup ? (
          <PhoneBtn label={t('canvasBoard.props.ungroup')} onClick={run(() => engine.ungroupSelection())} testId="canvas-prop-ungroup">
            <Ungroup className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ) : null}
        {m?.link !== undefined ? (
          <PhoneBtn label={t('canvasBoard.props.openLink')} onClick={() => engine.openLink(m.link ?? '')} testId="canvas-prop-open-link">
            <ExternalLink className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ) : null}
        {m ? (
          <>
            {SEP}
            <PhoneBtn label={t(m.locked ? 'canvasBoard.props.unlock' : 'canvasBoard.props.lock')} active={m.locked} onClick={run(() => engine.toggleLock())} testId="canvas-prop-lock">
              {m.locked ? <Lock className={ICON} strokeWidth={1.75} aria-hidden /> : <LockOpen className={ICON} strokeWidth={1.75} aria-hidden />}
            </PhoneBtn>
            <PhoneBtn label={t('canvasBoard.props.duplicate')} onClick={run(() => engine.duplicateSelection())} testId="canvas-prop-duplicate">
              <CopyPlus className={ICON} strokeWidth={1.75} aria-hidden />
            </PhoneBtn>
          </>
        ) : null}
        {SEP}
        <PhoneBtn label={t('canvasPhone.multi')} active={multi} onClick={() => engine.setMultiSelect(!multi)} testId="canvas-phone-multi">
          <ListChecks className={ICON} strokeWidth={1.75} aria-hidden />
        </PhoneBtn>
        {m && !m.locked ? (
          <button
            type="button"
            aria-label={t('canvasBoard.props.delete')}
            title={t('canvasBoard.props.delete')}
            onMouseDown={keepFocus}
            onClick={run(() => engine.deleteSelection())}
            className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-danger-text active:bg-active"
            data-testid="canvas-prop-delete"
          >
            <Trash2 className={ICON} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
});

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
    <div role="group" aria-label={label} className="flex shrink-0 items-center">
      {SEP}
      {items.map((it) => (
        <PhoneBtn key={String(it.id)} label={it.label} active={it.id === value} onClick={() => onPick(it.id)} testId={`${testId}-${String(it.id)}`}>
          {it.node}
        </PhoneBtn>
      ))}
    </div>
  );
}

const COLOR_PANEL: Record<'sticky' | 'ink' | 'fill' | 'stroke', { kind: 'sticky' | 'ink' | 'fill'; tokens: readonly string[]; label: Parameters<typeof t>[0]; field: 'color' | 'fill' | 'stroke'; value: (m: PanelModel) => string | undefined }> = {
  sticky: { kind: 'sticky', tokens: STICKY_COLORS, label: 'canvasBoard.props.color', field: 'color', value: (m) => m.stickyColor },
  ink: { kind: 'ink', tokens: INK_COLORS, label: 'canvasBoard.props.color', field: 'color', value: (m) => m.textColor },
  fill: { kind: 'fill', tokens: FILL_PICKER, label: 'canvasBoard.props.fill', field: 'fill', value: (m) => m.fill },
  stroke: { kind: 'ink', tokens: STROKE_COLORS, label: 'canvasBoard.props.stroke', field: 'stroke', value: (m) => m.stroke },
};

/** The choices of one button, above the row: swatches, shapes or the align operations — 44 px cells that wrap. */
function PanelGrid({
  id, m, palette, engine, onPatch, onDone, pickColor,
}: {
  id: PanelId;
  m: PanelModel;
  palette: CanvasPalette;
  engine: CanvasEngine;
  onPatch: (p: ObjectPatch) => void;
  onDone: () => void;
  pickColor: (p: ObjectPatch) => () => void;
}): ReactNode {
  if (id === 'shape') {
    return (
      <div role="group" aria-label={t('canvasBoard.props.shape')} className="flex flex-wrap gap-0.5 border-b border-line p-1" data-testid="canvas-phone-panel">
        {SHAPE_DEFS.map((d) => (
          <PhoneBtn key={d.kind} label={t(d.label)} active={d.kind === m.shape} onClick={() => onPatch({ shape: d.kind })} testId={`canvas-prop-shape-${d.kind}`}>
            <ShapeIcon kind={d.kind} className={ICON} />
          </PhoneBtn>
        ))}
      </div>
    );
  }
  if (id === 'arrange') {
    const defs = m.units >= 3 ? [...ALIGN_DEFS, ...DISTRIBUTE_DEFS] : ALIGN_DEFS;
    return (
      <div role="group" aria-label={t('canvasBoard.props.align')} className="flex flex-wrap gap-0.5 border-b border-line p-1" data-testid="canvas-phone-panel">
        {defs.map(({ op, label, Icon }) => (
          <PhoneBtn key={op} label={t(label)} onClick={() => { engine.arrange(op); onDone(); }} testId={`canvas-prop-arrange-${op}`}>
            <Icon className={ICON} strokeWidth={1.75} aria-hidden />
          </PhoneBtn>
        ))}
      </div>
    );
  }
  const def = COLOR_PANEL[id];
  const value = def.value(m);
  return (
    <div role="radiogroup" aria-label={t(def.label)} className="flex flex-wrap gap-0.5 border-b border-line p-1" data-testid="canvas-phone-panel">
      {def.tokens.map((tok) => {
        const css = swatchCss(palette, def.kind, tok);
        const selected = tok === value;
        return (
          <button
            key={tok}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={colorLabel(tok)}
            onMouseDown={keepFocus}
            onClick={pickColor({ [def.field]: tok })}
            className={cx('grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] active:bg-active', selected && 'bg-active')}
            data-testid={`canvas-phone-color-${tok}`}
          >
            <span className="relative grid place-items-center">
              <Swatch css={css} none={tok === 'none'} size={26} />
              {selected && css ? <Check className="absolute size-3.5" style={{ color: readableInk(css, '#ffffff') }} strokeWidth={3} aria-hidden /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}


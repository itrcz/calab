/**
 * What the properties panel shows for the current selection, as a small immutable snapshot that is
 * replaced only when something the panel displays changes. The engine reports every change to a
 * selected object (a drag moves it 60 times a second); the panel must not re-render for x/y, so the
 * snapshot is compared by value and the same object is returned while it is equal.
 */
import { arrangeUnits } from '../../../lib/canvas/arrange';
import type { Scene } from '../../../lib/canvas/scene';
import { boxFontSize } from '../../../lib/canvas/textLayout';
import { SOFT_PREFIX, type Arrow, type ObjectRec, type RouteKind, type ShapeKind } from '../../../lib/canvas/types';
import type { CanvasEngine } from '../engine';

export interface PanelModel {
  count: number;
  hasSticky: boolean;
  hasText: boolean;
  hasShape: boolean;
  hasConnector: boolean;
  /** Freehand strokes are selected. */
  hasInk: boolean;
  /** Frames are selected. */
  hasFrame: boolean;
  /** Every selected object is locked: nothing of the selection can be changed or deleted, only unlocked, grouped, ordered or duplicated. */
  locked: boolean;
  /** Two or more objects that are not already exactly one group. */
  canGroup: boolean;
  /** Some selected object is in a group. */
  canUngroup: boolean;
  /** Things that align / distribute as units (a whole group counts as one), capped at 3: 2 enables align, 3 distribute. */
  units: number;
  /** Uniform values of the selection; undefined where the selected objects differ (or do not have the field). */
  stickyColor?: string;
  /** All selected stickies are pads (true) or none is (false); undefined when they differ. */
  stickyPad?: boolean;
  textColor?: string;
  textSize?: number;
  /** Text size in px shared by all selected texts, stickies and shapes; undefined when they differ. */
  fontPx?: number;
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  arrow?: Arrow;
  route?: RouteKind;
  /** The selected strokes' color, width and kind (marker or pen), where they agree. */
  inkColor?: string;
  inkWidth?: number;
  inkMarker?: boolean;
  /** The selected frames' hue, where they agree. */
  frameFill?: string;
  /** The name of the one selected frame (only when it is the whole selection). */
  frameTitle?: string;
  /** The web link of the one selected sticky, text or shape (only when it is the whole selection). */
  link?: string;
}

function uniform<T>(values: readonly T[]): T | undefined {
  const first = values[0];
  return first !== undefined && values.every((v) => v === first) ? first : undefined;
}

/** Group member counts come from the scene; without it every group in the selection counts as whole. */
export function panelModelOf(objs: readonly ObjectRec[], groupSize: (gid: string) => number = () => 0): PanelModel | null {
  if (objs.length === 0) return null;
  const firstGroup = objs[0]?.group;
  const sticky = objs.flatMap((o) => (o.kind === 'sticky' ? [o] : []));
  const text = objs.flatMap((o) => (o.kind === 'text' ? [o] : []));
  const shape = objs.flatMap((o) => (o.kind === 'shape' ? [o] : []));
  const conn = objs.flatMap((o) => (o.kind === 'connector' ? [o] : []));
  const ink = objs.flatMap((o) => (o.kind === 'ink' ? [o] : []));
  const frame = objs.flatMap((o) => (o.kind === 'frame' ? [o] : []));
  const out: PanelModel = {
    count: objs.length,
    hasSticky: sticky.length > 0,
    hasText: text.length > 0,
    hasShape: shape.length > 0,
    hasConnector: conn.length > 0,
    hasInk: ink.length > 0,
    hasFrame: frame.length > 0,
    locked: objs.every((o) => o.locked === true),
    canGroup: objs.length >= 2 && !(firstGroup !== undefined && objs.every((o) => o.group === firstGroup) && groupSize(firstGroup) <= objs.length),
    canUngroup: objs.some((o) => o.group !== undefined),
    units: Math.min(3, arrangeUnits(objs, groupSize).length),
  };
  const set = <K extends keyof PanelModel>(k: K, v: PanelModel[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  set('stickyColor', uniform(sticky.map((o) => o.color)));
  set('stickyPad', uniform(sticky.map((o) => o.pad === true)));
  set('textColor', uniform(text.map((o) => o.color)));
  set('textSize', uniform(text.map((o) => o.size)));
  set('fontPx', uniform([...text, ...sticky, ...shape].map(boxFontSize)));
  set('shape', uniform(shape.map((o) => o.shape)));
  set('fill', uniform(shape.map((o) => (o.soft ? `${SOFT_PREFIX}${o.fill}` : o.fill))));
  set('stroke', uniform([...shape.map((o) => o.stroke), ...conn.map((o) => o.stroke)]));
  set('strokeWidth', uniform([...shape.map((o) => o.strokeWidth), ...conn.map((o) => o.strokeWidth)]));
  set('arrow', uniform(conn.map((o) => o.arrow)));
  set('route', uniform(conn.map((o) => o.route)));
  set('inkColor', uniform(ink.map((o) => o.stroke)));
  set('inkWidth', uniform(ink.map((o) => o.strokeWidth)));
  set('inkMarker', uniform(ink.map((o) => o.marker === true)));
  set('frameFill', uniform(frame.map((o) => o.fill)));
  if (objs.length === 1 && frame[0]) out.frameTitle = frame[0].title;
  const one = objs.length === 1 ? objs[0] : undefined;
  if (one && (one.kind === 'sticky' || one.kind === 'text' || one.kind === 'shape') && one.link !== undefined) out.link = one.link;
  return out;
}

const KEYS: readonly (keyof PanelModel)[] = [
  'count', 'hasSticky', 'hasText', 'hasShape', 'hasConnector', 'locked', 'canGroup', 'canUngroup', 'units', 'stickyColor', 'textColor', 'textSize', 'fontPx', 'shape', 'fill', 'stroke', 'strokeWidth', 'arrow', 'route', 'hasInk', 'inkColor', 'inkWidth', 'inkMarker', 'hasFrame', 'frameFill', 'frameTitle', 'link',
];

export const samePanelModel = (a: PanelModel | null, b: PanelModel | null): boolean =>
  a === b || (!!a && !!b && KEYS.every((k) => a[k] === b[k]));

/** A `useSyncExternalStore` source: `null` = nothing selected. */
export interface SelectionModelStore {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => PanelModel | null;
}

export function createSelectionModel(engine: Pick<CanvasEngine, 'subscribeSelection' | 'getSelected'> & { scene?: Pick<Scene, 'groupMembers'> }): SelectionModelStore {
  const size = (gid: string): number => engine.scene?.groupMembers(gid).size ?? 0;
  let current: PanelModel | null = panelModelOf(engine.getSelected(), size);
  return {
    subscribe(cb) {
      return engine.subscribeSelection((objs) => {
        const next = panelModelOf(objs, size);
        if (samePanelModel(next, current)) return;
        current = next;
        cb();
      });
    },
    getSnapshot() {
      // The snapshot may be read before the first change event (mount): resync lazily.
      const fresh = panelModelOf(engine.getSelected(), size);
      if (!samePanelModel(fresh, current)) current = fresh;
      return current;
    },
  };
}

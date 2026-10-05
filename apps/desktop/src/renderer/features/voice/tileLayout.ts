/**
 * Video tiles of a voice room (docs/09 #42): which participants get a tile, which one is large,
 * and where every tile goes. Pure, unit-tested; VideoStage.tsx only renders the result.
 */

export const MAX_TILES = 6;
/** A hidden speaker replaces a visible tile at most this often (ADR-0066 §2: no flicker on cross-talk). */
export const TILE_SWAP_MS = 1500;
const ASPECT = 16 / 9;

export interface TilePerson {
  userId: string;
  /** Publishes a camera the viewer can show (not hidden with «Не показывать видео»). */
  video: boolean;
}

/**
 * The visible set carried from one selection to the next: which people hold the visible slots
 * (in slot order) and when the last speech swap happened (same clock as `now`).
 */
export interface TileSlots {
  ids: readonly string[];
  swappedAt: number;
}

export const NO_SLOTS: TileSlots = { ids: [], swappedAt: Number.NEGATIVE_INFINITY };

export interface TileSelection {
  /** In display order; the featured tile (if any) first. */
  tiles: TilePerson[];
  /** People who did not fit (shown as «Ещё N» on the last tile). */
  overflow: number;
  /** Who is behind «Ещё N», in call order. */
  hidden: string[];
  /**
   * Large tile: the one the viewer clicked, else (≥ 3 tiles) the latest *remote* speaker with a
   * camera, else the first remote camera. My own camera is never large unless I click it
   * (Discord / FaceTime: the self-view stays small).
   */
  featured: string | null;
  /** Pass back as `prev` next time. */
  slots: TileSlots;
  /** A speech swap is due but rate-limited: select again at this time. */
  retryAt: number | null;
}

export interface SelectOpts {
  focused: string | null;
  active: string | null;
  me?: string;
  max?: number;
  /** userId → when they last started speaking (lib/lastSpoke.ts); missing = never. */
  spoke?: ReadonlyMap<string, number>;
  /** The previous selection's slots: visible tiles keep their places. */
  prev?: TileSlots;
  now?: number;
}

/**
 * Which tiles show and in what order.
 *
 * Everyone fits (≤ max): the clicked tile, then cameras, then everyone else, each group in call
 * order — tiles don't jump when someone starts talking (review L5).
 *
 * More people than fit (ADR-0066 §2): max − 1 tiles and «Ещё N». The pinned tile and mine always
 * have a slot; the other slots prefer recent speakers. When someone hidden starts speaking they
 * take the slot of the visible tile (not pinned, not mine) that has been silent longest — in
 * place, nothing else moves; at most one such swap per TILE_SWAP_MS. Visible tiles never move
 * because someone else spoke. Empty slots fill by: last spoke (recent first), cameras before
 * avatars, call order.
 */
export function selectTiles(people: readonly TilePerson[], opts: SelectOpts): TileSelection {
  const max = opts.max ?? MAX_TILES;
  const prev = opts.prev ?? NO_SLOTS;
  const spoke = opts.spoke ?? new Map<string, number>();
  const now = opts.now ?? 0;
  const order = new Map(people.map((p, i) => [p.userId, i]));
  const byId = new Map(people.map((p) => [p.userId, p]));
  const focused = opts.focused && order.has(opts.focused) ? opts.focused : null;
  let ids: string[];
  let swappedAt = prev.swappedAt;
  let retryAt: number | null = null;
  if (people.length <= max) {
    ids = [...people]
      .sort((a, b) => {
        if (a.userId === focused) return -1;
        if (b.userId === focused) return 1;
        if (a.video !== b.video) return a.video ? -1 : 1;
        return (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0);
      })
      .map((p) => p.userId);
  } else {
    const cap = max - 1;
    const said = (id: string): number => spoke.get(id) ?? 0;
    // Fill rank: recent speakers, then cameras, then call order.
    const rank = (a: string, b: string): number =>
      said(b) - said(a) || Number(byId.get(b)?.video ?? false) - Number(byId.get(a)?.video ?? false) || (order.get(a) ?? 0) - (order.get(b) ?? 0);
    const required = [focused, opts.me && order.has(opts.me) ? opts.me : null].filter((id): id is string => id !== null);
    ids = prev.ids.filter((id) => order.has(id));
    // The visible tile silent longest (ties: the lowest-ranked) — the one a newcomer replaces.
    const victim = (): number => {
      let at = -1;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i] as string;
        if (required.includes(id)) continue;
        const cur = at < 0 ? undefined : (ids[at] as string);
        if (cur === undefined || said(id) < said(cur) || (said(id) === said(cur) && rank(id, cur) > 0)) at = i;
      }
      return at;
    };
    while (ids.length > cap) {
      const at = victim();
      if (at < 0) break;
      ids.splice(at, 1);
    }
    // Reversed: with free slots, the pinned tile ends up first, mine second.
    for (const id of [...required].reverse()) {
      if (ids.includes(id)) continue;
      const at = ids.length >= cap ? victim() : -1;
      if (at >= 0) ids[at] = id;
      else ids.unshift(id);
    }
    const hiddenRanked = (): string[] => people.map((p) => p.userId).filter((id) => !ids.includes(id)).sort(rank);
    for (const id of hiddenRanked()) {
      if (ids.length >= cap) break;
      ids.push(id);
    }
    // One speech swap: the most recent hidden speaker vs the longest-silent visible tile.
    const speaker = hiddenRanked()[0];
    const at = victim();
    const out = at >= 0 ? (ids[at] as string) : undefined;
    if (speaker !== undefined && out !== undefined && said(speaker) > said(out)) {
      if (now - prev.swappedAt >= TILE_SWAP_MS) {
        ids[at] = speaker;
        swappedAt = now;
      } else retryAt = prev.swappedAt + TILE_SWAP_MS;
    }
  }
  const tiles = ids.map((id) => byId.get(id)).filter((p): p is TilePerson => p !== undefined);
  const shown = new Set(ids);
  const hidden = people.map((p) => p.userId).filter((id) => !shown.has(id));
  let featured: string | null = focused;
  if (!featured && tiles.length >= 3) {
    // The active speaker (800 ms, lib/activeSpeaker.ts) if they show video, else the first
    // remote camera. Never my own camera by default.
    const remote = tiles.filter((t) => t.video && t.userId !== opts.me);
    featured = remote.find((t) => t.userId === opts.active)?.userId ?? remote[0]?.userId ?? null;
  }
  if (featured) {
    // The large tile goes first; the tile it displaces takes its place (the rest stay put).
    const i = tiles.findIndex((t) => t.userId === featured);
    if (i > 0) [tiles[0], tiles[i]] = [tiles[i] as TilePerson, tiles[0] as TilePerson];
  }
  return { tiles, overflow: hidden.length, hidden, featured, slots: { ids, swappedAt }, retryAt };
}

/** Same tiles, large tile and hidden list — the grid needn't re-render. */
export function sameSelection(a: TileSelection, b: TileSelection): boolean {
  return (
    a.featured === b.featured &&
    a.tiles.length === b.tiles.length &&
    a.tiles.every((t, i) => {
      const o = b.tiles[i];
      return o !== undefined && t.userId === o.userId && t.video === o.video;
    }) &&
    a.hidden.length === b.hidden.length &&
    a.hidden.every((id, i) => id === b.hidden[i])
  );
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest 16:9 box that fits into w × h. */
function fit(w: number, h: number): { w: number; h: number } {
  const byW = { w, h: w / ASPECT };
  return byW.h <= h ? byW : { w: h * ASPECT, h };
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

/** Equal 16:9 tiles, the column count that makes them largest; rows centred (the last one too). */
function grid(n: number, box: Rect, gap: number): Rect[] {
  let best = { cols: 1, w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const t = fit((box.w - gap * (cols - 1)) / cols, (box.h - gap * (rows - 1)) / rows);
    if (t.w > best.w) best = { cols, ...t };
  }
  const rows = Math.ceil(n / best.cols);
  const top = box.y + (box.h - (rows * best.h + (rows - 1) * gap)) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(best.cols, n - r * best.cols);
    const left = box.x + (box.w - (inRow * best.w + (inRow - 1) * gap)) / 2;
    for (let c = 0; c < inRow; c++) out.push({ x: left + c * (best.w + gap), y: top + r * (best.h + gap), w: best.w, h: best.h });
  }
  return out;
}

/** A row (or column) of `n` equal 16:9 tiles inside `box`, centred along its length. */
function strip(n: number, box: Rect, gap: number, vertical: boolean): Rect[] {
  const t = vertical ? fit(box.w, (box.h - gap * (n - 1)) / n) : fit((box.w - gap * (n - 1)) / n, box.h);
  const len = n * (vertical ? t.h : t.w) + (n - 1) * gap;
  const start = vertical ? box.y + (box.h - len) / 2 : box.x + (box.w - len) / 2;
  return Array.from({ length: n }, (_, i) =>
    vertical
      ? { x: box.x + (box.w - t.w) / 2, y: start + i * (t.h + gap), w: t.w, h: t.h }
      : { x: start + i * (t.w + gap), y: box.y + (box.h - t.h) / 2, w: t.w, h: t.h },
  );
}

/**
 * Positions for `n` tiles in a `width × height` area. Without a featured tile: an equal grid.
 * With one (index 0): it takes the main area, the rest line up in a strip — on the right in a
 * landscape area, underneath in a portrait one.
 */
export function layoutTiles(n: number, featured: boolean, width: number, height: number, gap = 8): Rect[] {
  if (n <= 0 || width <= 0 || height <= 0) return [];
  const box: Rect = { x: 0, y: 0, w: width, h: height };
  if (!featured || n === 1) return grid(n, box, gap).map(round);
  const rest = n - 1;
  // Two arrangements — the strip on the right or underneath; the one with the larger main tile
  // wins (a wide-but-short area used to leave empty bands above and below). The main tile and
  // the strip are centred together as one group.
  const side = (): Rect[] => {
    const main = fit(width * 0.8, height);
    // The strip takes what the main tile leaves, within 120–320 px, and never less than it needs.
    const s = Math.min(320, Math.max(120, width - main.w - gap));
    const m = fit(width - s - gap, height);
    const tiles = strip(rest, { x: 0, y: 0, w: s, h: height }, gap, true);
    const stripW = Math.max(...tiles.map((t) => t.w));
    const left = (width - (m.w + gap + stripW)) / 2;
    return [{ x: left, y: (height - m.h) / 2, w: m.w, h: m.h }, ...tiles.map((t) => ({ ...t, x: left + m.w + gap + (stripW - t.w) / 2 }))];
  };
  const below = (): Rect[] => {
    const low = Math.min(180, Math.max(90, Math.round(height * 0.22)));
    const m = fit(width, height - low - gap);
    const tiles = strip(rest, { x: 0, y: 0, w: width, h: low }, gap, false);
    const stripH = Math.max(...tiles.map((t) => t.h));
    const top = (height - (m.h + gap + stripH)) / 2;
    return [{ x: (width - m.w) / 2, y: top, w: m.w, h: m.h }, ...tiles.map((t) => ({ ...t, y: top + m.h + gap + (stripH - t.h) / 2 }))];
  };
  const a = side();
  const b = below();
  const area = (r: Rect[]): number => (r[0] ? r[0].w * r[0].h : 0);
  return (area(a) >= area(b) ? a : b).map(round);
}

/**
 * The camera for the PiP while the chat is open: the active speaker's (remote), else the first
 * remote camera, else my own (a self-view is better than nothing). `cameras` must already
 * exclude hidden ones («Не показывать видео»).
 */
export function pipCamera(cameras: readonly string[], me: string, active: string | null): string | null {
  const remote = cameras.filter((id) => id !== me);
  if (remote.length) return active && remote.includes(active) ? active : (remote[0] ?? null);
  return cameras.includes(me) ? me : null;
}

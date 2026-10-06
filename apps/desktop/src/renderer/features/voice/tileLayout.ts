/**
 * Video tiles of a voice room (docs/09 #42, ADR-0066): who is on which gallery page and in what
 * order, who is large in the speaker view, and where every tile goes. Pure, unit-tested;
 * CameraTiles.tsx only renders the result.
 */

/** A hidden speaker replaces a visible tile at most this often (ADR-0066 §2: no flicker on cross-talk). */
export const TILE_SWAP_MS = 1500;
const ASPECT = 16 / 9;

/** «Галерея | Спикер» (ADR-0066 §1), remembered per device (prefs.callView). */
export type CallView = 'gallery' | 'speaker';

/** Gallery page caps (owner, 05.10): 5×5 at most, «слабый компьютер» 3×3, phones 2×2. */
export const GALLERY_MAX = 25;
export const GALLERY_WEAK_MAX = 9;
export const GALLERY_PHONE = 4;
/** Pages of this many tiles or more receive at most the medium layer (360p, ADR-0066 §4). */
export const GALLERY_MEDIUM_FROM = 16;

export interface TilePerson {
  userId: string;
  /** Publishes a camera the viewer can show (not hidden with «Не показывать видео»). */
  video: boolean;
}

/**
 * Tiles per gallery page from the window size: k×k with k = min(⌊W / 320⌋, ⌊H / 200⌋) within
 * 2…5 — 960×600 → 9, 1440×900 → 16, 1920×1080 and up → 25 (the owner's table, 05.10).
 * «Слабый компьютер» ≤ 9, phones 4 (2×2).
 */
export function galleryPageSize(width: number, height: number, o: { phone?: boolean; weak?: boolean } = {}): number {
  if (o.phone) return GALLERY_PHONE;
  const k = Math.max(2, Math.min(5, Math.floor(width / 320), Math.floor(height / 200)));
  return Math.min(k * k, o.weak ? GALLERY_WEAK_MAX : GALLERY_MAX);
}

/**
 * The gallery order carried from one layout to the next: everyone shown, in page order, the page
 * size it was cut with, and when the last speech swap happened (same clock as `now`).
 */
export interface GallerySlots {
  ids: readonly string[];
  size: number;
  swappedAt: number;
  /**
   * userId → the speech start already seen on screen (their tile was on the page then). Such a
   * speech never promotes anyone later — e.g. after flipping from page 2 back to page 1.
   */
  seen: ReadonlyMap<string, number>;
}

export const NO_SLOTS: GallerySlots = { ids: [], size: 0, swappedAt: Number.NEGATIVE_INFINITY, seen: new Map() };

export interface GalleryOpts {
  /** Pinned («Закрепить»): first on page 1. */
  pinned: string | null;
  me?: string;
  /** «Скрыть себя». */
  hideSelf?: boolean;
  /** «Скрыть участников без видео» (a pinned tile stays). */
  hideNoVideo?: boolean;
  /** Tiles per page (galleryPageSize). */
  size: number;
  /** The page the viewer is on, 0-based (clamped to the pages there are). */
  page: number;
  /** userId → when they last started speaking (lib/lastSpoke.ts); missing = never. */
  spoke?: ReadonlyMap<string, number>;
  /** The previous layout's slots: visible tiles keep their places. */
  prev?: GallerySlots;
  now?: number;
}

export interface Gallery {
  /** Tiles of the current page, in grid order. */
  tiles: TilePerson[];
  /** The current page (clamped), 0-based. */
  page: number;
  pages: number;
  /** Pass back as `prev` next time; also says which page anyone is on (pageOf). */
  slots: GallerySlots;
  /** A speech swap is due but rate-limited: lay out again at this time. */
  retryAt: number | null;
}

const NO_SPOKE: ReadonlyMap<string, number> = new Map();

/**
 * Everyone the view shows: minus me with «Скрыть себя», minus people without video with «Скрыть
 * участников без видео»; the pinned one always. «Без видео» never empties the view while someone
 * else is in the call (nobody has a camera left: their avatars show). Only me with «Скрыть себя»
 * stays empty on purpose — the «Вы» badge shows me again.
 */
export function visiblePeople(people: readonly TilePerson[], pinned: string | null, o: { me?: string; hideSelf?: boolean; hideNoVideo?: boolean }): TilePerson[] {
  const self = (p: TilePerson): boolean => o.hideSelf === true && p.userId === o.me;
  const shown = people.filter((p) => p.userId === pinned || !(self(p) || (o.hideNoVideo === true && !p.video)));
  return shown.length > 0 || o.hideNoVideo !== true ? shown : people.filter((p) => !self(p));
}

const present = (id: string | null | undefined): id is string => id !== null && id !== undefined;

/**
 * The gallery's pages (ADR-0066 §1–§2).
 *
 * One page: pinned → me → cameras → the rest, each group in call order — nothing moves on speech.
 *
 * Several pages: pinned → me → recent speakers → cameras before avatars → call order. Then:
 * - page 1 and the page the viewer is on keep their tiles in place between layouts — speech never
 *   moves a visible tile;
 * - someone not on screen who starts speaking takes the page-1 slot of the tile (not pinned, not
 *   mine) silent longest, in place; that tile goes back to the rest. At most one swap per
 *   TILE_SWAP_MS (`retryAt` says when the late one is due);
 * - the other pages are not on screen: re-sorted freely by the same rank.
 * A pin or «Скрыть себя» changes the head of page 1; a resize (another page size) lays out afresh —
 * both are the viewer's own actions.
 */
export function galleryLayout(people: readonly TilePerson[], o: GalleryOpts): Gallery {
  const size = Math.max(1, Math.floor(o.size));
  const prev = o.prev ?? NO_SLOTS;
  const spoke = o.spoke ?? NO_SPOKE;
  const now = o.now ?? 0;
  const join = new Map(people.map((p, i) => [p.userId, i]));
  const pinned = o.pinned !== null && join.has(o.pinned) ? o.pinned : null;
  const shown = visiblePeople(people, pinned, o);
  const byId = new Map(shown.map((p) => [p.userId, p]));
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const page = Math.max(0, Math.min(pages - 1, Math.floor(o.page) || 0));
  const head = [pinned, o.me !== undefined && o.me !== pinned && byId.has(o.me) ? o.me : null].filter(present);
  const isHead = (id: string): boolean => head.includes(id);
  const said = (id: string): number => spoke.get(id) ?? 0;
  const video = (id: string): number => Number(byId.get(id)?.video ?? false);
  const callOrder = (id: string): number => join.get(id) ?? 0;
  let ids: string[];
  let swappedAt = prev.swappedAt;
  let retryAt: number | null = null;
  if (shown.length <= size) {
    const rest = shown
      .map((p) => p.userId)
      .filter((id) => !isHead(id))
      .sort((a, b) => video(b) - video(a) || callOrder(a) - callOrder(b));
    ids = [...head, ...rest];
  } else {
    // Rank of the rest: recent speakers, then cameras, then call order.
    const rank = (a: string, b: string): number => said(b) - said(a) || video(b) - video(a) || callOrder(a) - callOrder(b);
    const cap = Math.max(0, size - head.length);
    // Page 1 as it was (holes where someone left), minus the head.
    const p1: Array<string | null> = prev.ids
      .slice(0, prev.size)
      .filter((id) => !isHead(id))
      .map((id) => (byId.has(id) ? id : null));
    // The page-1 tile silent longest (ties: the lowest-ranked) — the one a speaker replaces.
    const victim = (): number => {
      let at = -1;
      for (let i = 0; i < p1.length; i++) {
        const id = p1[i];
        if (!present(id)) continue;
        const cur = at < 0 ? null : (p1[at] ?? null);
        if (cur === null || said(id) < said(cur) || (said(id) === said(cur) && rank(id, cur) > 0)) at = i;
      }
      return at;
    };
    // Fewer slots than before (a pin, me shown again): holes go first, then the silent.
    while (p1.length > cap) {
      const hole = p1.lastIndexOf(null);
      const at = hole >= 0 ? hole : victim();
      p1.splice(at < 0 ? p1.length - 1 : at, 1);
    }
    const taken = new Set<string>([...head, ...p1.filter(present)]);
    // The page the viewer is on (not page 1, same page size): kept as it was, unless people left
    // so that it can no longer stay where it is.
    let cur: Array<string | null> | null = null;
    if (page > 0 && prev.size === size) {
      const was = prev.ids.slice(page * size, (page + 1) * size).map((id) => (byId.has(id) && !taken.has(id) ? id : null));
      const kept = was.filter(present).length;
      if (kept > 0 && shown.length - kept >= page * size) cur = was;
    }
    for (const id of cur ?? []) if (present(id)) taken.add(id);
    const pool = shown
      .map((p) => p.userId)
      .filter((id) => !taken.has(id))
      .sort(rank);
    // Holes and free slots of page 1 take the best-ranked of the rest.
    for (let i = 0; i < p1.length && pool.length > 0; i++) if (p1[i] === null) p1[i] = pool.shift() ?? null;
    while (p1.length < cap && pool.length > 0) p1.push(pool.shift() ?? null);
    // One speech swap: the most recent speech not seen on screen vs page 1's longest-silent tile.
    const from = pool.findIndex((id) => said(id) > (prev.seen.get(id) ?? 0));
    const speaker = from >= 0 ? pool[from] : undefined;
    const at = victim();
    const out = at >= 0 ? p1[at] : null;
    if (speaker !== undefined && present(out) && said(speaker) > said(out)) {
      if (now - prev.swappedAt >= TILE_SWAP_MS) {
        p1[at] = speaker;
        pool.splice(from, 1);
        pool.push(out);
        pool.sort(rank);
        swappedAt = now;
      } else retryAt = prev.swappedAt + TILE_SWAP_MS;
    }
    ids = [...head, ...p1.filter(present)];
    for (let pg = 1; pg < pages; pg++) {
      if (pg === page && cur) {
        const fixed = cur;
        for (let i = 0; i < fixed.length; i++) if (fixed[i] === null) fixed[i] = pool.shift() ?? null;
        ids.push(...fixed.filter(present));
      } else ids.push(...pool.splice(0, size));
    }
    ids.push(...pool);
  }
  const tiles = ids
    .slice(page * size, (page + 1) * size)
    .map((id) => byId.get(id))
    .filter((p): p is TilePerson => p !== undefined);
  // What is on screen now has been seen speaking up to now.
  let seen = prev.seen;
  for (const t of tiles) {
    const at = said(t.userId);
    if (at > 0 && seen.get(t.userId) !== at) {
      if (seen === prev.seen) seen = new Map(prev.seen);
      (seen as Map<string, number>).set(t.userId, at);
    }
  }
  return { tiles, page, pages, slots: { ids, size, swappedAt, seen }, retryAt };
}

/** The page someone is on in a layout's slots (−1: not shown). */
export function pageOf(slots: GallerySlots, userId: string): number {
  const i = slots.ids.indexOf(userId);
  return i < 0 || slots.size <= 0 ? -1 : Math.floor(i / slots.size);
}

/** Same page, page count and tiles — the grid needn't re-render. */
export function sameGallery(a: Gallery, b: Gallery): boolean {
  return (
    a.page === b.page &&
    a.pages === b.pages &&
    a.tiles.length === b.tiles.length &&
    a.tiles.every((t, i) => {
      const o = b.tiles[i];
      return o !== undefined && t.userId === o.userId && t.video === o.video;
    })
  );
}

export interface SpeakerOpts {
  pinned: string | null;
  active: string | null;
  me?: string;
  hideSelf?: boolean;
  hideNoVideo?: boolean;
}

export interface SpeakerTiles {
  /** The large tile (null: nobody to show). */
  featured: string | null;
  /** The strip: me, cameras, the rest (call order) — speech never reorders it. */
  strip: TilePerson[];
}

/**
 * «Спикер» (ADR-0066 §1): large — the pinned tile, else the active *remote* speaker with a camera
 * (800 ms, lib/activeSpeaker.ts), else the first remote camera, else the active speaker, else the
 * first remote participant, else me. My own camera is never large unless I pin it (Discord /
 * FaceTime: the self-view stays small). Everyone else lines up in the scrollable strip.
 */
export function speakerTiles(people: readonly TilePerson[], o: SpeakerOpts): SpeakerTiles {
  const join = new Map(people.map((p, i) => [p.userId, i]));
  const pinned = o.pinned !== null && join.has(o.pinned) ? o.pinned : null;
  const shown = visiblePeople(people, pinned, o);
  const remote = shown.filter((p) => p.userId !== o.me);
  const cams = remote.filter((p) => p.video);
  const featured =
    pinned ?? cams.find((p) => p.userId === o.active)?.userId ?? cams[0]?.userId ?? remote.find((p) => p.userId === o.active)?.userId ?? remote[0]?.userId ?? shown[0]?.userId ?? null;
  const strip = shown
    .filter((p) => p.userId !== featured)
    .sort((a, b) => Number(b.userId === o.me) - Number(a.userId === o.me) || Number(b.video) - Number(a.video) || (join.get(a.userId) ?? 0) - (join.get(b.userId) ?? 0));
  return { featured, strip };
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

/** Equal 16:9 tiles in a `width × height` area, the column count that makes them largest; rows centred (the last one too). */
export function gridTiles(n: number, width: number, height: number, gap = 8): Rect[] {
  if (n <= 0 || width <= 0 || height <= 0) return [];
  let best = { cols: 1, w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const t = fit((width - gap * (cols - 1)) / cols, (height - gap * (rows - 1)) / rows);
    if (t.w > best.w) best = { cols, ...t };
  }
  const rows = Math.ceil(n / best.cols);
  const top = (height - (rows * best.h + (rows - 1) * gap)) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(best.cols, n - r * best.cols);
    const left = (width - (inRow * best.w + (inRow - 1) * gap)) / 2;
    for (let c = 0; c < inRow; c++) out.push(round({ x: left + c * (best.w + gap), y: top + r * (best.h + gap), w: best.w, h: best.h }));
  }
  return out;
}

export interface SpeakerLayout {
  main: Rect;
  /** The strip's box (scrolls when its tiles don't fit); null without a strip. */
  strip: Rect | null;
  /** The strip runs top to bottom on the right (else left to right underneath). */
  vertical: boolean;
  /** One strip tile. */
  tile: { w: number; h: number };
}

/**
 * «Спикер»: the large tile and a strip of `n` fixed-size 16:9 tiles — on the right in a wide area,
 * underneath otherwise (whichever leaves the larger main tile). A strip shorter than its side is
 * centred along it; a longer one fills it and scrolls.
 */
export function speakerLayout(n: number, width: number, height: number, gap = 8): SpeakerLayout {
  const none = { main: { x: 0, y: 0, w: 0, h: 0 }, strip: null, vertical: false, tile: { w: 0, h: 0 } };
  if (width <= 0 || height <= 0) return none;
  if (n <= 0) {
    const m = fit(width, height);
    return { ...none, main: round({ x: (width - m.w) / 2, y: (height - m.h) / 2, w: m.w, h: m.h }) };
  }
  const side = (): SpeakerLayout => {
    const sw = Math.min(240, Math.max(160, Math.round(width * 0.2)));
    const tile = { w: sw, h: Math.round(sw / ASPECT) };
    const m = fit(width - sw - gap, height);
    const len = Math.min(height, n * tile.h + (n - 1) * gap);
    return {
      main: round({ x: (width - sw - gap - m.w) / 2, y: (height - m.h) / 2, w: m.w, h: m.h }),
      strip: round({ x: width - sw, y: (height - len) / 2, w: sw, h: len }),
      vertical: true,
      tile,
    };
  };
  const below = (): SpeakerLayout => {
    const sh = Math.min(135, Math.max(72, Math.round(height * 0.2)));
    const tile = { w: Math.round(sh * ASPECT), h: sh };
    const m = fit(width, height - sh - gap);
    const len = Math.min(width, n * tile.w + (n - 1) * gap);
    return {
      main: round({ x: (width - m.w) / 2, y: (height - sh - gap - m.h) / 2, w: m.w, h: m.h }),
      strip: round({ x: (width - len) / 2, y: height - sh, w: len, h: sh }),
      vertical: false,
      tile,
    };
  };
  const a = side();
  const b = below();
  // A side that leaves no room has a negative box: its area counts as 0, not (−w)·(−h) > 0.
  const area = (l: SpeakerLayout): number => Math.max(0, l.main.w) * Math.max(0, l.main.h);
  return area(a) >= area(b) ? a : b;
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

import { describe, expect, it } from 'vitest';
import {
  NO_SLOTS,
  TILE_SWAP_MS,
  galleryLayout,
  galleryPageSize,
  gridTiles,
  pageOf,
  pipCamera,
  sameGallery,
  speakerLayout,
  speakerTiles,
  type Gallery,
  type GalleryOpts,
  type Rect,
  type TilePerson,
} from './tileLayout';

const P = (userId: string, video = false): TilePerson => ({ userId, video });

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

/** A tiny seeded PRNG (mulberry32): property tests stay reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('galleryPageSize (owner, 05.10)', () => {
  it('960×600 → 9, 1440×900 → 16, 1920×1080 and up → 25', () => {
    expect(galleryPageSize(960, 600)).toBe(9);
    expect(galleryPageSize(1440, 900)).toBe(16);
    expect(galleryPageSize(1920, 1080)).toBe(25);
    expect(galleryPageSize(2560, 1440)).toBe(25);
    expect(galleryPageSize(1280, 800)).toBe(16);
  });
  it('«слабый компьютер» ≤ 9; phones 4; never below 2×2', () => {
    expect(galleryPageSize(1920, 1080, { weak: true })).toBe(9);
    expect(galleryPageSize(960, 600, { weak: true })).toBe(9);
    expect(galleryPageSize(390, 844, { phone: true })).toBe(4);
    expect(galleryPageSize(500, 300)).toBe(4);
  });
});

/** A call driven by speaking starts and page flips: carries slots and the clock like useGallery. */
function call(people: TilePerson[], o: Partial<GalleryOpts> = {}) {
  const spoke = new Map<string, number>();
  let now = 10_000;
  let page = o.page ?? 0;
  const opts = (): GalleryOpts => ({ pinned: null, size: 9, ...o, page, spoke, now });
  let g: Gallery = galleryLayout(people, { ...opts(), prev: NO_SLOTS });
  const run = (): Gallery => (g = galleryLayout(people, { ...opts(), prev: g.slots }));
  return {
    get g() {
      return g;
    },
    ids: () => g.tiles.map((t) => t.userId),
    page1: () => g.slots.ids.slice(0, g.slots.size),
    speak(id: string, after = 0): Gallery {
      now += after;
      spoke.set(id, now);
      return run();
    },
    wait(ms: number): Gallery {
      now += ms;
      return run();
    },
    go(p: number): Gallery {
      page = p;
      return run();
    },
  };
}

const crowd = (n: number): TilePerson[] => Array.from({ length: n }, (_, i) => P(`u${i}`, i % 3 === 0));

describe('galleryLayout: one page', () => {
  it('pinned → me → cameras → the rest, call order; speech does not reorder', () => {
    const people = [P('a'), P('b', true), P('me'), P('c'), P('d', true)];
    const c = call(people, { me: 'me' });
    expect(c.ids()).toEqual(['me', 'b', 'd', 'a', 'c']);
    c.speak('c', 100);
    c.speak('a', 2000);
    expect(c.ids()).toEqual(['me', 'b', 'd', 'a', 'c']);
    expect(galleryLayout(people, { pinned: 'c', me: 'me', size: 9, page: 0 }).tiles.map((t) => t.userId)).toEqual(['c', 'me', 'b', 'd', 'a']);
    expect(c.g.pages).toBe(1);
  });

  it('«Скрыть себя» and «Скрыть участников без видео»; the pinned tile stays', () => {
    const people = [P('a'), P('b', true), P('me', true), P('c')];
    expect(galleryLayout(people, { pinned: null, me: 'me', hideSelf: true, size: 9, page: 0 }).tiles.map((t) => t.userId)).toEqual(['b', 'a', 'c']);
    expect(galleryLayout(people, { pinned: null, me: 'me', hideNoVideo: true, size: 9, page: 0 }).tiles.map((t) => t.userId)).toEqual(['me', 'b']);
    expect(galleryLayout(people, { pinned: 'c', me: 'me', hideSelf: true, hideNoVideo: true, size: 9, page: 0 }).tiles.map((t) => t.userId)).toEqual(['c', 'b']);
  });

  it('a pin on someone who left is ignored; the page is clamped', () => {
    const g = galleryLayout([P('a', true)], { pinned: 'gone', size: 9, page: 4 });
    expect(g.tiles.map((t) => t.userId)).toEqual(['a']);
    expect(g.page).toBe(0);
  });
});

describe('galleryLayout: pages (ADR-0066 §1–§2)', () => {
  it('first layout: pinned → me → recent speakers → cameras → call order; no «Ещё N» — every tile is real', () => {
    const people = crowd(20);
    const spoke = new Map([
      ['u7', 500],
      ['u4', 900],
    ]);
    const g = galleryLayout(people, { pinned: 'u19', me: 'u5', size: 9, page: 0, spoke });
    expect(g.pages).toBe(3);
    expect(g.tiles.map((t) => t.userId)).toEqual(['u19', 'u5', 'u4', 'u7', 'u0', 'u3', 'u6', 'u9', 'u12']);
    expect(g.slots.ids).toHaveLength(20);
    expect(new Set(g.slots.ids).size).toBe(20);
    const last = galleryLayout(people, { pinned: 'u19', me: 'u5', size: 9, page: 2, spoke, prev: g.slots });
    expect(last.tiles).toHaveLength(2);
  });

  it('a hidden speaker takes the page-1 slot of the tile silent longest, in place', () => {
    const c = call(crowd(20));
    const before = c.ids();
    for (const id of before.slice(0, 4)) c.speak(id, 100);
    expect(c.ids()).toEqual(before); // visible people talking moves nothing
    c.speak('u19', 2000);
    const after = c.ids();
    const changed = after.filter((id, i) => id !== before[i]);
    expect(changed).toEqual(['u19']);
    // The replaced one never spoke and ranks lowest of page 1.
    expect(before.slice(4)).toContain(before[after.indexOf('u19')]);
  });

  it('at most one swap per 1.5 s; the late one lands once the window passes', () => {
    const c = call(crowd(20));
    c.speak('u19', 2000);
    expect(c.ids()).toContain('u19');
    const g = c.speak('u17', 200);
    expect(c.ids()).not.toContain('u17');
    expect(g.retryAt).not.toBeNull();
    c.wait(TILE_SWAP_MS - 200);
    expect(c.ids()).toContain('u17');
    expect(c.ids()).toContain('u19'); // the newer speaker is not the one replaced
  });

  it('on page 2: its tiles never move on speech; a speaker from page 3 goes to page 1', () => {
    const c = call(crowd(25));
    c.go(1);
    const page2 = c.ids();
    for (const id of page2) c.speak(id, 2000);
    expect(c.ids()).toEqual(page2);
    const third = c.g.slots.ids.slice(18);
    const p1 = c.page1();
    const who = third[0] as string;
    c.speak(who, 2000);
    expect(c.ids()).toEqual(page2);
    expect(c.page1()).toContain(who);
    expect(c.page1().filter((id, i) => id !== p1[i])).toEqual([who]);
    expect(pageOf(c.g.slots, who)).toBe(0);
  });

  it('pinned and my tile always lead page 1 and are never replaced by a speaker', () => {
    const c = call(crowd(20), { pinned: 'u17', me: 'u5' });
    expect(c.ids().slice(0, 2)).toEqual(['u17', 'u5']);
    for (const id of ['u1', 'u2', 'u4', 'u8', 'u10', 'u11', 'u13']) c.speak(id, 2000);
    expect(c.ids().slice(0, 2)).toEqual(['u17', 'u5']);
  });

  it('someone leaving frees a slot in place for the best-ranked of the rest', () => {
    const people = crowd(20);
    const c = call(people);
    c.speak('u19', 2000);
    const before = c.ids();
    const gone = before[3] as string;
    const g = galleryLayout(
      people.filter((p) => p.userId !== gone),
      { pinned: null, size: 9, page: 0, spoke: new Map([['u19', 12_000]]), prev: c.g.slots, now: 12_100 },
    );
    const after = g.tiles.map((t) => t.userId);
    expect(after).toHaveLength(9);
    after.forEach((id, i) => {
      if (i !== 3) expect(id).toBe(before[i]);
    });
    expect(after[3]).not.toBe(gone);
  });

  it('property: a permutation of everyone shown; visible tiles never move on speech; a hidden speaker reaches page 1', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const n = 10 + Math.floor(r() * 40);
      const size = [4, 9, 16, 25][Math.floor(r() * 4)] as number;
      const people = Array.from({ length: n }, (_, i) => P(`p${i}`, r() < 0.4));
      const me = r() < 0.5 ? `p${Math.floor(r() * n)}` : undefined;
      const pinned = r() < 0.3 ? `p${Math.floor(r() * n)}` : null;
      const c = call(people, { me, pinned, size });
      for (let step = 0; step < 80; step++) {
        const tag = `seed ${seed} step ${step}`;
        const g = c.g;
        expect([...g.slots.ids].sort(), tag).toEqual(people.map((p) => p.userId).sort());
        if (pinned) expect(g.slots.ids[0], tag).toBe(pinned);
        if (me && me !== pinned) expect(g.slots.ids[pinned ? 1 : 0], tag).toBe(me);
        const roll = r();
        if (roll < 0.15) {
          c.go(Math.floor(r() * g.pages));
          continue;
        }
        const visible = c.ids();
        const p1 = c.page1();
        if (roll < 0.6) {
          const id = visible[Math.floor(r() * visible.length)] as string;
          c.speak(id, Math.floor(r() * 3000));
          expect(c.ids(), tag).toEqual(visible);
        } else {
          const hidden = g.slots.ids.filter((id) => !visible.includes(id) && !p1.includes(id));
          if (hidden.length === 0) continue;
          const id = hidden[Math.floor(r() * hidden.length)] as string;
          c.speak(id, TILE_SWAP_MS + Math.floor(r() * 1000));
          expect(c.page1(), tag).toContain(id);
          // Page 1 changed in exactly one slot, in place; the page on screen (if not page 1) not at all.
          expect(c.page1().filter((x, i) => x !== p1[i]), tag).toEqual([id]);
          if (c.g.page > 0) expect(c.ids(), tag).toEqual(visible);
        }
      }
    }
  });

  it('rerenders: a speaking start changes the grid state only when the page on screen changes', () => {
    // useGallery keeps the previous state when sameGallery() holds: count real changes.
    const c = call(crowd(30));
    let renders = 0;
    let swaps = 0;
    const r = rng(7);
    for (let step = 0; step < 300; step++) {
      const before = c.g;
      const pool = r() < 0.7 ? before.tiles.map((t) => t.userId) : before.slots.ids;
      const id = pool[Math.floor(r() * pool.length)] as string;
      const after = c.speak(id, Math.floor(r() * 2000));
      if (!sameGallery(before, after)) renders++;
      if (after.tiles.map((t) => t.userId).join() !== before.tiles.map((t) => t.userId).join()) swaps++;
    }
    expect(renders).toBe(swaps);
    expect(swaps).toBeGreaterThan(0);
    expect(swaps).toBeLessThan(150);
  });

  it('speech seen on page 2 does not promote anyone after flipping back to page 1', () => {
    const c = call(crowd(25));
    c.go(1);
    const who = c.ids()[0] as string;
    c.speak(who, 2000);
    const p1 = c.go(0).tiles.map((t) => t.userId);
    expect(p1).not.toContain(who);
    expect(c.wait(TILE_SWAP_MS * 2).tiles.map((t) => t.userId)).toEqual(p1);
    // A new speech of theirs, not seen: they come forward.
    c.speak(who, 100);
    expect(c.ids()).toContain(who);
  });

  it('a page flip back returns the same page', () => {
    const c = call(crowd(30));
    const p2 = c.go(1).tiles.map((t) => t.userId);
    c.go(2);
    expect(c.go(1).tiles.map((t) => t.userId)).toEqual(p2);
  });

  it('pageOf', () => {
    const g = galleryLayout(crowd(20), { pinned: null, size: 9, page: 0 });
    expect(pageOf(g.slots, g.slots.ids[0] as string)).toBe(0);
    expect(pageOf(g.slots, g.slots.ids[19] as string)).toBe(2);
    expect(pageOf(g.slots, 'nobody')).toBe(-1);
  });
});

describe('speakerTiles', () => {
  it('large: pinned, else the active remote camera, else the first remote camera; never my camera by default', () => {
    const people = [P('me', true), P('a', true), P('b', true), P('c')];
    expect(speakerTiles(people, { pinned: null, active: 'b', me: 'me' }).featured).toBe('b');
    expect(speakerTiles(people, { pinned: null, active: 'me', me: 'me' }).featured).toBe('a');
    expect(speakerTiles(people, { pinned: null, active: 'c', me: 'me' }).featured).toBe('a');
    expect(speakerTiles(people, { pinned: 'me', active: null, me: 'me' }).featured).toBe('me');
    expect(speakerTiles([P('me', true), P('c')], { pinned: null, active: 'c', me: 'me' }).featured).toBe('c');
  });

  it('strip: me, cameras, the rest in call order — without the large tile', () => {
    const people = [P('a'), P('b', true), P('me'), P('c', true), P('d')];
    const s = speakerTiles(people, { pinned: null, active: null, me: 'me' });
    expect(s.featured).toBe('b');
    expect(s.strip.map((t) => t.userId)).toEqual(['me', 'c', 'a', 'd']);
    expect(speakerTiles(people, { pinned: null, active: null, me: 'me', hideSelf: true, hideNoVideo: true }).strip.map((t) => t.userId)).toEqual(['c']);
  });
});

describe('gridTiles', () => {
  it('one tile fills the area at 16:9; 4 in a square area as 2×2', () => {
    expect(gridTiles(1, 1600, 900)).toEqual([{ x: 0, y: 0, w: 1600, h: 900 }]);
    const four = gridTiles(4, 1000, 1000, 8);
    expect(new Set(four.map((r) => r.y)).size).toBe(2);
    expect(new Set(four.map((r) => r.x)).size).toBe(2);
  });

  it('tiles never overlap and stay inside the area, up to 25', () => {
    for (let n = 1; n <= 25; n++) {
      for (const [w, h] of [
        [636, 380],
        [1096, 680],
        [1576, 860],
        [366, 600],
      ] as const) {
        const rects = gridTiles(n, w, h, 8);
        expect(rects).toHaveLength(n);
        rects.forEach((a, i) => {
          expect(inside(a, w, h), `n=${n} ${w}×${h} #${i}`).toBe(true);
          expect(Math.abs(a.w / a.h - 16 / 9)).toBeLessThan(0.05);
          rects.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false));
        });
      }
    }
  });

  it('empty area → no tiles', () => {
    expect(gridTiles(3, 0, 500)).toEqual([]);
    expect(gridTiles(0, 500, 500)).toEqual([]);
  });
});

describe('speakerLayout', () => {
  it('strip on the right in a wide area, underneath in a tall one; the main tile is the largest', () => {
    for (const [w, h, vertical] of [
      [1600, 600, true],
      [700, 900, false],
    ] as const) {
      const l = speakerLayout(3, w, h, 8);
      expect(l.vertical).toBe(vertical);
      expect(l.strip).not.toBeNull();
      expect(l.main.w * l.main.h).toBeGreaterThan(l.tile.w * l.tile.h);
      expect(inside(l.main, w, h)).toBe(true);
      if (l.strip) {
        expect(inside(l.strip, w, h)).toBe(true);
        expect(overlaps(l.main, l.strip)).toBe(false);
      }
    }
  });

  it('a long strip fills its side (and scrolls); a short one is centred', () => {
    const long = speakerLayout(30, 1600, 600, 8);
    expect(long.strip?.h).toBe(600);
    const short = speakerLayout(2, 1600, 600, 8);
    expect(short.strip?.h).toBeLessThan(600);
    expect(short.strip?.y).toBeGreaterThan(0);
  });

  it('no strip: the main tile alone, centred', () => {
    const l = speakerLayout(0, 1600, 600, 8);
    expect(l.strip).toBeNull();
    expect(l.main.h).toBe(600);
  });
});

describe('pipCamera', () => {
  it('the active remote speaker, else the first remote camera, else me', () => {
    expect(pipCamera(['me', 'a', 'b'], 'me', 'b')).toBe('b');
    expect(pipCamera(['me', 'a', 'b'], 'me', 'me')).toBe('a');
    expect(pipCamera(['me', 'a'], 'me', 'gone')).toBe('a');
    expect(pipCamera(['me'], 'me', null)).toBe('me');
    expect(pipCamera([], 'me', null)).toBeNull();
  });
});

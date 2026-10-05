import { describe, expect, it } from 'vitest';
import { NO_SLOTS, TILE_SWAP_MS, layoutTiles, pipCamera, sameSelection, selectTiles, type Rect, type TileSelection, type TilePerson } from './tileLayout';

const P = (userId: string, video = false): TilePerson => ({ userId, video });

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

describe('selectTiles', () => {
  it('stable order: cameras first, then call order — speech does not reorder', () => {
    const s = selectTiles([P('a'), P('b', true), P('c'), P('d', true)], { focused: null, active: 'c' });
    expect(s.tiles.map((t) => t.userId)).toEqual(['b', 'd', 'a', 'c']);
    expect(s.overflow).toBe(0);
  });

  it('my own camera is never large by default, only when I click it', () => {
    const people = [P('me', true), P('b', true), P('c')];
    expect(selectTiles(people, { focused: null, active: 'me', me: 'me' }).featured).toBe('b');
    expect(selectTiles([P('me', true), P('b'), P('c')], { focused: null, active: null, me: 'me' }).featured).toBeNull();
    expect(selectTiles(people, { focused: 'me', active: null, me: 'me' }).featured).toBe('me');
  });

  it('features the active speaker if they show video, else the first remote camera (≥ 3 tiles)', () => {
    const people = [P('a', true), P('b', true), P('c')];
    expect(selectTiles(people, { focused: null, active: 'b' }).featured).toBe('b');
    expect(selectTiles(people, { focused: null, active: 'b' }).tiles[0]?.userId).toBe('b');
    // c talks but has no camera: the first camera stays large.
    expect(selectTiles(people, { focused: null, active: 'c' }).featured).toBe('a');
  });

  it('no featured tile for 1–2 tiles unless one is clicked', () => {
    expect(selectTiles([P('a', true), P('b')], { focused: null, active: 'b' }).featured).toBeNull();
    const s = selectTiles([P('a', true), P('b')], { focused: 'b', active: null });
    expect(s.featured).toBe('b');
    expect(s.tiles.map((t) => t.userId)).toEqual(['b', 'a']);
  });

  it('a focus on someone who left is ignored', () => {
    expect(selectTiles([P('a', true)], { focused: 'gone', active: null }).featured).toBeNull();
  });

  it('caps at 6 tiles: 5 people + «+N»', () => {
    const people = Array.from({ length: 9 }, (_, i) => P(`u${i}`, i < 2));
    const s = selectTiles(people, { focused: null, active: null });
    expect(s.tiles).toHaveLength(5);
    expect(s.overflow).toBe(4);
    expect(s.tiles.slice(0, 2).every((t) => t.video)).toBe(true);
    expect(selectTiles(people.slice(0, 6), { focused: null, active: null })).toMatchObject({ overflow: 0 });
  });
});

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

/** A call driven by speaking starts: carries slots and the clock like the grid does. */
function call(people: TilePerson[], opts: { focused?: string | null; me?: string } = {}) {
  const spoke = new Map<string, number>();
  let now = 10_000;
  let sel: TileSelection = selectTiles(people, { focused: opts.focused ?? null, active: null, me: opts.me, spoke, prev: NO_SLOTS, now });
  const run = (): TileSelection => (sel = selectTiles(people, { focused: opts.focused ?? null, active: null, me: opts.me, spoke, prev: sel.slots, now }));
  return {
    get sel() {
      return sel;
    },
    ids: () => sel.tiles.map((t) => t.userId),
    speak(id: string, after = 0): TileSelection {
      now += after;
      spoke.set(id, now);
      return run();
    },
    wait(ms: number): TileSelection {
      now += ms;
      return run();
    },
  };
}

describe('selectTiles with overflow: speakers come forward (ADR-0066 §2)', () => {
  const nine = (): TilePerson[] => Array.from({ length: 9 }, (_, i) => P(`u${i}`, i % 3 === 0));

  it('a hidden speaker takes the slot of the tile silent longest, in place', () => {
    const c = call(nine());
    const before = c.ids();
    expect(before).toEqual(['u0', 'u3', 'u6', 'u1', 'u2']); // cameras first, then call order
    c.speak('u0', 100);
    c.speak('u3', 100);
    c.speak('u6', 100);
    c.speak('u2', 100);
    expect(c.ids()).toEqual(before); // visible people talking moves nothing
    c.speak('u8', 2000);
    const after = c.ids();
    expect(after).toEqual(['u0', 'u3', 'u6', 'u8', 'u2']); // u1 never spoke: replaced in place
    expect(c.sel.hidden).toEqual(['u1', 'u4', 'u5', 'u7']);
    expect(c.sel.overflow).toBe(4);
  });

  it('at most one swap per 1.5 s; the late one lands once the window passes', () => {
    const c = call(nine());
    c.speak('u8', 2000);
    expect(c.ids()).toContain('u8');
    const sel = c.speak('u7', 200);
    expect(c.ids()).not.toContain('u7');
    expect(sel.retryAt).not.toBeNull();
    c.wait(TILE_SWAP_MS - 200);
    expect(c.ids()).toContain('u7');
    expect(c.ids()).toContain('u8'); // the newer speaker is not the one replaced
  });

  it('pinned and my tile always stay; they are never replaced by a speaker', () => {
    const c = call(nine(), { focused: 'u7', me: 'u5' });
    expect(c.ids()).toContain('u7');
    expect(c.ids()).toContain('u5');
    expect(c.sel.featured).toBe('u7');
    for (const id of ['u1', 'u2', 'u4', 'u8']) c.speak(id, 2000);
    expect(c.ids()).toContain('u7');
    expect(c.ids()).toContain('u5');
    expect(c.ids()[0]).toBe('u7');
  });

  it('property: speech of a visible participant never reorders visible tiles; a hidden speaker becomes visible', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const n = 7 + Math.floor(r() * 12);
      const people = Array.from({ length: n }, (_, i) => P(`p${i}`, r() < 0.4));
      const me = r() < 0.5 ? `p${Math.floor(r() * n)}` : undefined;
      const c = call(people, { me });
      for (let step = 0; step < 60; step++) {
        const visible = c.ids();
        const slots = [...c.sel.slots.ids];
        const hidden = c.sel.hidden;
        if (r() < 0.6 || hidden.length === 0) {
          const id = visible[Math.floor(r() * visible.length)] as string;
          c.speak(id, Math.floor(r() * 3000));
          expect(c.ids(), `seed ${seed} step ${step}`).toEqual(visible);
        } else {
          const id = hidden[Math.floor(r() * hidden.length)] as string;
          c.speak(id, TILE_SWAP_MS + Math.floor(r() * 1000));
          expect(c.ids(), `seed ${seed} step ${step}`).toContain(id);
          // Exactly one slot changed, and it changed in place (the large tile may then change:
          // a replaced first camera hands «large» to the next one).
          const changed = c.sel.slots.ids.filter((x, i) => x !== slots[i]);
          expect(changed).toEqual([id]);
          if (me) expect(c.ids()).toContain(me);
        }
        expect(c.ids().length + c.sel.overflow).toBe(n);
      }
    }
  });

  it('someone leaving frees a slot for the most recent hidden speaker', () => {
    const people = nine();
    const c = call(people);
    c.speak('u7', 100); // swapped in for the longest-silent tile
    c.speak('u8', 100); // rate-limited: stays hidden for now
    expect(c.ids()).not.toContain('u8');
    const left = people.filter((p) => p.userId !== 'u3');
    const sel = selectTiles(left, { focused: null, active: null, spoke: new Map([['u7', 10_100], ['u8', 10_200]]), prev: c.sel.slots, now: 10_300 });
    expect(sel.tiles.map((t) => t.userId)).toContain('u8');
    expect(sel.tiles).toHaveLength(5);
  });

  it('rerenders: a speaking start changes the grid state only when the visible set changes', () => {
    // useTileSelection keeps the previous state when sameSelection() holds: count real changes.
    const c = call(nine());
    let renders = 0;
    let swaps = 0;
    const r = rng(7);
    for (let step = 0; step < 200; step++) {
      const before = c.sel;
      const pool = r() < 0.8 ? before.tiles.map((t) => t.userId) : before.hidden;
      const id = pool[Math.floor(r() * pool.length)] as string;
      const after = c.speak(id, Math.floor(r() * 2000));
      if (!sameSelection(before, after)) renders++;
      // A swap (now, or a rate-limited one landing on this run) — the only reason to re-render.
      if (after.tiles.map((t) => t.userId).join() !== before.tiles.map((t) => t.userId).join()) swaps++;
    }
    expect(renders).toBe(swaps);
    expect(swaps).toBeGreaterThan(0);
  });

  it('sameSelection ignores the clock, sees tiles, the large one and the hidden list', () => {
    const people = nine();
    const a = selectTiles(people, { focused: null, active: null, now: 1 });
    expect(sameSelection(a, selectTiles(people, { focused: null, active: null, prev: a.slots, now: 5 }))).toBe(true);
    expect(sameSelection(a, selectTiles(people, { focused: 'u8', active: null, prev: a.slots, now: 5 }))).toBe(false);
  });
});

describe('layoutTiles', () => {
  it('one tile fills the area at 16:9', () => {
    expect(layoutTiles(1, false, 1600, 900)).toEqual([{ x: 0, y: 0, w: 1600, h: 900 }]);
    const [r] = layoutTiles(1, true, 1000, 900);
    expect(r).toMatchObject({ w: 1000, h: 563 });
  });

  it('equal grid: 2 side by side in a wide area, 4 as 2×2 in a square one', () => {
    const two = layoutTiles(2, false, 1200, 400, 8);
    expect(two[0]?.y).toBe(two[1]?.y);
    expect(two[0]?.w).toBe(two[1]?.w);
    const four = layoutTiles(4, false, 1000, 1000, 8);
    expect(new Set(four.map((r) => r.y)).size).toBe(2);
    expect(new Set(four.map((r) => r.x)).size).toBe(2);
  });

  it('featured tile is the largest; the strip sits right in a very wide area, below otherwise', () => {
    for (const [w, h, right] of [
      [1600, 500, true],
      [845, 620, false],
      [700, 900, false],
    ] as const) {
      const rects = layoutTiles(3, true, w, h, 8);
      const [main, ...rest] = rects;
      if (!main) throw new Error('no tiles');
      for (const r of rest) expect(r.w * r.h).toBeLessThan(main.w * main.h);
      if (right) for (const r of rest) expect(r.x).toBeGreaterThanOrEqual(main.x + main.w);
      else for (const r of rest) expect(r.y).toBeGreaterThanOrEqual(main.y + main.h);
    }
  });

  it('the featured layout uses the height: main tile ≥ 70 % of a 845×620 area height', () => {
    const [main] = layoutTiles(3, true, 845, 620, 8);
    expect(main?.h ?? 0).toBeGreaterThanOrEqual(0.7 * 620);
  });

  it('tiles never overlap and stay inside the area, for every count and shape', () => {
    for (let n = 1; n <= 6; n++) {
      for (const featured of [false, true]) {
        for (const [w, h] of [
          [960, 420],
          [1440, 640],
          [600, 800],
          [320, 180],
        ] as const) {
          const rects = layoutTiles(n, featured, w, h, 8);
          expect(rects).toHaveLength(n);
          rects.forEach((a, i) => {
            expect(inside(a, w, h), `n=${n} f=${featured} ${w}×${h} #${i}`).toBe(true);
            expect(Math.abs(a.w / a.h - 16 / 9)).toBeLessThan(0.02);
            rects.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false));
          });
        }
      }
    }
  });

  it('empty area → no tiles', () => {
    expect(layoutTiles(3, false, 0, 500)).toEqual([]);
    expect(layoutTiles(0, false, 500, 500)).toEqual([]);
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

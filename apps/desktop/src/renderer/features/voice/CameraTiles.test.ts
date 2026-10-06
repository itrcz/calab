import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn(), app: { log: () => undefined } } }));
// The engine (LiveKit) is not needed to render a tile without video.
vi.mock('../../services/voice', () => ({
  voice: { primaryCamera: () => null, cameraTrack: () => null, showCamera: () => () => undefined, focusTile: () => undefined },
}));

// The member menu as in the app — the real Radix trigger around the tile — without its stores
// (server rendering would read their initial, empty state and skip the menu).
vi.mock('../people/MemberContextMenu', async () => {
  const { createElement: h } = await import('react');
  const ContextMenu = await import('@radix-ui/react-context-menu');
  return {
    MemberContextMenu: ({ children }: { children: ReactElement }) => h(ContextMenu.Root, { modal: false }, h(ContextMenu.Trigger, { asChild: true }, children)),
  };
});
// A clock hook without a server snapshot; irrelevant to the tile box.
vi.mock('./JustJoinedDot', () => ({ JustJoinedDot: () => null }));

import { MemberTile } from './CameraTiles';

const WS = 'ws1';

const tile = (extra: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(MemberTile, { userId: 'nikolay', wsId: WS, video: false, featured: false, avatarSize: 48, ...extra }));

describe('MemberTile position (2.4.1: empty gallery / empty large tile)', () => {
  it('keeps its gallery position inside the member menu trigger (the trigger injects its own style)', () => {
    const html = tile({ x: 10, y: 20, w: 320, h: 180 });
    expect(html).toContain('data-testid="video-tile"');
    expect(html).toMatch(/style="[^"]*left:10px;top:20px;width:320px;height:180px/);
    // The trigger's own style survives too (no iOS callout on long press).
    expect(html).toMatch(/style="[^"]*-webkit-touch-callout:none/);
  });

  it('a strip tile (positioned by class) has no inline box', () => {
    expect(tile({ className: 'inset-0' })).not.toMatch(/style="[^"]*left:/);
  });
});

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { contextWorkspace, currentSection, rememberSection, type WsSection } from '../lib/sections';
import { useBoardsUi } from './boardsUi';
import { HOME } from './dms';
import { useUi } from './ui';
import { useWorkspaces } from './workspaces';

/**
 * The desktop rail's memory (ADR-0074 §1): the section each workspace was left on and the last
 * workspace used — what «Чаты» / «Календарь» / «Доски» return to from «Личные». Persisted; written
 * by watching the state that already decides the content (no second source of truth), so every
 * entry point (⌘K, a board link, a reminder) is remembered too.
 */
interface SectionsState {
  of: Readonly<Record<string, WsSection>>;
  lastWs: string | null;
}

export const useSections = create<SectionsState>()(
  persist((): SectionsState => ({ of: {}, lastWs: null }), { name: 'calaba-sections', version: 1 }),
);

function record(): void {
  const ui = useUi.getState();
  const ws = ui.activeWorkspaceId;
  if (!ws || ws === HOME) return;
  const section = currentSection({ home: false, boards: useBoardsUi.getState().active, calendar: ui.calDay !== null });
  if (section === null || section === 'dms') return;
  const s = useSections.getState();
  const of = rememberSection(s.of, ws, section);
  if (of !== s.of || s.lastWs !== ws) useSections.setState({ of, lastWs: ws });
}

// Once per synchronous batch: a navigation flips several flags in a row (openRoom turns the boards
// off before it switches the workspace) — only the state it ends in is remembered.
let queued = false;
function schedule(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    record();
  });
}

useUi.subscribe((s, prev) => {
  if (s.activeWorkspaceId !== prev.activeWorkspaceId || (s.calDay === null) !== (prev.calDay === null)) schedule();
});
useBoardsUi.subscribe((s, prev) => {
  if (s.active !== prev.active) schedule();
});

/** The workspace the sections work in (see lib/sections `contextWorkspace`); for selectors and actions. */
export function contextWorkspaceNow(): string | null {
  const ws = useWorkspaces.getState();
  return contextWorkspace(useUi.getState().activeWorkspaceId, useSections.getState().lastWs, HOME, ws.order, (id) => !!ws.byId[id]);
}

/** The same as a hook: a string (or null) — a re-render only when the workspace itself changes. */
export function useContextWorkspace(): string | null {
  const active = useUi((s) => s.activeWorkspaceId);
  const last = useSections((s) => s.lastWs);
  return useWorkspaces((s) => contextWorkspace(active, last, HOME, s.order, (id) => !!s.byId[id]));
}

import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { WorkspaceRole, wikiPermissions } from '@calaba/protocol';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { canWrite, dropPlan, zoneAt } from '../../lib/wiki/tree';
import { movePage, openWiki } from '../../services/wiki';
import { myUserId } from '../../stores/session';
import { useWiki } from '../../stores/wiki';
import { TREE_MAX, TREE_MIN, useWikiUi } from '../../stores/wikiUi';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { WikiDialogs } from './Dialogs';
import { preloadWikiDoc } from './lazy';
import { WikiMain } from './WikiPage';
import { DragChip, useWikiDrag, WikiTree } from './WikiTree';

/**
 * «Вики» on the desktop (ADR-0096 §9, docs/08 «Вики»): one panel in place of the column and the
 * centre — the tree column (resizable 220–360 px) and the open page. Mounted only while the
 * section is open: a hidden section holds no subscriptions, no timers and no sync socket.
 */
export function WikiScreen({ workspaceId }: { workspaceId: string }): ReactNode {
  const roles = useMemberRoles(workspaceId, myUserId());
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  const canCreate = canWrite(wikiPermissions(roles, { guest }));
  const width = useWikiUi((s) => s.treeWidth);

  useEffect(() => {
    void openWiki(workspaceId);
    preloadWikiDoc();
  }, [workspaceId]);

  // Tree rows dragged with the mouse (6 px): before / inside / after the row under the pointer.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<string | null>(null);
  const zoneOf = (e: DragMoveEvent | DragEndEvent) => {
    const over = e.over;
    const id = (over?.data.current as { pageId?: string } | undefined)?.pageId;
    const start = e.activatorEvent as PointerEvent | null;
    if (!over || !id || !start || id === String(e.active.id)) return null;
    return {
      id,
      zone: zoneAt(start.clientY + e.delta.y, over.rect.top, over.rect.height),
    };
  };
  const onDragStart = (e: DragStartEvent): void => setDragged(String(e.active.id));
  const onDragMove = (e: DragMoveEvent): void => {
    const z = zoneOf(e);
    useWikiDrag.getState().set(z?.id ?? null, z?.zone ?? null);
  };
  const onDragEnd = (e: DragEndEvent): void => {
    setDragged(null);
    useWikiDrag.getState().set(null, null);
    const z = zoneOf(e);
    if (!z) return;
    const plan = dropPlan(useWiki.getState(), String(e.active.id), z.id, z.zone);
    if (plan) void movePage(String(e.active.id), plan.parentId, plan.position);
  };
  const onDragCancel = (): void => {
    setDragged(null);
    useWikiDrag.getState().set(null, null);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <section className="mat-content relative flex min-w-0 flex-1" aria-label={t('wiki.section')} data-testid="wiki">
        <aside className="flex shrink-0 flex-col border-r border-line" style={{ width }} data-testid="wiki-column">
          <WikiTree workspaceId={workspaceId} canCreate={canCreate} />
        </aside>
        <TreeResize />
        <WikiMain workspaceId={workspaceId} canCreate={canCreate} />
        <WikiDialogs workspaceId={workspaceId} />
      </section>
      {createPortal(<DragOverlay dropAnimation={null}>{dragged ? <DragChip id={dragged} /> : null}</DragOverlay>, document.body)}
    </DndContext>
  );
}

/** The tree column's edge: drag or ←/→ (persisted, 220–360 px). */
function TreeResize(): ReactNode {
  const start = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number): void => useWikiUi.getState().setTreeWidth(w);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.resize')}
      aria-valuemin={TREE_MIN}
      aria-valuemax={TREE_MAX}
      aria-valuenow={useWikiUi.getState().treeWidth}
      tabIndex={0}
      onKeyDown={(e) => {
        const w = useWikiUi.getState().treeWidth;
        if (e.key === 'ArrowLeft') set(w - 8);
        if (e.key === 'ArrowRight') set(w + 8);
      }}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        start.current = { x: e.clientX, w: useWikiUi.getState().treeWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current) set(start.current.w + e.clientX - start.current.x);
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      className="relative z-[var(--z-sticky)] -ml-[3px] -mr-[3px] w-[6px] shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:left-[2.5px] after:w-px hover:after:bg-accent focus-visible:after:bg-accent"
      data-testid="wiki-resize"
    />
  );
}

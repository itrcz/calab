import { DndContext, DragOverlay, PointerSensor, useDraggable, useSensor, useSensors, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { ExternalLink, Pencil, Plus, RotateCw, Trash2 } from 'lucide-react';
import { memo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { confirmAction } from '../../components/Confirm';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayManageIntegrations } from '../../lib/permissions';
import { appDropAt } from '../../lib/webApps';
import { platform } from '../../platform';
import { deleteWebApp, moveWebApp, openAppInBrowser, openWebApp } from '../../services/webApps';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useWebApps, useWorkspaceAppIds } from '../../stores/webApps';
import { useMemberRoles } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { AppGlyph } from './AppGlyph';

/** 32 px tile: the workspace squircle scaled down — radius 11 → 8 on hover / open (docs/08 «Рейл»). */
const tile =
  'relative grid size-8 place-items-center rounded-[11px] transition-[border-radius] duration-[var(--motion)] ease-out hover:rounded-[8px]';

/** May I manage the web apps of the workspace (MANAGE_INTEGRATIONS, ADR-0048 / ADR-0050 §1)? */
function useManageApps(wsId: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return mayManageIntegrations(useMemberRoles(wsId, me));
}

/**
 * The web apps of a workspace in the rail (ADR-0050 §3), under its icon — only for the active
 * workspace: 32 px icons with the name as a tooltip, drag to reorder, right click for the menu,
 * and a small «+» (24 px, muted) for MANAGE_INTEGRATIONS. Subscribes by workspace id, so switching
 * workspaces re-renders two columns, not the rail.
 */
export function WorkspaceAppsColumn({ wsId, lead }: { wsId: string; lead?: ReactNode }): ReactNode {
  const active = useUi((s) => s.activeWorkspaceId === wsId);
  const ids = useWorkspaceAppIds(wsId);
  const manage = useManageApps(wsId);
  if (!active || (!ids.length && !manage)) return null;
  return (
    <>
      {lead}
      <AppList wsId={wsId} ids={ids} manage={manage} />
    </>
  );
}

function AppList({ wsId, ids, manage }: { wsId: string; ids: string[]; manage: boolean }): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  // 6 px before a drag starts: a click stays a click (as rooms and shelves).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<string | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const target = useRef<number | null>(null);
  const startY = useRef(0);
  const open = useUi((s) => s.openDialog);

  const measure = (id: string, y: number): void => {
    const el = listRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const slots = [...el.querySelectorAll<HTMLElement>('[data-app-slot]')].map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.dataset['appSlot'] ?? '', top: r.top - box.top, bottom: r.bottom - box.top };
    });
    const drop = appDropAt(slots, y - box.top, id);
    target.current = drop?.index ?? null;
    setLine(drop ? drop.lineY : null);
  };
  const reset = (): void => {
    setDragged(null);
    setLine(null);
    target.current = null;
  };
  const onStart = (e: DragStartEvent): void => {
    setDragged(String(e.active.id));
    startY.current = (e.activatorEvent as PointerEvent).clientY;
  };
  const onMove = (e: DragMoveEvent): void => measure(String(e.active.id), startY.current + e.delta.y);
  const onEnd = (): void => {
    const d = dragged;
    const to = target.current;
    reset();
    if (d && to !== null) void moveWebApp(wsId, d, to);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={reset}>
      <div ref={listRef} className="relative flex w-full shrink-0 flex-col items-center gap-1.5" role="list" aria-label={t('wapp.list')} data-testid="rail-apps">
        {ids.map((id) => (
          <AppIcon key={id} id={id} manage={manage} />
        ))}
        {line !== null ? (
          <div aria-hidden className="pointer-events-none absolute left-1/2 z-10 h-0.5 w-8 -translate-x-1/2 rounded-full bg-accent" style={{ top: line - 1 }} data-testid="rail-apps-drop-line" />
        ) : null}
        {manage ? (
          // A list item itself (axe: a role=list holds only listitems).
          <div role="listitem" className="flex">
          <Tip label={ids.length >= 20 ? t('wapp.limit') : t('wapp.add')} side="right">
            <button
              type="button"
              aria-label={t('wapp.add')}
              disabled={ids.length >= 20}
              onClick={() => open({ kind: 'web-app', workspaceId: wsId })}
              className="grid size-6 place-items-center rounded-[8px] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg disabled:opacity-40"
              data-testid="rail-app-add"
            >
              <Plus className="size-4" strokeWidth={2} />
            </button>
          </Tip>
          </div>
        ) : null}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>{dragged ? <DragGhost id={dragged} /> : null}</DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function DragGhost({ id }: { id: string }): ReactNode {
  const a = useWebApps((s) => s.byId[id]);
  if (!a) return null;
  return (
    <div className="size-8 overflow-hidden rounded-[8px] shadow-[var(--shadow-popover)]">
      <AppGlyph id={a.id} name={a.name} iconFileId={a.iconFileId} size={32} />
    </div>
  );
}

const AppIcon = memo(function AppIcon({ id, manage }: { id: string; manage: boolean }): ReactNode {
  const a = useWebApps((s) => s.byId[id]);
  const isOpen = useWebApps((s) => s.open === id);
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id, disabled: !manage });
  if (!a) return null;
  return (
    <div className="group relative flex w-full shrink-0 justify-center" role="listitem" data-app-slot={id}>
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg transition-[height,opacity] duration-[var(--motion)] ease-out',
          isOpen ? 'h-6' : 'h-0 opacity-0 group-hover:h-3 group-hover:opacity-100',
        )}
      />
      <AppMenu id={id} name={a.name} url={a.url} workspaceId={a.workspaceId} manage={manage}>
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          // dnd-kit's role/description are for sortable lists; keep a plain button for screen readers.
          role={undefined}
          aria-roledescription={undefined}
          aria-describedby={undefined}
          // Nor its tabindex / aria-disabled: a tabindex makes WebKit focus the tile on a tap, that
          // wakes the lazy Tip (components/ui) mid-tap and the click is lost (a phone opened nothing);
          // aria-disabled would announce a member's tiles as unavailable. A button is focusable as is.
          tabIndex={undefined}
          aria-disabled={undefined}
          onClick={() => openWebApp(id)}
          aria-current={isOpen ? 'page' : undefined}
          aria-label={a.name}
          className={cx(tile, isOpen && 'rounded-[8px]', isDragging && 'opacity-40')}
          data-testid="rail-app"
        >
          <AppGlyph id={a.id} name={a.name} iconFileId={a.iconFileId} size={32} />
        </button>
      </AppMenu>
    </div>
  );
});

/** Right click on an app icon: «Изменить / Открыть в браузере / Перезагрузить / Удалить» (managing items by the right). */
function AppMenu({ id, name, url, workspaceId, manage, children }: { id: string; name: string; url: string; workspaceId: string; manage: boolean; children: ReactNode }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const reload = (): void => {
    openWebApp(id);
    // The screen reloads the page once it shows this app (features/webapps/AppScreen).
    useWebApps.getState().bumpReload();
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('wapp.deleteTitle', { name }), t('wapp.deleteConfirm'), t('wapp.delete')))) return;
    try {
      await deleteWebApp(id);
    } catch (e) {
      toast.fail(e, t('wapp.delete'));
    }
  };
  return (
    <ContextMenu.Root modal={false}>
      <Tip label={name} side="right">
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      </Tip>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox} collisionPadding={8}>
          {manage ? (
            <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'web-app', workspaceId, appId: id })}>
              <Pencil className="size-4" aria-hidden /> {t('wapp.edit')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className={menuItem} onSelect={() => openAppInBrowser(url)}>
            <ExternalLink className="size-4" aria-hidden /> {platform.kind === 'web' ? t('wapp.openInNewTab') : t('wapp.openInBrowser')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={reload}>
            <RotateCw className="size-4" aria-hidden /> {t('wapp.reload')}
          </ContextMenu.Item>
          {manage ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                <Trash2 className="size-4" aria-hidden /> {t('wapp.delete')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

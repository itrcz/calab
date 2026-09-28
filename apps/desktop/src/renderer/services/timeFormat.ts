import { TimeFormat } from '@calaba/protocol';
import { setTimeFormat, type TimeFormatPref } from '../lib/format';
import { HOME } from '../stores/dms';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';

/** Workspace.time_format → the formatter's clock format (UNSPECIFIED: an older server — auto). */
export function toTimeFormatPref(f: TimeFormat | undefined): TimeFormatPref {
  if (f === TimeFormat.H24) return 'h24';
  if (f === TimeFormat.H12) return 'h12';
  return 'auto';
}

/** The formatter's clock format → Workspace.time_format (settings). */
export function fromTimeFormatPref(p: TimeFormatPref): TimeFormat {
  if (p === 'h24') return TimeFormat.H24;
  if (p === 'h12') return TimeFormat.H12;
  return TimeFormat.AUTO;
}

/** The workspace whose format applies: the open one; in «Личные» (DMs) the last one opened. */
let lastWorkspace: string | null = null;

function currentWorkspace(): string | null {
  const active = useUi.getState().activeWorkspaceId;
  const { byId, order } = useWorkspaces.getState();
  if (active && active !== HOME && byId[active]) {
    lastWorkspace = active;
    return active;
  }
  if (lastWorkspace && byId[lastWorkspace]) return lastWorkspace;
  return order.find((id) => byId[id]) ?? null;
}

/** Recomputes the clock format (docs/09 #73): the current workspace's, outside any — auto. */
export function syncTimeFormat(): void {
  const id = currentWorkspace();
  setTimeFormat(id ? toTimeFormatPref(useWorkspaces.getState().byId[id]?.ws.timeFormat) : 'auto');
}

let installed: (() => void) | null = null;

/**
 * Keeps `fmt`'s clock format on the current workspace's: a workspace switch, READY and
 * WORKSPACE_UPDATE (the store's entry changes) apply it live. `setTimeFormat` ignores an unchanged
 * value, so frequent store updates (presence, voice) re-render nothing.
 */
export function installTimeFormat(): () => void {
  if (installed) return installed;
  syncTimeFormat();
  const offUi = useUi.subscribe((s, prev) => {
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) syncTimeFormat();
  });
  const offWs = useWorkspaces.subscribe((s, prev) => {
    if (s.byId !== prev.byId || s.order !== prev.order) syncTimeFormat();
  });
  installed = () => {
    offUi();
    offWs();
    installed = null;
    lastWorkspace = null;
  };
  return installed;
}

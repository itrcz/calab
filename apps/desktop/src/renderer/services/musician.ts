import type { WorkspacePlan } from '@calaba/protocol';
import { t } from '../i18n';
import { outputKind, outputLabel } from '../lib/media/outputKind';
import { planHas } from '../lib/plan';
import { prefs, usePrefs } from '../stores/prefs';
import { toast, useToasts } from '../stores/toasts';
import { useVoice } from '../stores/voice';
import { useWorkspaces } from '../stores/workspaces';
import { planToast } from './plan';

/**
 * «Режим музыканта» (ADR-0052): the switch, its plan gate and its echo warning.
 *
 * - Plan: Team and above (`PlanLimits.musician_disabled` on Free). In voice — the plan of the
 *   room's workspace; in a one-to-one call (no workspace) or outside voice — any of my
 *   workspaces. The server refuses the flag anyway (409 PLAN_LIMIT); the UI shows the switch
 *   locked (PlanLock), never hidden.
 * - Warning: turning it on warns that headphones are needed; if the output device looks like
 *   loudspeakers, the stronger warning (sticky, with «Выключить режим музыканта»).
 * The capture / Opus profile follow the pref in services/voice.ts (onPrefs → onMusicianMode).
 */

type Plans = Readonly<Record<string, { ws: { plan?: WorkspacePlan | undefined } }>>;

/** Is musician mode part of the plan for voice in `workspaceId` ('' / null: a call or no voice — any workspace)? */
export function musicianAllowedFor(byId: Plans, workspaceId: string | null): boolean {
  if (workspaceId) return planHas(byId[workspaceId]?.ws.plan, 'musician');
  const all = Object.values(byId);
  return all.length === 0 || all.some((w) => planHas(w.ws.plan, 'musician'));
}

export const musicianAllowed = (): boolean => musicianAllowedFor(useWorkspaces.getState().byId, useVoice.getState().workspaceId);

/** The same, reactive: a boolean selector (re-renders only when the answer flips). */
export function useMusicianAllowed(): boolean {
  const ws = useVoice((s) => s.workspaceId);
  return useWorkspaces((s) => musicianAllowedFor(s.byId, ws));
}

export interface MusicianWarning {
  strong: boolean;
  text: string;
}

/** The warning for an output device label (empty = unknown → the regular headphones warning). */
export function musicianWarning(label: string): MusicianWarning {
  if (outputKind(label) === 'speakers') return { strong: true, text: t('music.warnSpeakers', { device: label }) };
  return { strong: false, text: t('music.warnHeadphones') };
}

/** «Доступно на тарифе Team и выше» with «Связаться» (a click on the locked switch / menu item). */
export function musicianLockedToast(): void {
  planToast(t('plan.lockedFrom', { plan: t('plan.name.team') }));
}

/** Quick toggle (voice panel «…»): sets the pref and, when turning on, warns with a toast. Locked by the plan → the plan toast. */
export function setMusicianMode(on: boolean): void {
  // A native-audio join on iPhone (ADR-0149): not in v1, the reason instead.
  if (on && useVoice.getState().audioOnly) {
    toast.info(t('music.audioOnly'));
    return;
  }
  if (on && !musicianAllowed()) {
    musicianLockedToast();
    return;
  }
  usePrefs.getState().setPrefs({ musicianMode: on });
  if (on) void warn();
}

async function warn(): Promise<void> {
  let label = '';
  try {
    label = outputLabel(await navigator.mediaDevices.enumerateDevices(), prefs().outputDeviceId);
  } catch {
    // No device list (web without permission): the regular warning.
  }
  const w = musicianWarning(label);
  const toasts = useToasts.getState();
  if (w.strong) toasts.push('error', w.text, { label: t('music.turnOff'), run: () => setMusicianMode(false) });
  else toasts.push('info', w.text, undefined, 10_000);
}

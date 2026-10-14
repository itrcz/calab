import { WorkspaceRole, type PermissionBits, type Room } from '@calaba/protocol';
import { Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { can } from '../../lib/permissions';
import { isVoicePreview, joinOutcome } from '../../lib/voiceEntry';
import { voice } from '../../services/voice';
import { toast } from '../../stores/toasts';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';

/** People in `roomId`'s voice and how many of them have a camera on, as one primitive. */
function countKey(s: ReturnType<typeof useWorkspaces.getState>, workspaceId: string, roomId: string): string {
  let people = 0;
  let cameras = 0;
  for (const v of Object.values(s.byId[workspaceId]?.voice ?? {})) {
    if (v.roomId !== roomId) continue;
    people++;
    if (v.camera) cameras++;
  }
  return `${people}:${cameras}`;
}

/**
 * «Идёт видеовстреча · 4 камеры · Войти и смотреть» (ADR-0066 §3) over a voice room's chat read
 * without being in its voice, while someone there has a camera on. «Войти и смотреть» joins
 * (the same rules as «Войти в голос», lib/voiceEntry.ts) and opens the call view, not the PiP.
 * Watching without joining the voice is not offered (owner, 05.10). Counts come from the voice
 * states (VoiceState.camera) as one primitive: other voice changes do not re-render it.
 */
export function MeetingBanner({ workspaceId, room, perms }: { workspaceId: string; room: Room; perms: PermissionBits }): ReactNode {
  useLocale();
  const preview = useVoice((s) => isVoicePreview(room, s.roomId));
  const key = useWorkspaces((s) => countKey(s, workspaceId, room.id));
  const suspended = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.suspension);
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  const [people = 0, cameras = 0] = key.split(':').map(Number);
  if (!preview || cameras === 0) return null;
  const canConnect = can(perms, 'CONNECT');
  const join = (): void => {
    const next = joinOutcome({ inRoom: false, canConnect, owner, people, limit: room.userLimit });
    if (next === 'full') toast.info(t('shell.roomFull'));
    else if (next === 'join') void voice.join(room.id, workspaceId, { video: true });
  };
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-body" data-testid="video-meeting-banner">
      <Video className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg">{t('video.meeting')}</span>
        <span className="text-muted"> · {plural('video.meetingCameras', cameras)}</span>
      </span>
      {canConnect ? (
        <Button size="sm" onClick={join} disabled={suspended} title={suspended ? t('suspended.voice') : undefined} data-testid="video-meeting-join">
          {t('video.meetingJoin')}
        </Button>
      ) : null}
    </div>
  );
}

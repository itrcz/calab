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

/** People in `roomId`'s voice, how many of them have a camera on and how many share a screen, as one primitive. */
function countKey(s: ReturnType<typeof useWorkspaces.getState>, workspaceId: string, roomId: string): string {
  let people = 0;
  let cameras = 0;
  let screens = 0;
  for (const v of Object.values(s.byId[workspaceId]?.voice ?? {})) {
    if (v.roomId !== roomId) continue;
    people++;
    if (v.camera) cameras++;
    if (v.streaming) screens++;
  }
  return `${people}:${cameras}:${screens}`;
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
  // In this room on a native-audio join (iPhone, ADR-0149 §3) whose companion video gave up: the reason.
  const videoDown = useVoice((s) => s.audioOnly && s.videoDown && s.roomId === room.id);
  const key = useWorkspaces((s) => countKey(s, workspaceId, room.id));
  const suspended = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.suspension);
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  const [people = 0, cameras = 0, screens = 0] = key.split(':').map(Number);
  if (videoDown) {
    if (cameras + screens === 0) return null;
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-1.5 text-body" role="status" data-testid="video-audio-only">
        <Video className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-muted">{t('video.audioOnlyRoom')}</span>
      </div>
    );
  }
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

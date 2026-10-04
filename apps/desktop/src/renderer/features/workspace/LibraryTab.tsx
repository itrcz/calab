import { useState, type ReactNode } from 'react';
import { Segmented } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { useLibraryUi } from '../../stores/libraryUi';
import { AchievementsTab } from './AchievementsTab';
import { BackgroundsTab } from './BackgroundsTab';
import { BadgesTab } from './BadgesTab';
import { pickSegment, type LibrarySegment } from './library';
import { SoundsTab } from './SoundsTab';
import { StickersTab } from './StickersTab';

export const SEGMENT_LABEL: Record<LibrarySegment, MessageKey> = {
  achievements: 'ach.cat.tab',
  badges: 'badges.tab',
  stickers: 'stk.tab',
  sounds: 'snd.tab',
  backgrounds: 'wsbg.tab',
};

/**
 * «Настройки пространства → Библиотека» (docs/08): the segmented switch on top, the chosen
 * library below (the former tabs, unchanged). `segments` = the ones my rights allow (library.ts);
 * `requested` = a deep link's segment (the former tab ids). The last one is remembered per workspace.
 */
export function LibraryTab({ workspaceId, segments, requested }: { workspaceId: string; segments: readonly LibrarySegment[]; requested: LibrarySegment | undefined }): ReactNode {
  const remembered = useLibraryUi((s) => s.segment[workspaceId]);
  // The deep link counts once (on open); later the switch and the remembered choice decide.
  const [chosen, setChosen] = useState<LibrarySegment | undefined>(() => pickSegment(segments, requested, remembered));
  const current = pickSegment(segments, chosen, remembered);
  const choose = (s: LibrarySegment): void => {
    setChosen(s);
    useLibraryUi.getState().setSegment(workspaceId, s);
  };
  if (!current) return null;
  return (
    <>
      {segments.length > 1 ? (
        <div className="-mx-1 overflow-x-auto px-1" data-testid="library-switch">
          <Segmented<LibrarySegment> label={t('ws.tabLibrary')} value={current} onChange={choose} options={segments.map((s) => ({ value: s, label: t(SEGMENT_LABEL[s]) }))} />
        </div>
      ) : null}
      {current === 'achievements' ? (
        <AchievementsTab workspaceId={workspaceId} />
      ) : current === 'badges' ? (
        <BadgesTab workspaceId={workspaceId} />
      ) : current === 'stickers' ? (
        <StickersTab workspaceId={workspaceId} />
      ) : current === 'sounds' ? (
        <SoundsTab workspaceId={workspaceId} />
      ) : (
        <BackgroundsTab workspaceId={workspaceId} />
      )}
    </>
  );
}

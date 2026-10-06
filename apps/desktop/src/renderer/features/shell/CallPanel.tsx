import type { ReactNode } from 'react';
import { MeetingRecordPrompt } from '../calendar/RoomEvent';
import { VoiceBar } from './VoiceBar';

/**
 * The call panel (docs/08 «Панель звонка», owner 07.10): at the foot of the desktop sidebar column
 * (Чаты, Личные), flush with a hairline on top, in the flow — the list ends above it, nothing
 * floats over the rows (the old floating island is gone). Only in a
 * call: «Голос подключён», the room, noise suppression and hang-up, then mic ▾ · sound ▾ ·
 * camera ▾ · screen · sounds · more. My profile, status and the pre-call mic / sound defaults live
 * in the rail's avatar menu (RailProfile). Without a call both children render nothing and the
 * card collapses (`empty:hidden`) — VoiceBar stays mounted for its visual-test hooks.
 * `data-island`: the noise popover opens to the right of this card.
 */
export function CallPanel(): ReactNode {
  return (
    <div
      data-island
      data-testid="call-panel"
      className="flex shrink-0 flex-col divide-y divide-line border-t border-line empty:hidden"
    >
      <MeetingRecordPrompt />
      <VoiceBar />
    </div>
  );
}

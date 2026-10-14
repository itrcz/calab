import type { Board } from '@calaba/protocol';
import type { SummaryCtx } from '../../lib/boards/ruleSummary';
import { useRooms } from '../../stores/rooms';
import { memberName } from '../../stores/workspaces';

/** Names for a rule summary from the board (statuses, labels) and the stores (people, rooms). */
export function summaryCtx(board: Pick<Board, 'statuses' | 'labels'> | undefined, workspaceId: string): SummaryCtx {
  return {
    status: (id) => board?.statuses.find((s) => s.id === id)?.name,
    label: (id) => board?.labels.find((l) => l.id === id)?.name,
    user: (id) => memberName(workspaceId, id),
    room: (id) => useRooms.getState().byId[id]?.name,
  };
}

import { beforeEach, describe, expect, it } from 'vitest';
import { useBoardsUi } from './boardsUi';

describe('boardsUi task vs board navigation', () => {
  beforeEach(() => useBoardsUi.setState({ active: false, boardOf: {}, taskId: null, panelWide: false }));

  it('switching to another board closes the open task', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'b1');
    ui.openTask('t1');
    ui.setPanelWide(true);
    ui.openBoard('w', 'b2');
    expect(useBoardsUi.getState().taskId).toBeNull();
    expect(useBoardsUi.getState().panelWide).toBe(false);
  });

  it('re-opening the same board keeps the task; openTask after openBoard sticks', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'b1');
    ui.openTask('t1');
    ui.openBoard('w', 'b1');
    expect(useBoardsUi.getState().taskId).toBe('t1');
    ui.openBoard('w', 'b2');
    ui.openTask('t2');
    expect(useBoardsUi.getState().taskId).toBe('t2');
  });
});

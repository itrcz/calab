// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MY_TASKS, useBoardsUi } from '../../stores/boardsUi';
import { showBoard } from './BoardsList';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));
vi.mock('../../services/boards', () => ({ openBoard: (ws: string, id: string) => useBoardsUi.getState().openBoard(ws, id) }));

describe('sidebar board click with a task open (CBF-32)', () => {
  beforeEach(() => useBoardsUi.setState({ active: false, boardOf: {}, taskId: null }));

  it('another board: its list shows, the task is closed', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'a');
    ui.openTask('t1');
    showBoard('w', 'doc');
    expect(useBoardsUi.getState().boardOf['w']).toBe('doc');
    expect(useBoardsUi.getState().taskId).toBeNull();
  });

  it('a task of another board over the current one: clicking the current board closes it', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'doc');
    ui.openTask('t-of-board-a');
    showBoard('w', 'doc');
    expect(useBoardsUi.getState().taskId).toBeNull();
  });

  it('«Мои задачи» closes a task open over it', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', MY_TASKS);
    ui.openTask('t1');
    showBoard('w', MY_TASKS);
    expect(useBoardsUi.getState().taskId).toBeNull();
  });
});

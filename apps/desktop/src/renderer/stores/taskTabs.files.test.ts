import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TABS, reduceActivate, reduceOpenFile, sanitizeTabs, useTaskTabs, type TabsState, type TaskTab } from './taskTabs';

const task = (id: string, at = 1): TaskTab => ({ id, ws: 'w', board: 'b', key: `K-${id}`, title: `Task ${id}`, at });
const file = (id: string, at = 1): TaskTab => ({ id: `f:${id}`, ws: 'w', board: '', key: 'XLSX', title: `${id}.xlsx`, kind: 'file', itemId: id, at });
const ids = (s: TabsState): string[] => s.tabs.map((x) => x.id);

describe('file tabs share the strip with the task tabs (ADR-0143)', () => {
  it('opening a file appends a tab, a second open of the same file only activates it', () => {
    let s: TabsState = { tabs: [task('a')], cur: 'a' };
    s = reduceOpenFile(s, file('x'));
    expect(ids(s)).toEqual(['a', 'f:x']);
    expect(s.cur).toBe('a');
    s = reduceOpenFile(s, file('x', 9));
    expect(ids(s)).toEqual(['a', 'f:x']);
    expect(s.tabs[1]?.at).toBe(9);
  });

  it('a plain task open never replaces a file tab', () => {
    const s = reduceActivate({ tabs: [file('x'), task('a')], cur: 'f:x' }, task('b'));
    expect(ids(s)).toEqual(['f:x', 'a']);
  });

  it('holds at most MAX_TABS in total; the oldest other tab goes quietly', () => {
    let s: TabsState = { tabs: Array.from({ length: MAX_TABS }, (_, i) => (i % 2 ? file(`f${i}`, i + 1) : task(`t${i}`, i + 1))), cur: null };
    s = reduceOpenFile(s, file('new', 100));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(ids(s)).toContain('f:new');
    expect(ids(s)).not.toContain('t0');
  });

  it('stored tabs: a file tab needs exactly a source, old task tabs keep working', () => {
    const s = sanitizeTabs({
      tabs: [
        { id: 'a', ws: 'w', board: 'b', key: 'K-1', title: 'T', at: 1 },
        { id: 'f:x', ws: 'w', board: '', key: 'XLSX', title: 'x.xlsx', kind: 'file', itemId: 'x', at: 2 },
        { id: 'f:file:y', ws: 'w', board: '', key: 'DOCX', title: 'y.docx', kind: 'file', fileId: 'y', at: 3 },
        { id: 'f:none', ws: 'w', board: '', kind: 'file' },
      ],
    });
    expect(ids(s)).toEqual(['a', 'f:x', 'f:file:y']);
    expect(s.tabs[0]?.kind).toBeUndefined();
  });
});

describe('file view state (the editor lives only while its view does)', () => {
  const reset = (): void => void useTaskTabs.setState({ tabs: [], cur: null, fileActive: null, fileMounted: null, fileMark: {}, fileClosing: null });
  afterEach(reset);

  it('open mounts the editor and shows the tab; leaving hides the view but keeps the editor until it is gone', () => {
    reset();
    const st = useTaskTabs.getState();
    st.openFile(file('x'));
    expect(useTaskTabs.getState()).toMatchObject({ fileActive: 'f:x', fileMounted: 'f:x' });
    useTaskTabs.getState().leaveFile();
    expect(useTaskTabs.getState()).toMatchObject({ fileActive: null, fileMounted: 'f:x' });
    useTaskTabs.getState().editorGone('f:x');
    expect(useTaskTabs.getState().fileMounted).toBeNull();
    expect(ids(useTaskTabs.getState())).toEqual(['f:x']);
  });

  it('opening another file waits for the first editor to go, then mounts the second', () => {
    reset();
    useTaskTabs.getState().openFile(file('x'));
    useTaskTabs.getState().openFile(file('y'));
    expect(useTaskTabs.getState()).toMatchObject({ fileActive: 'f:y', fileMounted: 'f:x' });
    useTaskTabs.getState().editorGone('f:x');
    expect(useTaskTabs.getState().fileMounted).toBe('f:y');
  });

  it('closing the active tab ends the view and unmounts; a dirty mark follows the tab', () => {
    reset();
    useTaskTabs.getState().openFile(file('x'));
    useTaskTabs.getState().setFileMark('f:x', 'dirty');
    expect(useTaskTabs.getState().fileMark).toEqual({ 'f:x': 'dirty' });
    useTaskTabs.getState().removeFile('f:x');
    expect(useTaskTabs.getState()).toMatchObject({ tabs: [], fileActive: null, fileMounted: null, fileMark: {} });
  });

  it('a mark set to what it is does not touch the store (no render for nothing)', () => {
    reset();
    useTaskTabs.getState().setFileMark('f:x', 'dirty');
    const before = useTaskTabs.getState().fileMark;
    useTaskTabs.getState().setFileMark('f:x', 'dirty');
    expect(useTaskTabs.getState().fileMark).toBe(before);
  });
});

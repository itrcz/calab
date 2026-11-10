import { describe, expect, it } from 'vitest';
import { parseQuery } from '../../lib/memberSearch';
import { buildRows, filterItems, matchItem, moveActive, navCount, normalize, rowOfNav, type PickerGroup, type PickerItem } from './pickerModel';

const item = (id: string, ...search: string[]): PickerItem => ({ id, search });

describe('picker search', () => {
  it('ignores case, accents and ё', () => {
    expect(normalize('  Ёлка ')).toBe('елка');
    expect(normalize('José')).toBe('jose');
    expect(matchItem(item('a', 'Фёдор'), parseQuery('ФЕД'))?.rank).toBe(1);
  });

  it('matches any field: name, nickname, email', () => {
    const anna = item('anna', 'Аня', 'Анна Петрова', 'anna@calab.io');
    expect(matchItem(anna, parseQuery('петров'))?.rank).toBe(2);
    expect(matchItem(anna, parseQuery('calab'))?.rank).toBe(2);
    expect(matchItem(anna, parseQuery('етр'))?.rank).toBe(3);
    expect(matchItem(anna, parseQuery('борис'))).toBeNull();
  });

  it('puts prefix matches first, keeps the original order within a rank', () => {
    const list = [item('1', 'Мария Вера'), item('2', 'Вера'), item('3', 'Аверин'), item('4', 'Вероника')];
    expect(filterItems(list, 'вер').map((i) => i.id)).toEqual(['2', '4', '1', '3']);
    expect(filterItems(list, '').map((i) => i.id)).toEqual(['1', '2', '3', '4']);
  });
});

describe('picker groups', () => {
  const groups: Array<PickerGroup<PickerItem>> = [
    { id: 'roles', label: 'Роли', items: [{ ...item('owner', 'Владелец'), disabled: true }, item('member', 'Участник')] },
    { id: 'people', label: 'Участники', items: [item('anna', 'Анна'), item('boris', 'Борис')] },
  ];

  it('shows headers when two groups have rows; disabled rows are skipped by the keyboard', () => {
    const rows = buildRows(groups, '');
    expect(rows.map((r) => (r.kind === 'header' ? `#${r.label}` : `${r.item.id}:${r.nav}`))).toEqual([
      '#Роли',
      'owner:-1',
      'member:0',
      '#Участники',
      'anna:1',
      'boris:2',
    ]);
    expect(navCount(rows)).toBe(3);
    expect(rowOfNav(rows, 1)).toBe(4);
  });

  it('drops empty groups and the lone header', () => {
    const rows = buildRows(groups, 'бор');
    expect(rows.map((r) => r.key)).toEqual(['people:boris']);
    expect(buildRows(groups, 'бор', { alwaysHeaders: true })[0]).toMatchObject({ kind: 'header', label: 'Участники' });
    expect(buildRows(groups, 'zzz')).toEqual([]);
  });

  it('does not filter again a server answer', () => {
    const rows = buildRows(groups, 'zzz', { serverFiltered: true });
    expect(navCount(rows)).toBe(3);
  });
});

describe('picker keyboard', () => {
  it('moves with arrows and pages, clamped, no wrap', () => {
    expect(moveActive(0, 3, 'ArrowDown')).toBe(1);
    expect(moveActive(2, 3, 'ArrowDown')).toBe(2);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(0);
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(1, 20, 'PageDown')).toBe(9);
    expect(moveActive(3, 20, 'PageUp')).toBe(0);
    expect(moveActive(5, 20, 'End')).toBe(19);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1);
  });
});

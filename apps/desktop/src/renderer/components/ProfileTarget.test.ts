import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.fn<(ws: string, id: string) => void>();
type State = { byId: Record<string, { members: Record<string, { user?: object }> }> };
const state: State = { byId: { w1: { members: { u1: { user: { id: 'u1' } } } } } };
vi.mock('../features/people/actions', () => ({ openProfile: (ws: string, id: string) => open(ws, id) }));
vi.mock('../stores/workspaces', () => ({ useWorkspaces: (sel: (s: State) => unknown) => sel(state) }));
vi.mock('../stores/ui', () => ({ useUi: (sel: (s: { activeWorkspaceId: string }) => unknown) => sel({ activeWorkspaceId: 'w1' }) }));
import { ProfileTarget, openProfileFromClick } from './ProfileTarget';

const html = (userId: string, tabbable = false): string => renderToStaticMarkup(createElement(ProfileTarget, { userId, name: 'Анна', tabbable, children: 'child' }));

describe('ProfileTarget', () => {
  beforeEach(() => open.mockClear());

  it('is a real button with the accessible name and data for the shared handler', () => {
    const out = html('u1');
    expect(out).toMatch(/^<button type="button" tabindex="-1" aria-label="Открыть профиль Анна"/);
    expect(out).toContain('data-profile-ws="w1"');
    expect(out).toContain('data-profile-user="u1"');
    expect(out).toContain('cursor-pointer');
    expect(html('u1', true)).toContain('tabindex="0"');
  });

  it('renders the children as they are for a person without a profile (no dead button)', () => {
    expect(html('ghost')).toBe('child');
    expect(html('')).toBe('child');
  });

  it('click opens the profile once and does not propagate to the row (Enter / Space fire the same click)', () => {
    const stopPropagation = vi.fn();
    openProfileFromClick({ stopPropagation, currentTarget: { dataset: { profileWs: 'w1', profileUser: 'u1' } } as unknown as HTMLElement });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('w1', 'u1');
  });

  it('a target without data does nothing but still stops the click', () => {
    const stopPropagation = vi.fn();
    openProfileFromClick({ stopPropagation, currentTarget: { dataset: {} } as unknown as HTMLElement });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});

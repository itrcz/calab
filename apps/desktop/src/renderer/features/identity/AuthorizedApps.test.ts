import { create } from '@bufbuild/protobuf';
import { ListOAuthGrantsResponseSchema, OAuthGrantSchema, Plan, WorkspacePlanSchema, WorkspaceSchema } from '@calaba/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));
const grants = vi.fn(() => new Promise(() => undefined));
vi.mock('./api', () => ({ identityApi: { grants } }));
// Heavy app wiring the settings screen does not use here (session, voice, the auth screen).
vi.mock('../../services/session', () => ({ beginSession: vi.fn(), retryConnect: vi.fn() }));
vi.mock('../auth/AuthScreen', () => ({ AuthScreen: () => null }));
// Server rendering reads a zustand store's initial state: the selector runs on this one instead.
const workspaces: { byId: Record<string, unknown> } = { byId: {} };
vi.mock('../../stores/workspaces', () => ({ useWorkspaces: (sel: (s: typeof workspaces) => unknown) => sel(workspaces) }));

const { AuthorizedApps } = await import('./OAuth');
const { useSession } = await import('../../stores/session');
const { IdentityNotConfigured } = await import('./IdentityGate');

const withPlan = (plan: Plan): void => {
  workspaces.byId = { w1: { ws: create(WorkspaceSchema, { id: 'w1', plan: create(WorkspacePlanSchema, { plan }) }) } };
};
const html = (): string =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AuthorizedApps)));

// Regression (2.0.1): «OAuth-приложения» made a request that failed (503) on every install.
describe('Settings → «OAuth-приложения»', () => {
  beforeEach(() => {
    grants.mockClear();
  });

  it('below Business with no active grant: the plan lock over a description', () => {
    withPlan(Plan.TEAM);
    const h = html();
    expect(h).toContain('data-testid="oauth-grants-lock"');
    expect(h).toContain('Доступно на тарифе Business');
    expect(h).toContain('OAuth-приложения');
  });

  it('below Business but with an active grant (on-prem Enterprise is entitled on any plan): the list, no lock', () => {
    withPlan(Plan.FREE);
    const client = new QueryClient();
    client.setQueryData(['oauth-grants', useSession.getState().sessionId], create(ListOAuthGrantsResponseSchema, { grants: [create(OAuthGrantSchema, { id: 'g1' })] }));
    const h = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AuthorizedApps)));
    expect(h).not.toContain('oauth-grants-lock');
    expect(h).not.toContain('oauth-grants-empty');
  });

  it('a Business workspace: the list is loaded, no lock', () => {
    withPlan(Plan.ENTERPRISE);
    const h = html();
    expect(h).not.toContain('oauth-grants-lock');
    expect(h).toContain('OAuth-приложения');
  });

  it('a server without identity configuration: a calm notice, not an error', () => {
    const h = renderToStaticMarkup(createElement(IdentityNotConfigured));
    expect(h).toContain('data-testid="identity-not-configured"');
    expect(h).not.toContain('role="alert"');
  });
});

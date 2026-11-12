import { describe, expect, it } from 'vitest';
import { mcpClientSnippets, mcpConnectHandle, mcpReturnTarget, mcpServerUrl, mcpSessionClient, settingsRouteSection } from './model';

const handle = 'calab_mr_' + 'a'.repeat(43);

describe('mcpConnectHandle', () => {
  it('reads the handle from the fragment of /mcp/connect', () => {
    expect(mcpConnectHandle(`https://app.calab.io/mcp/connect#${handle}`)).toBe(handle);
  });
  it('refuses other paths and malformed handles', () => {
    expect(mcpConnectHandle(`https://app.calab.io/oauth/consent#${handle}`)).toBeNull();
    expect(mcpConnectHandle('https://app.calab.io/mcp/connect#calab_mr_short')).toBeNull();
    expect(mcpConnectHandle(`https://app.calab.io/mcp/connect?request=${handle}`)).toBeNull();
  });
});

describe('mcpReturnTarget', () => {
  it('names the port of a loopback redirect and the host otherwise', () => {
    expect(
      mcpReturnTarget({
        redirectUri: 'http://127.0.0.1:33418/callback',
        loopback: true,
      }),
    ).toEqual({ local: true, where: '33418' });
    expect(
      mcpReturnTarget({
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        loopback: false,
      }),
    ).toEqual({ local: false, where: 'claude.ai' });
  });
});

describe('MCP settings', () => {
  it('builds the address and the client snippets from the origin', () => {
    const url = mcpServerUrl('https://app.calab.io/');
    expect(url).toBe('https://app.calab.io/mcp');
    const s = mcpClientSnippets(url);
    expect(s.claudeCode).toBe('claude mcp add --transport http calab https://app.calab.io/mcp');
    expect(s.codex).toBe('codex mcp add calab --url https://app.calab.io/mcp');
    expect(JSON.parse(s.cursor)).toEqual({ mcpServers: { calab: { url: 'https://app.calab.io/mcp' } } });
  });
  it('recognizes MCP sessions by the device name the server gives them', () => {
    expect(mcpSessionClient('MCP · Claude Code')).toBe('Claude Code');
    expect(mcpSessionClient('MacBook · Chrome')).toBeNull();
  });
  it('reads /settings/<section>', () => {
    expect(settingsRouteSection('/settings/mcp')).toBe('mcp');
    expect(settingsRouteSection('/settings/')).toBeNull();
    expect(settingsRouteSection('/mcp')).toBeNull();
  });
});

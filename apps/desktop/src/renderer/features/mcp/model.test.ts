import { describe, expect, it } from 'vitest';
import { mcpConnectHandle, mcpReturnTarget } from './model';

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

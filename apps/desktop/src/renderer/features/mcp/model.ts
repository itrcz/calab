/** MCP without a bot (ADR-0158): the consent page of an MCP client's OAuth request. */

/** The request handle of `/mcp/connect#<handle>` (the server's authorize redirect), or null. */
export function mcpConnectHandle(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.pathname !== '/mcp/connect') return null;
  const handle = parsed.hash.replace(/^#/, '');
  return /^calab_mr_[A-Za-z0-9_-]{43}$/.test(handle) ? handle : null;
}

/** What the consent shows (POST /api/mcp/oauth/requests/{handle}/bind). */
export type McpConsent = {
  clientName: string;
  redirectUri: string;
  loopback: boolean;
  displayName: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  csrfToken: string;
};

/** Where the code goes back: «this computer, port N» for loopback, else the host. */
export function mcpReturnTarget(c: Pick<McpConsent, 'redirectUri' | 'loopback'>): { local: boolean; where: string } {
  try {
    const u = new URL(c.redirectUri);
    if (c.loopback) return { local: true, where: u.port || '80' };
    return { local: false, where: u.host };
  } catch {
    return { local: false, where: c.redirectUri };
  }
}

/** The MCP server address on this server: `<origin>/mcp` (CBF-183, ADR-0158 addendum). */
export function mcpServerUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

/** What each client is told to run or paste (Settings → MCP), for the server address `url`. */
export function mcpClientSnippets(url: string): { claudeCode: string; codex: string; cursor: string } {
  return {
    claudeCode: `claude mcp add --transport http calab ${url}`,
    codex: `codex mcp add calab --url ${url}`,
    cursor: JSON.stringify({ mcpServers: { calab: { url } } }),
  };
}

/** The server names an MCP session's device «MCP · <client>» (auth.MCPSessionTokens). */
const MCP_DEVICE = 'MCP · ';

/** The client's name of an MCP session, or null for any other session. */
export function mcpSessionClient(deviceName: string): string | null {
  return deviceName.startsWith(MCP_DEVICE) ? deviceName.slice(MCP_DEVICE.length) || '—' : null;
}

/** A web address `/settings/<section>` (the server sends a browser opening `/mcp` there), or null. */
export function settingsRouteSection(pathname: string): string | null {
  return /^\/settings\/([a-z][a-z-]{1,31})\/?$/.exec(pathname)?.[1] ?? null;
}

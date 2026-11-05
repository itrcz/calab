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

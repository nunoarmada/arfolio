/** Fixed callbacks of the MCP clients we support: claude.ai and claude.com connectors. */
const FIXED_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Operator-supplied extra exact redirect URIs (`MCP_ALLOWED_REDIRECT_URIS`, comma-separated). */
export function parseExtraRedirectUris(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean);
}

function isLoopbackCallback(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port !== '' && // Claude Code always picks an explicit port
    url.pathname === '/callback' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * Whether an MCP client may use `uri` as its OAuth redirect URI: the Claude connector callbacks,
 * loopback `/callback` on any port (Claude Code), or an exact URI the operator allowed. Exact
 * string comparison for everything except the loopback port, so look-alike hosts, extra paths,
 * queries and fragments never match.
 */
export function isAllowedMcpRedirectUri(uri: string, extra: readonly string[] = []): boolean {
  return FIXED_CALLBACKS.has(uri) || extra.includes(uri) || isLoopbackCallback(uri);
}

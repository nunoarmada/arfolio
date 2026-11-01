/** The MCP URL of an installation: its public address plus the fixed endpoint path. */
export function mcpUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/mcp`;
}

/** A server name `claude mcp add` accepts: the brand lower-cased, anything else a hyphen. */
export function mcpServerName(brandName: string): string {
  const slug = brandName
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'arfolio';
}

/** The Claude Code command that adds this server; `token` is the literal `<token>` in the guide. */
export function claudeCodeCommand(brandName: string, url: string, token: string): string {
  return `claude mcp add --transport http ${mcpServerName(brandName)} ${url} --header "Authorization: Bearer ${token}"`;
}

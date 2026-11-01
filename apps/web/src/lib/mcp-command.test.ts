import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, mcpServerName, mcpUrl } from './mcp-command';

describe('mcp command', () => {
  it('builds the URL from APP_URL without doubling the slash', () => {
    expect(mcpUrl('https://pfm.example.org')).toBe('https://pfm.example.org/api/mcp');
    expect(mcpUrl('https://pfm.example.org/')).toBe('https://pfm.example.org/api/mcp');
  });

  it('turns the brand name into a valid server name', () => {
    expect(mcpServerName('Casa Exemplo')).toBe('casa-exemplo');
    expect(mcpServerName('  Arfolio!  ')).toBe('arfolio');
    expect(mcpServerName('Família Ação')).toBe('familia-acao');
    expect(mcpServerName('日本')).toBe('arfolio');
  });

  it('writes the command with the literal placeholder or a real token', () => {
    expect(claudeCodeCommand('Casa Exemplo', 'https://x.org/api/mcp', '<token>')).toBe(
      'claude mcp add --transport http casa-exemplo https://x.org/api/mcp --header "Authorization: Bearer <token>"',
    );
  });
});

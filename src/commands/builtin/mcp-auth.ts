import type { AppState } from '../../app/state.js';
import type { CommandResult } from '../types.js';

export function defaultCredentialRef(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${cleaned}_API_KEY`;
}

export async function storeMcpAuth(
  app: AppState,
  name: string | undefined,
  inlineSecret: string | undefined,
  flags: Record<string, string | true>,
): Promise<CommandResult> {
  if (!name || inlineSecret !== undefined) {
    return {
      ok: false,
      error:
        'Usage: /mcp auth <name> --key-env=<ENV_VAR>\n' +
        'Do not put API keys in command arguments: they may be exposed in terminal history. ' +
        'Export the key as an environment variable and reference its name instead.',
    };
  }
  const envName = flags['key-env'];
  if (typeof envName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    return {
      ok: false,
      error: 'Usage: /mcp auth <name> --key-env=<ENV_VAR> (use a valid environment variable name)',
    };
  }
  const secret = process.env[envName];
  if (!secret) {
    return { ok: false, error: `Environment variable ${envName} is not set or is empty.` };
  }
  const config = app.mcp.getConfig(name);
  if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };

  if (!config.auth) {
    config.auth = { type: 'bearer', credentialRef: defaultCredentialRef(name) };
  }
  await app.credentials.set(config.auth.credentialRef, secret);
  app.configManager?.save(app.config);

  return {
    ok: true,
    output:
      `Credential stored for "${name}" under ref "${config.auth.credentialRef}" (${config.auth.type}).\n` +
      'The config file stores the reference only — never the secret.\n' +
      `Verify with /mcp test ${name}.`,
  };
}

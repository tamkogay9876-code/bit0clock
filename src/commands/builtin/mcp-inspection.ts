import type { AppState } from '../../app/state.js';
import type { MCPServerConfig } from '../../types/index.js';
import type { CommandResult } from '../types.js';
import { MODES } from '../../modes/index.js';

export async function inspectMcpPermissions(
  app: AppState,
  name: string | undefined,
  toolName: string | undefined,
  toolVerb: 'on' | 'off' | undefined,
  helpers: {
    saveConfig: (app: AppState) => boolean;
    statusLabel: (config: MCPServerConfig, app: AppState) => string;
  },
): Promise<CommandResult> {
  if (!name) return { ok: false, error: 'Usage: /mcp permissions <server> [tool on|off]' };
  const config = app.mcp.getConfig(name);
  if (!config) return { ok: false, error: `MCP server not configured: ${name}. See /mcp list.` };

  if (toolVerb !== undefined || toolName !== undefined) {
    if ((toolVerb !== 'on' && toolVerb !== 'off') || !toolName) {
      return { ok: false, error: `Usage: /mcp permissions ${name} <tool> on|off` };
    }
    await app.mcp.ensureConnected(name);
    const state = app.mcp.state(name);
    if (!state || state.status !== 'ready') {
      return {
        ok: false,
        error:
          `Tool list unavailable for ${name}${state?.lastError ? `: ${state.lastError}` : ''}. ` +
          `Run /mcp test ${name} to see the connection error.`,
      };
    }
    if (!state.tools.some((tool) => tool.name === toolName)) {
      return {
        ok: false,
        error: `Unknown tool "${toolName}" on ${name}. Run /mcp tools ${name} for the list.`,
      };
    }
    const disabled = new Set(config.disabledTools ?? []);
    if (toolVerb === 'off') disabled.add(toolName);
    else disabled.delete(toolName);
    config.disabledTools = [...disabled].sort();
    helpers.saveConfig(app);
    if (app.mcp.isConnected(name)) await app.mcp.refreshMetadata(name);
    return {
      ok: true,
      output:
        `MCP tool ${name}/${toolName} ${toolVerb === 'off' ? 'DISABLED (no longer exposed to the model)' : 'enabled (still subject to the permission engine)'}.\n` +
        'This controls exposure only. Every call still passes the central permission engine (class "mcp").',
    };
  }

  const state = app.mcp.state(name);
  const sample = app.permissions.evaluate({
    action: `mcp__${name}__example`,
    toolName: `mcp__${name}__example`,
    permissionClass: 'mcp',
    summary: `representative MCP tool call on "${name}"`,
    approvalKey: `mcp__${name}__example`,
  });
  const lines: string[] = [`MCP permissions for "${name}":`, ''];
  lines.push(`  enabled        ${config.enabled ? 'yes' : 'no'}`);
  lines.push(`  connection     ${helpers.statusLabel(config, app)}`);
  lines.push(
    '  permission     class "mcp" (never "read" — server annotations cannot pre-approve anything)',
  );
  lines.push('');
  lines.push('  Mode policy (from the mode registry):');
  for (const mode of ['plan', 'build', 'review'] as const) {
    const allowed = MODES[mode].allowedPermissionClasses.includes('mcp');
    lines.push(
      `    ${mode.padEnd(7)} ${allowed ? 'MCP tools offered' : 'MCP tools NOT offered (read-only mode)'}`,
    );
  }
  lines.push('');
  lines.push('  Default decision for a representative call (current session rules):');
  lines.push(`    ${sample.decision.toUpperCase()} — ${sample.reason}`);
  if (sample.decision === 'confirm') {
    lines.push('    Interactive sessions prompt; non-interactive runs block unless --yes is set.');
  }

  const approvals = app.permissions
    .activeApprovalKeys()
    .filter((key) => key.startsWith(`mcp__${name}__`));
  lines.push('');
  lines.push(
    `  Session approvals for this server: ${approvals.length > 0 ? approvals.join(', ') : '(none)'}`,
  );

  if (state && state.status === 'ready') {
    const disabled = new Set(config.disabledTools ?? []);
    lines.push('');
    lines.push(`  Tool exposure (${state.tools.length} discovered):`);
    for (const tool of state.tools) {
      const exposure = disabled.has(tool.name) ? 'disabled' : 'exposed';
      lines.push(
        `    ${tool.name.padEnd(28)} ${exposure.padEnd(9)} timeout ${tool.timeoutMs ?? config.timeoutMs}ms · cap ${tool.outputBudget ?? config.outputLimitBytes} chars`,
      );
    }
    lines.push('');
    lines.push(`  Toggle exposure: /mcp permissions ${name} <tool> on|off`);
  } else {
    lines.push('');
    lines.push(`  Tool exposure: unknown until the server is connected (/mcp test ${name}).`);
  }
  return { ok: true, output: lines.join('\n') };
}

export function showMcpLogs(app: AppState, server: string | undefined): CommandResult {
  const entries = app.mcp
    .logEntries()
    .filter((entry) => (server ? entry.server === server : true))
    .slice(-60);
  const lines: string[] = ['Recent MCP activity:', ''];
  if (entries.length === 0) {
    lines.push('  (nothing logged yet — connect with /mcp test <name>)');
  } else {
    for (const entry of entries) {
      lines.push(`  [${entry.level}] ${entry.at} ${entry.server}: ${entry.message}`);
    }
  }

  const audit = app.permissions
    .audit()
    .filter((entry) => entry.permissionClass === 'mcp' || entry.toolName?.startsWith('mcp__'))
    .slice(-10);
  lines.push('');
  lines.push('Recent MCP permission decisions (this session):');
  if (audit.length === 0) {
    lines.push('  (none — no MCP tool call has been evaluated yet)');
  } else {
    for (const entry of audit) {
      lines.push(
        `  ${entry.timestamp} ${entry.decision.padEnd(16)} ${entry.toolName ?? entry.action} — ${entry.reason}`,
      );
    }
  }
  lines.push('');
  lines.push('Full permission audit: /permissions. Session tool history: /status.');
  return { ok: true, output: lines.join('\n') };
}

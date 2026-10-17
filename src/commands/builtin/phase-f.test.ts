/**
 * Phase F command tests: /skills, /mcp, and the new /context subcommands
 * (pin, unpin, auto, compact) — §§13, 32–39.
 *
 * MCP servers here use the shared fake client (no spawn, no network); the
 * real SDK path is covered by src/mcp/stdio.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandRegistry } from '../registry.js';
import { registerBuiltinCommands } from './index.js';
import { parseInput } from '../parser.js';
import type { CommandResult } from '../types.js';
import { createTestApp, seedModels, testProvider } from '../../app/test-utils.js';
import { ConfigManager } from '../../config/manager.js';
import { defaultConfig, type AppConfigInput } from '../../config/schema.js';
import type { AppState } from '../../app/state.js';
import type { SessionData } from '../../session/types.js';
import { FakeMcpClient, type FakeMcpClientOptions } from '../../mcp/test-utils.js';
import type { MCPServerConfig } from '../../types/index.js';

// ============================================================================
// Harness
// ============================================================================

interface Harness {
  app: AppState;
  projectDir: string;
  configManager: ConfigManager;
  mcpClients: FakeMcpClient[];
}

function makeApp(
  options: {
    configOverrides?: Partial<AppConfigInput>;
    clientOptions?: FakeMcpClientOptions;
    factoryError?: string;
  } = {},
): Harness {
  const projectDir = mkdtempSync(join(tmpdir(), 'mediaxg-phase-f-cmd-'));
  const configManager = new ConfigManager({
    userConfigPath: join(projectDir, 'user-config/config.json'),
    projectConfigPath: join(projectDir, '.mediaxg/config.json'),
  });

  const mcpClients: FakeMcpClient[] = [];
  const test = createTestApp({
    providers: [testProvider()],
    catalog: { test: seedModels() },
    projectPath: projectDir,
    configManager,
    ...(options.configOverrides ? { configOverrides: options.configOverrides } : {}),
    mcpClientFactory: async () => {
      if (options.factoryError) throw new Error(options.factoryError);
      const client = new FakeMcpClient(options.clientOptions);
      mcpClients.push(client);
      return client;
    },
  });

  return { app: test.app, projectDir, configManager, mcpClients };
}

function registryFor(app: AppState): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, app);
  return registry;
}

async function run(app: AppState, input: string): Promise<CommandResult> {
  const result = await registryFor(app).dispatch(parseInput(input));
  if (!result) throw new Error(`Not a command: ${input}`);
  return result;
}

function writeSkill(
  projectDir: string,
  name: string,
  frontmatter: string,
  body = 'Skill body',
): string {
  const dir = join(projectDir, '.agents/skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

function fillMessages(session: SessionData, count: number): void {
  for (let i = 0; i < count; i++) {
    session.messages.push({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content:
        i === 0
          ? 'Keep the public API stable.'
          : `message ${i} about the refactor plan ${'x'.repeat(40)}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
}

const FAKE_SERVER: MCPServerConfig = {
  name: 'fake',
  transport: 'http',
  url: 'https://fake.example.com/mcp',
  enabled: true,
  timeoutMs: 5000,
  outputLimitBytes: 20_000,
};

// ============================================================================
// /skills
// ============================================================================

describe('/skills', () => {
  it('reports an empty catalog with the search roots', async () => {
    const { app } = makeApp();
    const result = await run(app, '/skills');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('(no SKILL.md files found)');
    expect(result.output).toContain('.agents/skills');
    expect(result.output).toContain('Activate with /skills on <name>');
  });

  it('lists discovered skills with scope, trust, and activation state', async () => {
    const { app, projectDir } = makeApp();
    writeSkill(projectDir, 'good-one', 'name: good-one\ndescription: A useful skill');

    const result = await run(app, '/skills');
    expect(result.output).toContain('good-one');
    expect(result.output).toContain('project');
    expect(result.output).toContain('untrusted');
    expect(result.output).toContain('○ good-one');
    expect(result.output).toContain('1 valid, 0 active');
  });

  it('activates and deactivates a skill, injecting instructions only when active', async () => {
    const { app, projectDir } = makeApp();
    writeSkill(
      projectDir,
      'good-one',
      'name: good-one\ndescription: A useful skill',
      'ALWAYS USE TABS',
    );

    const on = await run(app, '/skills on good-one');
    expect(on.ok).toBe(true);
    expect(on.output).toContain('Skill activated: good-one (project, untrusted)');
    expect(on.output).toContain('cannot change permissions');

    expect(app.skills.promptItems()[0]!.instructions).toContain('ALWAYS USE TABS');
    const listing = await run(app, '/skills');
    expect(listing.output).toContain('● good-one');
    expect(listing.output).toContain('1 active');

    const off = await run(app, '/skills off good-one');
    expect(off.ok).toBe(true);
    expect(off.output).toContain('deactivated');
    expect(app.skills.promptItems()).toEqual([]);
  });

  it('rejects unknown and invalid skills with actionable errors', async () => {
    const { app, projectDir } = makeApp();
    writeSkill(projectDir, 'broken', 'name: not-broken\ndescription: mismatch');

    const unknown = await run(app, '/skills on nope');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Skill not found: nope');

    const invalid = await run(app, '/skills on not-broken');
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('must match the parent directory name');

    const show = await run(app, '/skills show not-broken');
    expect(show.ok).toBe(true);
    expect(show.output).toContain('valid        NO');
    expect(show.output).toContain('Validation errors:');
  });

  it('shows optional frontmatter fields and the allowed-tools limitation', async () => {
    const { app, projectDir } = makeApp();
    writeSkill(
      projectDir,
      'with-meta',
      'name: with-meta\ndescription: x\nlicense: MIT\nallowed-tools: Read Write',
    );

    const show = await run(app, '/skills show with-meta');
    expect(show.output).toContain('license: MIT');
    expect(show.output).toContain('allowed-tools: Read Write');
    expect(show.output).toContain('never pre-approves tools');

    const diagnostics = await run(app, '/skills diagnostics');
    expect(diagnostics.output).toContain('allowed-tools');
  });

  it('lists and loads reference files with containment rules', async () => {
    const { app, projectDir } = makeApp();
    const dir = writeSkill(projectDir, 'docs-helper', 'name: docs-helper\ndescription: x');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references/GUIDE.md'), 'GUIDE CONTENT HERE');

    const list = await run(app, '/skills references docs-helper');
    expect(list.output).toContain('references/GUIDE.md');
    expect(list.output).toContain('never run');

    const reference = await run(app, '/skills reference docs-helper references/GUIDE.md');
    expect(reference.ok).toBe(true);
    expect(reference.output).toContain('GUIDE CONTENT HERE');
    expect(reference.output).toContain('untrusted reference data');

    const traversal = await run(app, '/skills reference docs-helper ../SKILL.md');
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toContain('escapes the skill directory');
  });

  it('reloads the catalog and reports what changed', async () => {
    const { app, projectDir } = makeApp();
    writeSkill(projectDir, 'first', 'name: first\ndescription: x');
    await run(app, '/skills');

    writeSkill(projectDir, 'second', 'name: second\ndescription: y');
    const reload = await run(app, '/skills reload');
    expect(reload.ok).toBe(true);
    expect(reload.output).toContain('added        second');
    expect(reload.output).toContain('deactivated  (none');
  });

  it('rejects unknown subcommands with usage', async () => {
    const { app } = makeApp();
    const result = await run(app, '/skills frobnicate');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown subcommand: /skills frobnicate');
  });
});

// ============================================================================
// /context pin | unpin | auto | compact
// ============================================================================

describe('/context pin', () => {
  it('pins a workspace file, lists it, and refuses duplicates', async () => {
    const { app, projectDir } = makeApp();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/app.ts'), 'export const value = 1;');

    const pin = await run(app, '/context pin src/app.ts');
    expect(pin.ok).toBe(true);
    expect(pin.output).toContain('Pinned src/app.ts');
    expect(app.session.pinnedPaths).toEqual(['src/app.ts']);

    const duplicate = await run(app, '/context pin src/app.ts');
    expect(duplicate.ok).toBe(true);
    expect(duplicate.output).toContain('already pinned');

    const listing = await run(app, '/context');
    expect(listing.output).toContain('pinned         1 file(s): src/app.ts');
  });

  it('refuses missing paths, directories, sensitive files, and escapes', async () => {
    const { app, projectDir } = makeApp();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, '.env'), 'SECRET=1');

    const missing = await run(app, '/context pin src/nope.ts');
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('Cannot pin');

    const directory = await run(app, '/context pin src');
    expect(directory.ok).toBe(false);
    expect(directory.error).toContain('Only files can be pinned');

    const sensitive = await run(app, '/context pin .env');
    expect(sensitive.ok).toBe(false);

    const escape = await run(app, '/context pin ../outside.txt');
    expect(escape.ok).toBe(false);
    expect(escape.error).toContain('Cannot pin');

    const usage = await run(app, '/context pin');
    expect(usage.ok).toBe(false);
    expect(usage.error).toContain('Usage: /context pin');
  });

  it('unpins and reports the remaining pins', async () => {
    const { app, projectDir } = makeApp();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/a.ts'), 'a');
    writeFileSync(join(projectDir, 'src/b.ts'), 'b');

    await run(app, '/context pin src/a.ts');
    await run(app, '/context pin src/b.ts');
    const unpin = await run(app, '/context unpin src/a.ts');
    expect(unpin.ok).toBe(true);
    expect(unpin.output).toContain('Unpinned src/a.ts');
    expect(unpin.output).toContain('Still pinned: src/b.ts');
    expect(app.session.pinnedPaths).toEqual(['src/b.ts']);

    const again = await run(app, '/context unpin src/a.ts');
    expect(again.ok).toBe(false);
    expect(again.error).toContain('Not pinned');
  });
});

describe('/context auto and /context compact', () => {
  it('selects the runtime-determined auto profile', async () => {
    const { app } = makeApp();
    app.session.contextProfile = 'large';
    app.session.requestedContext = 500_000;

    const result = await run(app, '/context auto');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Context profile: auto');
    expect(result.output).toContain('smallest tier');
    expect(app.session.contextProfile).toBe('auto');
    expect(app.session.requestedContext).toBeUndefined();
  });

  it('delegates to the shared compaction helper', async () => {
    const { app } = makeApp();
    const nothing = await run(app, '/context compact');
    expect(nothing.ok).toBe(true);
    expect(nothing.output).toContain('Nothing to compact');

    fillMessages(app.session, 40);
    const compacted = await run(app, '/context compact');
    expect(compacted.ok).toBe(true);
    expect(compacted.output).toContain('Conversation compacted:');
    expect(app.session.summaries!.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// /mcp
// ============================================================================

describe('/mcp configuration', () => {
  it('shows the empty state with official integration examples', async () => {
    const { app } = makeApp();
    const result = await run(app, '/mcp');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('(none configured)');
    expect(result.output).toContain('https://mcp.context7.com/mcp');
    expect(result.output).toContain('https://api.xkiro.com/mcp/web');
    expect(result.output).toContain('added disabled');
    expect(result.output).toContain('Secrets never live in the config file');
  });

  it('adds an HTTP server disabled, with a credential reference, and persists it', async () => {
    const { app, projectDir } = makeApp();
    const result = await run(
      app,
      '/mcp add xkiro-web https://api.xkiro.com/mcp/web --auth=bearer --credential=XKIRO_API_KEY',
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('xkiro-web');
    expect(result.output).toContain('added DISABLED on purpose');
    expect(result.output).toContain('credential ref "XKIRO_API_KEY"');

    const config = app.mcp.getConfig('xkiro-web')!;
    expect(config.enabled).toBe(false);
    expect(config.transport).toBe('http');
    expect(config.auth).toEqual({ type: 'bearer', credentialRef: 'XKIRO_API_KEY' });

    const saved = JSON.parse(readFileSync(join(projectDir, 'user-config/config.json'), 'utf8'));
    expect(saved.mcpServers[0].name).toBe('xkiro-web');
    expect(JSON.stringify(saved)).not.toContain('"secret');
  });

  it('refuses secret-bearing URLs, duplicate names, and invalid names', async () => {
    const { app } = makeApp();

    const secret = await run(app, '/mcp add bad https://mcp.example.com/mcp?api_key=zzz');
    expect(secret.ok).toBe(false);
    expect(secret.error).toContain('secret-looking query parameter');

    await run(app, '/mcp add context7 https://mcp.context7.com/mcp');
    const duplicate = await run(app, '/mcp add context7 https://mcp.context7.com/mcp');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('already configured');

    const invalid = await run(app, '/mcp add -bad https://mcp.example.com/mcp');
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('Invalid server name');
  });

  it('adds a stdio server with parsed args and env, rejecting malformed JSON', async () => {
    const { app } = makeApp();
    const ok = await run(
      app,
      `/mcp add local --command=/usr/bin/env --args='["-y","pkg"]' --env='{"K":"v"}' --cwd=.`,
    );
    expect(ok.ok).toBe(true);
    const config = app.mcp.getConfig('local')!;
    expect(config.transport).toBe('stdio');
    expect(config.command).toBe('/usr/bin/env');
    expect(config.args).toEqual(['-y', 'pkg']);
    expect(config.env).toEqual({ K: 'v' });
    expect(config.cwd).toBe('.');

    const badJson = await run(app, '/mcp add other --command=/bin/true --args=not-json');
    expect(badJson.ok).toBe(false);
    expect(badJson.error).toContain('not valid JSON');

    const noCommand = await run(app, '/mcp add other --stdio');
    expect(noCommand.ok).toBe(false);
    expect(noCommand.error).toContain('--command');
  });

  it('shows configuration without ever printing secrets', async () => {
    const { app } = makeApp();
    await run(app, '/mcp add context7 https://mcp.context7.com/mcp');
    const show = await run(app, '/mcp show context7');
    expect(show.ok).toBe(true);
    expect(show.output).toContain('https://mcp.context7.com/mcp');
    expect(show.output).toContain('enabled      no');

    const unknown = await run(app, '/mcp show nope');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('not configured');
  });

  it('enables, tests, and removes a server (two-step remove)', async () => {
    const { app, mcpClients } = makeApp({ clientOptions: {} });
    await run(app, '/mcp add fake https://fake.example.com/mcp');

    const testDisabled = await run(app, '/mcp test fake');
    expect(testDisabled.ok).toBe(false);
    expect(testDisabled.error).toContain('disabled');

    const enable = await run(app, '/mcp enable fake');
    expect(enable.ok).toBe(true);
    expect(enable.output).toContain('not auto-approved');

    const test = await run(app, '/mcp test fake');
    expect(test.ok).toBe(true);
    expect(test.output).toContain('connected successfully');
    expect(test.output).toContain('tools      1');
    expect(mcpClients.length).toBe(1);

    const removeUnconfirmed = await run(app, '/mcp remove fake');
    expect(removeUnconfirmed.ok).toBe(false);
    expect(removeUnconfirmed.error).toContain('--yes');

    const remove = await run(app, '/mcp remove fake --yes');
    expect(remove.ok).toBe(true);
    expect(app.mcp.getConfig('fake')).toBeUndefined();
    expect(mcpClients[0]!.closed).toBe(true);
  });

  it('reports connection failures from /mcp test without crashing', async () => {
    const { app } = makeApp({ factoryError: 'spawn ENOENT' });
    await run(app, '/mcp add fake https://fake.example.com/mcp');
    await run(app, '/mcp enable fake');

    const result = await run(app, '/mcp test fake');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
    expect(app.mcp.state('fake')!.status).toBe('error');
  });
});

describe('/mcp discovery and permissions', () => {
  it('lists tools, resources, and prompts from a connected server', async () => {
    const { app } = makeApp({
      configOverrides: { mcpServers: [FAKE_SERVER] },
      clientOptions: {
        tools: [
          { name: 'echo', description: 'Echo text', inputSchema: {} },
          { name: 'other', description: 'Other tool', inputSchema: {} },
        ],
        resources: [{ uri: 'test://readme', name: 'readme', mimeType: 'text/plain' }],
        prompts: [
          { name: 'greet', description: 'Greet', arguments: [{ name: 'who', required: true }] },
        ],
      },
    });

    const tools = await run(app, '/mcp tools fake');
    expect(tools.ok).toBe(true);
    expect(tools.output).toContain('mcp__fake__echo');
    expect(tools.output).toContain('mcp__fake__other');
    expect(tools.output).toContain('2 tool(s)');

    const resources = await run(app, '/mcp resources fake');
    expect(resources.output).toContain('test://readme');

    const prompts = await run(app, '/mcp prompts fake');
    expect(prompts.output).toContain('greet');
    expect(prompts.output).toContain('who (required)');
  });

  it('explains policy, evaluates a representative call, and toggles tool exposure', async () => {
    const { app } = makeApp({
      configOverrides: { mcpServers: [FAKE_SERVER] },
      clientOptions: {
        tools: [
          { name: 'echo', description: 'Echo', inputSchema: {} },
          { name: 'other', description: 'Other', inputSchema: {} },
        ],
      },
    });

    const overview = await run(app, '/mcp permissions fake');
    expect(overview.ok).toBe(true);
    expect(overview.output).toContain('class "mcp"');
    expect(overview.output).toContain('build   MCP tools offered');
    expect(overview.output).toContain('plan    MCP tools NOT offered');
    expect(overview.output).toContain('review  MCP tools NOT offered');

    // The representative decision mirrors what the engine would decide now
    const expected = app.permissions.evaluate({
      action: 'mcp__fake__example',
      toolName: 'mcp__fake__example',
      permissionClass: 'mcp',
      summary: 'representative MCP tool call on "fake"',
      approvalKey: 'mcp__fake__example',
    });
    expect(overview.output).toContain(expected.decision.toUpperCase());

    const off = await run(app, '/mcp permissions fake echo off');
    expect(off.ok).toBe(true);
    expect(app.mcp.getConfig('fake')!.disabledTools).toEqual(['echo']);
    expect(app.mcp.registeredTools().map((tool) => tool.name)).toEqual(['mcp__fake__other']);

    const unknown = await run(app, '/mcp permissions fake nope on');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Unknown tool');

    const on = await run(app, '/mcp permissions fake echo on');
    expect(on.ok).toBe(true);
    expect(app.mcp.getConfig('fake')!.disabledTools).toEqual([]);
    expect(
      app.mcp
        .registeredTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['mcp__fake__echo', 'mcp__fake__other']);
  });

  it('stores auth secrets in the credential store only', async () => {
    const { app, projectDir } = makeApp();
    await run(app, '/mcp add fake https://fake.example.com/mcp');

    const auth = await run(app, '/mcp auth fake super-secret-token');
    expect(auth.ok).toBe(true);
    expect(auth.output).toContain('FAKE_API_KEY');
    expect(app.mcp.getConfig('fake')!.auth).toEqual({
      type: 'bearer',
      credentialRef: 'FAKE_API_KEY',
    });
    // escalation to the credential store happened (injected MemoryCredentialStore)
    const saved = readFileSync(join(projectDir, 'user-config/config.json'), 'utf8');
    expect(saved).not.toContain('super-secret-token');

    const usage = await run(app, '/mcp auth fake');
    expect(usage.ok).toBe(false);
    expect(usage.error).toContain('Usage: /mcp auth');
  });

  it('shows recent activity and permission decisions in the logs', async () => {
    const { app } = makeApp({
      configOverrides: { mcpServers: [FAKE_SERVER] },
    });
    await run(app, '/mcp test fake');
    const logs = await run(app, '/mcp logs');
    expect(logs.ok).toBe(true);
    expect(logs.output).toContain('connecting');
    expect(logs.output).toContain('Recent MCP permission decisions');

    const filtered = await run(app, '/mcp logs --server=fake');
    expect(filtered.output).toContain('connecting');
  });

  it('rejects unknown subcommands with usage', async () => {
    const { app } = makeApp();
    const result = await run(app, '/mcp frobnicate');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown subcommand: /mcp frobnicate');
  });
});

// ============================================================================
// Config schema defaults
// ============================================================================

describe('Phase F config defaults', () => {
  it('ships skills settings defaults and validates disabledTools', () => {
    expect(defaultConfig.skillsSettings).toEqual({
      enabled: true,
      trustedPaths: [],
      maxFiles: 500,
    });
  });
});

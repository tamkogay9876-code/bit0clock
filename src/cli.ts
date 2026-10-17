#!/usr/bin/env bun
/**
 * mediaXG CLI Entry Point
 */

import { readFileSync } from 'fs';
import { getConfigManager } from './config/manager.js';
import { initializeLogger, getLogger } from './logger/index.js';
import { formatError } from './errors/index.js';
import { startTUI } from './ui/index';
// Bun resolves .tsx from .js import
import { runDoctor } from './diagnostics/index.js';
import { createDefaultAppState } from './app/state.js';
import { runNonInteractive } from './run/non-interactive.js';
import { isMode } from './modes/index.js';

interface CLIOptions {
  help: boolean;
  version: boolean;
  doctor: boolean;
  config: boolean;
  prompt?: string;
  model?: string;
  provider?: string;
  mode?: string;
  verbose: boolean;
  quiet: boolean;
  nonInteractive: boolean;
  /** --yes: auto-approve consequential tool actions (§52) */
  yes: boolean;
}

function parseCLIArgs(args: string[]): { options: CLIOptions; positional: string[] } {
  const options: CLIOptions = {
    help: false,
    version: false,
    doctor: false,
    config: false,
    verbose: false,
    quiet: false,
    nonInteractive: false,
    yes: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--doctor':
        options.doctor = true;
        break;
      case '--config':
        options.config = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--non-interactive':
        options.nonInteractive = true;
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '-p':
      case '--prompt':
        options.prompt = args[++i];
        break;
      case '-m':
      case '--model':
        options.model = args[++i];
        break;
      case '--provider':
        options.provider = args[++i];
        break;
      case '--mode':
        options.mode = args[++i];
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        positional.push(arg);
    }
  }

  return { options, positional };
}

function showHelp(): void {
  console.log(`
mediaXG - Premium AI Coding Agent

Usage: mediaxg [options] [prompt]

Options:
  -h, --help              Show this help message
  -v, --version           Show version
  --doctor                Run diagnostics
  --config                Show current configuration
  --verbose               Enable verbose logging
  --quiet                 Suppress non-essential output
  --non-interactive       Run without TUI (requires --prompt)
  -y, --yes               Auto-approve consequential tool actions (no prompts)
  -p, --prompt <text>     Initial prompt
  -m, --model <id>        Model to use (provider/model)
  --provider <name>       Provider to use
  --mode <mode>           Agent mode (plan|build|review)

Examples:
  mediaxg                                    # Start interactive TUI
  mediaxg -p "Fix the bug in src/main.ts"    # Non-interactive with prompt
  mediaxg "/status"                          # Run a command non-interactively
  mediaxg -y -p "Run the tests and fix failures"  # Auto-approved tool actions
  mediaxg "/connect xkiro --key-env XKIRO_API_KEY"
  mediaxg --doctor                           # Run diagnostics
  mediaxg --config                           # Show configuration
`);
}

function showVersion(): void {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(`mediaXG v${pkg.version}`);
}

async function showConfig(): Promise<void> {
  const configManager = getConfigManager();
  const result = configManager.load();

  console.log('Configuration:');
  console.log(`  Path: ${result.path}`);
  console.log(`  Default: ${result.isDefault}`);
  console.log(`  Version: ${result.config.version}`);
  console.log(`  Providers: ${result.config.providers.length}`);
  console.log(`  Context Profiles: ${result.config.contextProfiles.length}`);
  console.log(`  MCP Servers: ${result.config.mcpServers.length}`);
  console.log(`  Skills Paths: ${result.config.skillsPaths.length}`);

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

async function main(): Promise<void> {
  const { options, positional } = parseCLIArgs(process.argv.slice(2));

  // Initialize logger
  const logLevel = options.verbose ? 'debug' : options.quiet ? 'warn' : 'info';
  initializeLogger({ level: logLevel as 'debug' | 'info' | 'warn' | 'error' });
  const logger = getLogger();

  try {
    // Load configuration
    const configManager = getConfigManager();
    const { config, warnings } = configManager.load();

    if (warnings.length > 0) {
      for (const warning of warnings) {
        logger.warn(warning);
      }
    }

    configManager.ensureDirectories();

    // Handle CLI options
    if (options.help) {
      showHelp();
      return;
    }

    if (options.version) {
      await showVersion();
      return;
    }

    if (options.config) {
      await showConfig();
      return;
    }

    if (options.doctor) {
      const report = await runDoctor(config);
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.overall === 'healthy' ? 0 : 1);
    }

    // Build application state (config, credentials, catalog, sessions).
    // Interactive runs can prompt for permission; non-interactive runs deny
    // by default unless --yes was passed.
    const interactiveRun = !options.nonInteractive && process.stdout.isTTY === true;
    const app = createDefaultAppState({
      projectPath: process.cwd(),
      interactive: interactiveRun,
      autoApprove: options.yes,
    });

    // Apply CLI overrides before anything runs
    if (options.provider) {
      const provider = app.getProviderConfig(options.provider);
      if (!provider) {
        console.error(
          `Provider not configured: ${options.provider}\n` +
            `Configured providers: ${config.providers.map((p) => p.id).join(', ') || '(none)'}`,
        );
        process.exit(1);
      }
      if (!provider.enabled) {
        console.error(
          `Provider disabled: ${options.provider}. Enable it with /connect ${options.provider}.`,
        );
        process.exit(1);
      }
      app.session.providerId = options.provider;
    }

    if (options.model) {
      if (options.provider) {
        app.selectModel(options.provider, options.model);
      } else {
        const resolution = app.resolveModel(options.model);
        if (resolution.kind === 'resolved') {
          app.selectModel(resolution.providerId, resolution.modelId);
        } else if (resolution.kind === 'ambiguous') {
          console.error(
            `Ambiguous model "${options.model}":\n` +
              resolution.candidates.map((c) => `  ${c.providerId}/${c.id}`).join('\n') +
              '\nUse --provider <id> or provider/model syntax.',
          );
          process.exit(1);
        } else {
          console.error(
            `Model not found: ${options.model}\n` +
              'Run /models refresh to discover models, or use provider/model syntax.',
          );
          process.exit(1);
        }
      }
    }

    if (options.mode) {
      if (!isMode(options.mode)) {
        console.error(`Unknown mode: ${options.mode}. Choose one of: plan, build, review.`);
        process.exit(1);
      }
      app.setMode(options.mode);
    }

    const prompt = options.prompt ?? (positional.length > 0 ? positional.join(' ') : undefined);

    // Non-interactive execution: explicit flag, or no TTY with a prompt
    const wantsNonInteractive =
      options.nonInteractive || (prompt !== undefined && !process.stdout.isTTY);

    if (wantsNonInteractive) {
      if (!prompt) {
        console.error('--non-interactive requires a prompt (-p "<text>").');
        process.exit(1);
      }
      const exitCode = await runNonInteractive(app, prompt);
      app.saveSession();
      await app.shutdown();
      process.exit(exitCode);
    }

    if (!process.stdout.isTTY) {
      console.error(
        'Cannot start the interactive TUI: stdout is not a terminal.\n' +
          'Provide a prompt for non-interactive execution: mediaxg -p "<text>"',
      );
      process.exit(1);
    }

    // Start TUI
    await startTUI(app, prompt !== undefined ? { initialPrompt: prompt } : {});
    await app.shutdown();
  } catch (error) {
    logger.error('Fatal error', { error: formatError(error) });
    console.error(`\nFatal error: ${formatError(error)}`);
    process.exit(1);
  }
}

main();

/**
 * Repository metadata detection (§46).
 *
 * Finds the project's package manager, test command, and lint command from
 * real manifest files. Never guesses: when nothing is detected, callers get
 * an explicit reason instead of an invented command.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { globSync } from 'glob';

export type PackageManagerName = 'bun' | 'npm' | 'pnpm' | 'yarn';

export interface PackageManagerInfo {
  name: PackageManagerName;
  source: 'packageManager-field' | 'lockfile' | 'test-files' | 'default';
}

export interface DetectedCommand {
  program: string;
  args: string[];
  /** Where the command came from, shown in tool output */
  source: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackageJson(root: string): PackageJson | null {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

export function packageScripts(root: string): Record<string, string> {
  return readPackageJson(root)?.scripts ?? {};
}

export function hasTestFiles(root: string): boolean {
  try {
    const matches = globSync('**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}', {
      cwd: root,
      nodir: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
      maxDepth: 6,
    });
    return matches.length > 0;
  } catch {
    return false;
  }
}

export function detectPackageManager(root: string): PackageManagerInfo {
  const pkg = readPackageJson(root);
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'bun' || declared === 'npm' || declared === 'pnpm' || declared === 'yarn') {
    return { name: declared, source: 'packageManager-field' };
  }

  const lockfiles: Array<[string, PackageManagerName]> = [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
  ];
  for (const [file, name] of lockfiles) {
    if (existsSync(join(root, file))) return { name, source: 'lockfile' };
  }

  if (existsSync(join(root, 'bunfig.toml')) || hasTestFiles(root)) {
    return { name: 'bun', source: 'test-files' };
  }

  return { name: 'bun', source: 'default' };
}

function runScript(pm: PackageManagerName): { program: string; args: string[] } {
  switch (pm) {
    case 'bun':
      return { program: 'bun', args: ['run'] };
    case 'npm':
      return { program: 'npm', args: ['run'] };
    case 'pnpm':
      return { program: 'pnpm', args: ['run'] };
    case 'yarn':
      return { program: 'yarn', args: [] };
  }
}

/**
 * Detect how to run this project's tests.
 * Preference: package.json "test" script → `bun test` when Bun owns the repo.
 */
export function detectTestCommand(root: string): DetectedCommand | null {
  const pm = detectPackageManager(root);
  const scripts = packageScripts(root);

  if (typeof scripts['test'] === 'string') {
    const runner = runScript(pm.name);
    return {
      program: runner.program,
      args: [...runner.args, 'test'],
      source: `package.json scripts.test (${pm.name}, ${pm.source})`,
    };
  }

  const bunProject =
    pm.name === 'bun' &&
    (existsSync(join(root, 'bun.lock')) ||
      existsSync(join(root, 'bun.lockb')) ||
      existsSync(join(root, 'bunfig.toml')) ||
      hasTestFiles(root));
  if (bunProject) {
    return { program: 'bun', args: ['test'], source: `bun test (${pm.source})` };
  }

  return null;
}

/** Detect how to lint/typecheck this project. */
export function detectLintCommand(root: string): DetectedCommand | null {
  const pm = detectPackageManager(root);
  const scripts = packageScripts(root);
  const runner = runScript(pm.name);

  if (typeof scripts['lint'] === 'string') {
    return {
      program: runner.program,
      args: [...runner.args, 'lint'],
      source: `package.json scripts.lint (${pm.name})`,
    };
  }
  if (typeof scripts['typecheck'] === 'string') {
    return {
      program: runner.program,
      args: [...runner.args, 'typecheck'],
      source: `package.json scripts.typecheck (${pm.name})`,
    };
  }

  const pkg = readPackageJson(root);
  const hasTypescript =
    pkg !== null &&
    (pkg.devDependencies?.typescript !== undefined || pkg.dependencies?.typescript !== undefined);
  if (hasTypescript && existsSync(join(root, 'tsconfig.json'))) {
    return {
      program: pm.name === 'bun' ? 'bun' : 'npx',
      args: pm.name === 'bun' ? ['x', 'tsc', '--noEmit'] : ['tsc', '--noEmit'],
      source: 'tsconfig.json + local typescript',
    };
  }

  return null;
}

export interface ProjectMetadata {
  packageManager: PackageManagerInfo;
  hasPackageJson: boolean;
  scripts: Record<string, string>;
  testCommand: DetectedCommand | null;
  lintCommand: DetectedCommand | null;
  hasTsconfig: boolean;
  hasReadme: boolean;
  lockfiles: string[];
}

/** One-shot project inspection used by repo_status and diagnostics. */
export function inspectProject(root: string): ProjectMetadata {
  const lockfileNames = [
    'bun.lock',
    'bun.lockb',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
  ];
  return {
    packageManager: detectPackageManager(root),
    hasPackageJson: existsSync(join(root, 'package.json')),
    scripts: packageScripts(root),
    testCommand: detectTestCommand(root),
    lintCommand: detectLintCommand(root),
    hasTsconfig: existsSync(join(root, 'tsconfig.json')),
    hasReadme:
      existsSync(join(root, 'README.md')) ||
      existsSync(join(root, 'README')) ||
      existsSync(join(root, 'readme.md')),
    lockfiles: lockfileNames.filter((file) => existsSync(join(root, file))),
  };
}

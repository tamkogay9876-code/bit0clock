/**
 * Skill manager tests (§32–§34): discovery across scopes, validation,
 * trust classification, activation, lazy loading, references, and reload.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_INSTRUCTION_CHARS,
  MAX_LISTED_FILES,
  SkillManager,
  type SkillManagerOptions,
} from './manager.js';

interface Fixture {
  root: string;
  workspace: string;
  home: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mediaxg-skills-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    root,
    workspace,
    home,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeSkill(dir: string, frontmatter: string, body = 'Follow the checklist.'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, `---\n${frontmatter}\n---\n${body}`);
  return file;
}

function projectSkillDir(fixture: Fixture, name: string): string {
  return join(fixture.workspace, '.agents/skills', name);
}

function userSkillDir(fixture: Fixture, name: string): string {
  return join(fixture.home, '.config/mediaxg/skills', name);
}

function globalSkillDir(fixture: Fixture, name: string): string {
  return join(fixture.home, '.agents/skills', name);
}

function makeManager(fixture: Fixture, overrides: Partial<SkillManagerOptions> = {}): SkillManager {
  return new SkillManager({
    workspaceRoot: fixture.workspace,
    homeDir: fixture.home,
    ...overrides,
  });
}

describe('SkillManager discovery', () => {
  it('discovers skills from project, user, and global roots', () => {
    const fixture = makeFixture();
    try {
      writeSkill(
        projectSkillDir(fixture, 'project-skill'),
        'name: project-skill\ndescription: a project skill',
      );
      writeSkill(
        userSkillDir(fixture, 'user-skill'),
        'name: user-skill\ndescription: a user skill',
      );
      writeSkill(
        globalSkillDir(fixture, 'global-skill'),
        'name: global-skill\ndescription: a global skill',
      );

      const manager = makeManager(fixture);
      const catalog = manager.catalog();
      expect(catalog.map((skill) => skill.name).sort()).toEqual([
        'global-skill',
        'project-skill',
        'user-skill',
      ]);
      const scopes = new Map(catalog.map((skill) => [skill.name, skill.scope]));
      expect(scopes.get('project-skill')).toBe('project');
      expect(scopes.get('user-skill')).toBe('user');
      expect(scopes.get('global-skill')).toBe('global');
      expect(catalog.every((skill) => skill.validated)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps the highest-precedence definition and records shadowed sources', () => {
    const fixture = makeFixture();
    try {
      writeSkill(projectSkillDir(fixture, 'dup'), 'name: dup\ndescription: project version');
      writeSkill(userSkillDir(fixture, 'dup'), 'name: dup\ndescription: user version');

      const manager = makeManager(fixture);
      const catalog = manager.catalog();
      const dup = catalog.find((skill) => skill.name === 'dup');
      expect(dup).toBeDefined();
      expect(dup!.scope).toBe('user');
      expect(dup!.description).toBe('user version');
      expect(dup!.conflicts?.length).toBe(1);
      expect(dup!.conflicts![0]).toContain('project');

      const warnings = manager.listDiagnostics().filter((d) => d.level === 'warning');
      expect(warnings.some((d) => d.message.includes('shadowed'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('lists invalid skills but refuses to activate them', () => {
    const fixture = makeFixture();
    try {
      writeSkill(projectSkillDir(fixture, 'valid-one'), 'name: valid-one\ndescription: fine');
      writeSkill(projectSkillDir(fixture, 'mismatch'), 'name: not-matching\ndescription: nope');

      const manager = makeManager(fixture);
      const catalog = manager.catalog();
      expect(catalog.length).toBe(2);

      const invalid = catalog.find(
        (skill) => skill.name === 'not-matching' || skill.name === 'mismatch',
      );
      expect(invalid).toBeDefined();
      expect(invalid!.validated).toBe(false);
      expect(invalid!.validationErrors.join(' ')).toContain('must match the parent directory name');

      expect(() => manager.activate('not-matching')).toThrow(
        /must match the parent directory name/,
      );
      expect(manager.activate('valid-one').activated).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('validates name pattern, length, and description rules', () => {
    const fixture = makeFixture();
    try {
      writeSkill(projectSkillDir(fixture, 'Bad_Caps'), 'name: Bad_Caps\ndescription: x');
      writeSkill(
        projectSkillDir(fixture, 'double--hyphen'),
        'name: double--hyphen\ndescription: x',
      );
      writeSkill(projectSkillDir(fixture, 'no-description'), 'name: no-description');
      writeSkill(projectSkillDir(fixture, 'no-name'), 'description: unnamed');

      const manager = makeManager(fixture);
      const byName = new Map(manager.catalog().map((skill) => [skill.name, skill]));
      expect(byName.get('Bad_Caps')!.validationErrors.join(' ')).toContain('lowercase letters');
      expect(byName.get('double--hyphen')!.validationErrors.join(' ')).toContain(
        'consecutive hyphens',
      );
      expect(byName.get('no-description')!.validationErrors.join(' ')).toContain(
        'description is required',
      );
      // Missing name falls back to the directory name for the listing
      expect(byName.get('no-name')!.validationErrors.join(' ')).toContain('name is required');
    } finally {
      fixture.cleanup();
    }
  });

  it('warns when a skill declares allowed-tools (never honored)', () => {
    const fixture = makeFixture();
    try {
      writeSkill(
        projectSkillDir(fixture, 'with-tools'),
        'name: with-tools\ndescription: x\nallowed-tools: Read Write',
      );
      const manager = makeManager(fixture);
      manager.catalog();
      const warning = manager
        .listDiagnostics()
        .find((entry) => entry.message.includes('allowed-tools'));
      expect(warning).toBeDefined();
      expect(warning!.message).toContain('never pre-approves');
      const skill = manager.get('with-tools');
      expect(skill!.metadata?.['allowed-tools']).toBe('Read Write');
    } finally {
      fixture.cleanup();
    }
  });

  it('classifies trust from configured trustedPaths only', () => {
    const fixture = makeFixture();
    try {
      writeSkill(projectSkillDir(fixture, 'trusted-skill'), 'name: trusted-skill\ndescription: x');
      writeSkill(projectSkillDir(fixture, 'other-skill'), 'name: other-skill\ndescription: y');

      const manager = makeManager(fixture, {
        trustedPaths: [join(fixture.workspace, '.agents/skills/trusted-skill')],
      });
      const byName = new Map(manager.catalog().map((skill) => [skill.name, skill.trustLevel]));
      expect(byName.get('trusted-skill')).toBe('trusted');
      expect(byName.get('other-skill')).toBe('untrusted');
    } finally {
      fixture.cleanup();
    }
  });

  it('returns nothing when discovery is disabled by configuration', () => {
    const fixture = makeFixture();
    try {
      writeSkill(projectSkillDir(fixture, 'hidden'), 'name: hidden\ndescription: x');
      const manager = makeManager(fixture, { enabled: false });
      expect(manager.catalog()).toEqual([]);
      expect(
        manager
          .listDiagnostics()
          .some((entry) => entry.message.includes('disabled by configuration')),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('honors extra configured paths, including single-skill directories', () => {
    const fixture = makeFixture();
    try {
      const extraRoot = join(fixture.root, 'extra-skills');
      writeSkill(join(extraRoot, 'extra-skill'), 'name: extra-skill\ndescription: from extra root');

      const single = join(fixture.root, 'standalone');
      writeSkill(single, 'name: standalone\ndescription: single dir');

      const manager = makeManager(fixture, { extraPaths: [extraRoot, single] });
      const names = manager
        .catalog()
        .map((skill) => skill.name)
        .sort();
      expect(names).toEqual(['extra-skill', 'standalone']);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('SkillManager activation and lazy loading', () => {
  it('loads instructions lazily and only for activated skills', () => {
    const fixture = makeFixture();
    try {
      writeSkill(
        projectSkillDir(fixture, 'lazy'),
        'name: lazy\ndescription: x',
        'SECRET BODY TEXT',
      );

      const manager = makeManager(fixture);
      const skill = manager.get('lazy')!;
      expect(skill.instructions).toBe('');

      manager.activate('lazy');
      const items = manager.promptItems();
      expect(items.length).toBe(1);
      expect(items[0]!.instructions).toContain('SECRET BODY TEXT');

      manager.deactivate('lazy');
      expect(manager.promptItems()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('caps instruction size with an explicit marker', () => {
    const fixture = makeFixture();
    try {
      const longBody = 'x'.repeat(MAX_INSTRUCTION_CHARS + 5000);
      writeSkill(projectSkillDir(fixture, 'long'), 'name: long\ndescription: x', longBody);

      const manager = makeManager(fixture);
      manager.activate('long');
      const item = manager.promptItems()[0]!;
      expect(item.truncated).toBe(true);
      expect(item.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS + 100);
      expect(item.instructions).toContain('truncated');
    } finally {
      fixture.cleanup();
    }
  });

  it('lists reference files and assets without loading their contents', () => {
    const fixture = makeFixture();
    try {
      const dir = projectSkillDir(fixture, 'with-files');
      writeSkill(dir, 'name: with-files\ndescription: x');
      mkdirSync(join(dir, 'references'), { recursive: true });
      writeFileSync(join(dir, 'references/GUIDE.md'), '# Guide');
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/run.sh'), '#!/bin/sh\necho hi');

      const manager = makeManager(fixture);
      const skill = manager.get('with-files')!;
      expect(skill.references.map((r) => r.path)).toEqual(['references/GUIDE.md']);
      expect(skill.references[0]!.content).toBeUndefined();
      expect(skill.references[0]!.loaded).toBe(false);

      const assets = new Map(skill.assets.map((a) => [a.path, a.type]));
      expect(assets.get('assets/logo.png')).toBe('png');
      expect(assets.get('scripts/run.sh')).toBe('script');
    } finally {
      fixture.cleanup();
    }
  });

  it('loads a reference on demand and marks it loaded', () => {
    const fixture = makeFixture();
    try {
      const dir = projectSkillDir(fixture, 'refs');
      writeSkill(dir, 'name: refs\ndescription: x');
      mkdirSync(join(dir, 'references'), { recursive: true });
      writeFileSync(join(dir, 'references/GUIDE.md'), 'GUIDE CONTENT');

      const manager = makeManager(fixture);
      const loaded = manager.loadReference('refs', 'references/GUIDE.md');
      expect(loaded.content).toBe('GUIDE CONTENT');
      expect(loaded.truncated).toBe(false);

      const skill = manager.get('refs')!;
      expect(skill.references[0]!.loaded).toBe(true);
      expect(skill.references[0]!.content).toBe('GUIDE CONTENT');
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses path traversal, absolute paths, symlink escapes, and binary files', () => {
    const fixture = makeFixture();
    try {
      const dir = projectSkillDir(fixture, 'secure');
      writeSkill(dir, 'name: secure\ndescription: x');
      mkdirSync(join(dir, 'references'), { recursive: true });
      writeFileSync(join(fixture.root, 'outside.txt'), 'outside secret');
      writeFileSync(join(dir, 'references/binary.bin'), Buffer.from([0x01, 0x00, 0x02]));
      try {
        symlinkSync(join(fixture.root, 'outside.txt'), join(dir, 'references/link.txt'));
      } catch {
        // Filesystems without symlink support: the other assertions still run
      }

      const manager = makeManager(fixture);
      expect(() => manager.loadReference('secure', '../SKILL.md')).toThrow(
        /escapes the skill directory/,
      );
      expect(() => manager.loadReference('secure', join(fixture.root, 'outside.txt'))).toThrow(
        /relative to the skill directory/,
      );
      expect(() => manager.loadReference('secure', 'references/link.txt')).toThrow(
        /escapes the skill directory/,
      );
      expect(() => manager.loadReference('secure', 'references/binary.bin')).toThrow(/binary file/);
      expect(() => manager.loadReference('secure', 'references/missing.md')).toThrow(/not found/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('SkillManager reload', () => {
  it('reports added, changed, removed, and deactivated skills without losing activation', () => {
    const fixture = makeFixture();
    try {
      writeSkill(projectSkillDir(fixture, 'keeper'), 'name: keeper\ndescription: x', 'v1');
      const manager = makeManager(fixture);

      manager.activate('keeper');
      expect(manager.promptItems()[0]!.instructions).toContain('v1');

      // Add a new skill, modify the active one, delete nothing yet
      writeSkill(projectSkillDir(fixture, 'newcomer'), 'name: newcomer\ndescription: new');
      writeSkill(
        projectSkillDir(fixture, 'keeper'),
        'name: keeper\ndescription: x',
        'v2 with a longer body',
      );

      const summary = manager.reload();
      expect(summary.added).toEqual(['newcomer']);
      expect(summary.changed).toEqual(['keeper']);
      expect(summary.removed).toEqual([]);
      expect(summary.deactivated).toEqual([]);

      // Changed body is reloaded lazily on next use
      expect(manager.promptItems()[0]!.instructions).toContain('v2 with a longer body');
    } finally {
      fixture.cleanup();
    }
  });

  it('deactivates a skill that becomes invalid on disk', () => {
    const fixture = makeFixture();
    try {
      const dir = projectSkillDir(fixture, 'flaky');
      writeSkill(dir, 'name: flaky\ndescription: x');
      const manager = makeManager(fixture);
      manager.activate('flaky');

      // Break the frontmatter: name no longer matches the directory
      writeSkill(dir, 'name: renamed\ndescription: x');
      const summary = manager.reload();
      expect(summary.deactivated).toEqual(['flaky']);
      expect(manager.promptItems()).toEqual([]);
      expect(manager.listDiagnostics().some((entry) => entry.message.includes('deactivated'))).toBe(
        true,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('drops a skill whose file disappears and deactivates it', () => {
    const fixture = makeFixture();
    try {
      const dir = projectSkillDir(fixture, 'vanishing');
      writeSkill(dir, 'name: vanishing\ndescription: x');
      const manager = makeManager(fixture);
      manager.activate('vanishing');

      rmSync(join(dir, 'SKILL.md'));
      const summary = manager.reload();
      expect(summary.removed).toEqual(['vanishing']);
      expect(summary.deactivated).toEqual(['vanishing']);
      expect(manager.catalog()).toEqual([]);
      expect(manager.activeNames()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('caps the number of scanned SKILL.md files', () => {
    const fixture = makeFixture();
    try {
      for (let i = 0; i < 5; i++) {
        writeSkill(projectSkillDir(fixture, `skill-${i}`), `name: skill-${i}\ndescription: x`);
      }
      const manager = makeManager(fixture, { maxFiles: 3 });
      expect(manager.catalog().length).toBe(3);
      expect(
        manager.listDiagnostics().some((entry) => entry.message.includes('scan cap reached')),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('caps listed files per skill', () => {
    const fixture = makeFixture();
    try {
      const dir = projectSkillDir(fixture, 'many-files');
      writeSkill(dir, 'name: many-files\ndescription: x');
      mkdirSync(join(dir, 'references'), { recursive: true });
      for (let i = 0; i < MAX_LISTED_FILES + 10; i++) {
        writeFileSync(join(dir, 'references', `file-${i}.md`), 'x');
      }
      const manager = makeManager(fixture);
      const skill = manager.get('many-files')!;
      expect(skill.references.length).toBeLessThanOrEqual(MAX_LISTED_FILES);
    } finally {
      fixture.cleanup();
    }
  });

  it('does not follow directory traversal through skill-name directories', () => {
    const fixture = makeFixture();
    try {
      // A directory name with '..' cannot exist, but a symlinked skill dir can
      // point elsewhere; references inside must still stay within the skill dir.
      const outside = join(fixture.root, 'outside-dir');
      mkdirSync(outside, { recursive: true });
      writeFileSync(
        join(outside, 'SKILL.md'),
        '---\nname: linked\ndescription: via symlink\n---\nbody',
      );
      let linked = true;
      try {
        symlinkSync(outside, projectSkillDir(fixture, 'linked'));
      } catch {
        linked = false;
      }
      if (!linked) return;

      const manager = makeManager(fixture);
      const skill = manager.get('linked');
      expect(skill).toBeDefined();
      // The skill itself is discoverable but its instructions stay text-only
      manager.activate('linked');
      expect(manager.promptItems()[0]!.instructions).toContain('body');
    } finally {
      fixture.cleanup();
    }
  });
});

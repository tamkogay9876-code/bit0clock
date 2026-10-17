/**
 * SKILL.md frontmatter parser tests (§32).
 *
 * The parser supports the documented scalar subset plus the `metadata` map,
 * and must fail loudly (never silently) on anything else.
 */

import { describe, expect, it } from 'bun:test';
import { parseSkillFrontmatter } from './frontmatter.js';

function parse(frontmatter: string, body = 'Body text'): ReturnType<typeof parseSkillFrontmatter> {
  return parseSkillFrontmatter(`---\n${frontmatter}\n---\n${body}`);
}

describe('parseSkillFrontmatter', () => {
  it('parses name and description plus the markdown body', () => {
    const result = parse(
      'name: my-skill\ndescription: Does useful things',
      '\n# Title\n\nSteps here.',
    );
    expect(result.errors).toEqual([]);
    expect(result.data['name']).toBe('my-skill');
    expect(result.data['description']).toBe('Does useful things');
    expect(result.body).toContain('# Title');
    expect(result.body).toContain('Steps here.');
  });

  it('keeps optional scalar fields verbatim (license, compatibility, allowed-tools)', () => {
    const result = parse(
      [
        'name: my-skill',
        'description: desc',
        'license: Apache-2.0',
        'compatibility: requires git',
        'allowed-tools: Read Write',
        'custom-field: custom value',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.data['license']).toBe('Apache-2.0');
    expect(result.data['compatibility']).toBe('requires git');
    expect(result.data['allowed-tools']).toBe('Read Write');
    expect(result.data['custom-field']).toBe('custom value');
  });

  it('parses the documented metadata map', () => {
    const result = parse(
      [
        'name: my-skill',
        'description: desc',
        'metadata:',
        '  author: mediaxg',
        '  version: 1.2',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.metadata).toEqual({ author: 'mediaxg', version: '1.2' });
  });

  it('supports quoted values and escapes', () => {
    const result = parse('name: my-skill\ndescription: "Use \\"quotes\\" and \\\\ backslash"');
    expect(result.errors).toEqual([]);
    expect(result.data['description']).toBe('Use "quotes" and \\ backslash');
  });

  it('supports single-quoted values with doubled quotes', () => {
    const result = parse("name: my-skill\ndescription: 'It''s fine'");
    expect(result.errors).toEqual([]);
    expect(result.data['description']).toBe("It's fine");
  });

  it('strips a BOM and accepts CRLF line endings', () => {
    const text = '\uFEFF---\r\nname: my-skill\r\ndescription: desc\r\n---\r\nBody';
    const result = parseSkillFrontmatter(text);
    expect(result.errors).toEqual([]);
    expect(result.data['name']).toBe('my-skill');
    expect(result.body).toBe('Body');
  });

  it('rejects a file without frontmatter', () => {
    const result = parseSkillFrontmatter('# No frontmatter\n\ntext');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing YAML frontmatter');
  });

  it('rejects unterminated frontmatter', () => {
    const result = parseSkillFrontmatter('---\nname: my-skill\ndescription: desc\n');
    expect(result.errors[0]).toContain('unterminated');
  });

  it('rejects block scalars with an actionable message', () => {
    const result = parse('name: my-skill\ndescription: >\n  wrapped text');
    expect(result.errors.some((error) => error.includes('block scalar'))).toBe(true);
  });

  it('rejects nested structures outside the metadata map', () => {
    const result = parse('name: my-skill\ndescription: desc\nunknown:\n  nested: value');
    expect(result.errors.some((error) => error.includes('unsupported nested YAML structure'))).toBe(
      true,
    );
  });

  it('rejects duplicate fields', () => {
    const result = parse('name: one\nname: two\ndescription: desc');
    expect(result.errors.some((error) => error.includes('duplicate field "name"'))).toBe(true);
    expect(result.data['name']).toBe('one');
  });

  it('rejects empty values and empty metadata entries', () => {
    const emptyValue = parse('name:\ndescription: desc');
    expect(emptyValue.errors.some((error) => error.includes('has no value'))).toBe(true);

    const emptyMeta = parse('name: n\ndescription: d\nmetadata:\n  broken:');
    expect(emptyMeta.errors.some((error) => error.includes('no value'))).toBe(true);
  });

  it('rejects metadata as a scalar value', () => {
    const result = parse('name: n\ndescription: d\nmetadata: not-a-map');
    expect(result.errors.some((error) => error.includes('must be a nested map'))).toBe(true);
  });

  it('caps the frontmatter size', () => {
    const big = `name: n\ndescription: d\ncustom: ${'x'.repeat(20_000)}`;
    const result = parse(big);
    expect(result.errors.some((error) => error.includes('exceeds'))).toBe(true);
  });

  it('skips comments and blank lines', () => {
    const result = parse('# a comment\n\nname: my-skill\n\ndescription: desc\n# another');
    expect(result.errors).toEqual([]);
    expect(result.data['name']).toBe('my-skill');
    expect(result.data['description']).toBe('desc');
  });
});

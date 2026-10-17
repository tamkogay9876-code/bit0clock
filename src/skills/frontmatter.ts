/**
 * Minimal YAML frontmatter parser for SKILL.md (§32).
 *
 * The Agent Skills specification uses a small frontmatter subset: single-line
 * scalar fields plus the documented `metadata` map. This parser supports
 * exactly that subset and refuses anything else (block scalars, nested maps
 * beyond `metadata`, sequences) with an actionable error instead of guessing
 * at YAML semantics. Optional fields are stored verbatim — the spec asks for
 * documented compatibility, not invented interpretation.
 */

export const MAX_FRONTMATTER_CHARS = 16_384;

export interface SkillFrontmatter {
  /** Top-level scalar fields (name, description, license, compatibility, allowed-tools, …) */
  data: Record<string, string>;
  /** The documented optional `metadata` map (string keys → string values) */
  metadata: Record<string, string>;
  /** Markdown body after the closing delimiter */
  body: string;
  /** Parse problems, in order; a non-empty list means the frontmatter is invalid */
  errors: string[];
}

const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/;
const METADATA_KEY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(.*)$/;

function unquote(raw: string, errors: string[], line: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      errors.push(`line ${line}: unterminated double-quoted value`);
      return value;
    }
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      errors.push(`line ${line}: unterminated single-quoted value`);
      return value;
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function isBlockScalar(value: string): boolean {
  return /^[|>][-+]?[0-9]*$/.test(value.trim());
}

/**
 * Parse a SKILL.md file. A file without frontmatter, or with unsupported
 * YAML constructs, yields errors — never silent partial data.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const errors: string[] = [];
  const data: Record<string, string> = {};
  const metadata: Record<string, string> = {};

  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    errors.push('missing YAML frontmatter: SKILL.md must start with a "---" line');
    return { data, metadata, body: cleaned, errors };
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    errors.push('unterminated YAML frontmatter: no closing "---" line');
    return { data, metadata, body: cleaned, errors };
  }

  const rawBlock = lines.slice(1, closing).join('\n');
  if (rawBlock.length > MAX_FRONTMATTER_CHARS) {
    errors.push(`frontmatter exceeds ${MAX_FRONTMATTER_CHARS} characters`);
    return { data, metadata, body: lines.slice(closing + 1).join('\n'), errors };
  }

  let currentMap: string | null = null;

  for (let i = 1; i < closing; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;

    if (raw.trim() === '') continue;
    if (raw.trimStart().startsWith('#')) continue;

    const indented = /^[ \t]/.test(raw);
    if (indented) {
      const match = METADATA_KEY_PATTERN.exec(raw.trim());
      if (currentMap === 'metadata' && match) {
        const key = match[1]!;
        const value = match[2]!;
        if (value.trim() === '') {
          errors.push(
            `line ${lineNo}: metadata key "${key}" has no value (nested maps are not supported)`,
          );
          continue;
        }
        if (metadata[key] !== undefined) {
          errors.push(`line ${lineNo}: duplicate metadata key "${key}"`);
          continue;
        }
        metadata[key] = unquote(value, errors, lineNo);
        continue;
      }
      errors.push(
        `line ${lineNo}: unsupported nested YAML structure (only the documented "metadata" map is supported)`,
      );
      continue;
    }

    currentMap = null;
    const match = KEY_PATTERN.exec(raw);
    if (!match) {
      errors.push(`line ${lineNo}: unsupported YAML entry (expected "key: value")`);
      continue;
    }

    const key = match[1]!;
    const rawValue = match[2]!;
    const trimmed = rawValue.trim();

    if (isBlockScalar(trimmed)) {
      errors.push(
        `line ${lineNo}: block scalars ("${trimmed}") are not supported; use a single-line value`,
      );
      continue;
    }

    if (trimmed === '') {
      if (key === 'metadata') {
        currentMap = 'metadata';
        continue;
      }
      errors.push(`line ${lineNo}: key "${key}" has no value`);
      continue;
    }

    if (key === 'metadata') {
      errors.push(
        `line ${lineNo}: "metadata" must be a nested map of string keys to string values`,
      );
      continue;
    }

    if (data[key] !== undefined) {
      errors.push(`line ${lineNo}: duplicate field "${key}"`);
      continue;
    }
    data[key] = unquote(rawValue, errors, lineNo);
  }

  const body = lines.slice(closing + 1).join('\n');
  return { data, metadata, body, errors };
}

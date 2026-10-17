import { describe, expect, it } from 'bun:test';
import { editDistance, parseCommandTail, parseInput } from './parser.js';

describe('parseInput', () => {
  it('treats plain text as a message', () => {
    const result = parseInput('hello world');
    expect(result.kind).toBe('message');
    expect(result.raw).toBe('hello world');
  });

  it('parses a bare command', () => {
    const result = parseInput('/help');
    expect(result.kind).toBe('command');
    expect(result.command).toBe('help');
    expect(result.args).toEqual([]);
  });

  it('parses command arguments', () => {
    const result = parseInput('/models provider xkiro');
    expect(result.kind).toBe('command');
    expect(result.command).toBe('models');
    expect(result.args).toEqual(['provider', 'xkiro']);
  });

  it('lowercases the command name only', () => {
    const result = parseInput('/MODEL Vendor/Model');
    expect(result.command).toBe('model');
    expect(result.args).toEqual(['Vendor/Model']);
  });

  it('escapes // into a literal message with a single slash', () => {
    const result = parseInput('//etc/passwd is broken');
    expect(result.kind).toBe('message');
    expect(result.raw).toBe('/etc/passwd is broken');
  });

  it('treats a leading space as literal text', () => {
    const result = parseInput(' /help is not a command here');
    expect(result.kind).toBe('message');
    expect(result.raw).toBe('/help is not a command here');
  });

  it('returns an empty message for blank input', () => {
    expect(parseInput('   ').kind).toBe('message');
  });

  it('keeps quoted arguments together', () => {
    const result = parseInput('/model "vendor/model name"');
    expect(result.args).toEqual(['vendor/model name']);
  });

  it('supports single quotes', () => {
    const result = parseInput("/search 'two words'");
    expect(result.args).toEqual(['two words']);
  });

  it('parses boolean flags and leaves space-separated values as positional', () => {
    const result = parseInput('/connect xkiro --key-env XKIRO_API_KEY --no-validate');
    expect(result.flags).toEqual({ 'key-env': true, 'no-validate': true });
    expect(result.args).toEqual(['xkiro', 'XKIRO_API_KEY']);
  });

  it('parses --key=value flags', () => {
    const result = parseInput('/connect --base-url=http://localhost:8080/v1');
    expect(result.flags).toEqual({ 'base-url': 'http://localhost:8080/v1' });
  });
});

describe('parseCommandTail', () => {
  it('handles an empty tail', () => {
    const result = parseCommandTail('');
    expect(result.args).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it('keeps the raw tail for diagnostics', () => {
    const result = parseCommandTail('provider xkiro');
    expect(result.raw).toBe('provider xkiro');
  });

  it('handles unterminated quotes gracefully', () => {
    const result = parseCommandTail('"unfinished argument');
    expect(result.args).toEqual(['unfinished argument']);
  });
});

describe('editDistance', () => {
  it('returns 0 for equal strings', () => {
    expect(editDistance('models', 'models')).toBe(0);
  });

  it('computes classic distances', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });

  it('is symmetric', () => {
    expect(editDistance('moels', 'models')).toBe(editDistance('models', 'moels'));
  });
});

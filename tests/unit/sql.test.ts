import { describe, expect, it } from 'vitest';

import { escapeSQL, sanitizeInt } from '../../src/lib/sql.js';

describe('escapeSQL', () => {
  it('escapes single quotes by doubling them', () => {
    expect(escapeSQL("it's")).toBe("it''s");
  });

  it('escapes multiple single quotes', () => {
    expect(escapeSQL("it's a 'test'")).toBe("it''s a ''test''");
  });

  it('removes NUL bytes', () => {
    expect(escapeSQL('abc\0def')).toBe('abcdef');
  });

  it('escapes backslashes', () => {
    expect(escapeSQL('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes newlines', () => {
    expect(escapeSQL('line1\nline2')).toBe('line1\\nline2');
  });

  it('escapes carriage returns', () => {
    expect(escapeSQL('line1\rline2')).toBe('line1\\rline2');
  });

  it('escapes tabs', () => {
    expect(escapeSQL('col1\tcol2')).toBe('col1\\tcol2');
  });

  it('handles empty string', () => {
    expect(escapeSQL('')).toBe('');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeSQL('hello world 123')).toBe('hello world 123');
  });

  it('handles combined special characters', () => {
    const input = "it's a\nnew\0 line\\path";
    const expected = "it''s a\\nnew line\\\\path";
    expect(escapeSQL(input)).toBe(expected);
  });
});

describe('sanitizeInt', () => {
  it('accepts valid non-negative integers', () => {
    expect(sanitizeInt(0, 'test')).toBe(0);
    expect(sanitizeInt(1, 'test')).toBe(1);
    expect(sanitizeInt(100, 'test')).toBe(100);
    expect(sanitizeInt(999999, 'test')).toBe(999999);
  });

  it('rejects negative integers', () => {
    expect(() => sanitizeInt(-1, 'limit')).toThrow('Invalid limit');
  });

  it('rejects floating point numbers', () => {
    expect(() => sanitizeInt(3.14, 'offset')).toThrow('Invalid offset');
  });

  it('rejects NaN', () => {
    expect(() => sanitizeInt(NaN, 'test')).toThrow('Invalid test');
  });

  it('rejects Infinity', () => {
    expect(() => sanitizeInt(Infinity, 'test')).toThrow('Invalid test');
  });

  it('rejects negative Infinity', () => {
    expect(() => sanitizeInt(-Infinity, 'test')).toThrow('Invalid test');
  });

  it('includes label in error message', () => {
    expect(() => sanitizeInt(-1, 'dimensions')).toThrow(
      'Invalid dimensions: expected a non-negative integer, got -1',
    );
  });
});

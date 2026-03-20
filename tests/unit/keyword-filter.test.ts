import { describe, expect, it } from 'vitest';

import {
  buildKeywordQuery,
  STOP_WORDS,
} from '../../src/lib/keyword-filter.js';

describe('STOP_WORDS', () => {
  it('contains common English stop words', () => {
    const expected = ['the', 'a', 'an', 'is', 'are', 'was', 'with', 'for', 'and', 'or', 'but'];
    for (const w of expected) {
      expect(STOP_WORDS.has(w)).toBe(true);
    }
  });

  it('does not contain meaningful words', () => {
    const shouldNotExist = ['memory', 'node', 'graph', 'code', 'error'];
    for (const w of shouldNotExist) {
      expect(STOP_WORDS.has(w)).toBe(false);
    }
  });
});

describe('buildKeywordQuery', () => {
  it('returns AND-joined terms from a mixed query', () => {
    const result = buildKeywordQuery('the quick brown fox');
    // "the" is a stop word, should be filtered
    expect(result).not.toContain('the');
    // "quick", "brown", "fox" are not stop words
    expect(result).toContain('quick');
    expect(result).toContain('brown');
    expect(result).toContain('fox');
    // Joined with AND
    expect(result).toBe('quick AND brown AND fox');
  });

  it('falls back to escaped raw query when all terms are stop words', () => {
    const result = buildKeywordQuery('the is a an');
    // All words are stop words — should fallback to escaped raw query
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    // Fallback returns the original query escaped
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe('the is a an'); // safe as-is (no special chars)
  });

  it('filters single-character terms', () => {
    const result = buildKeywordQuery('a b c database');
    // "a" is stop word; "b" and "c" are single-char; "database" stays
    expect(result).toBe('database');
  });

  it('handles a single meaningful term', () => {
    const result = buildKeywordQuery('database');
    expect(result).toBe('database');
  });

  it('strips punctuation from terms', () => {
    const result = buildKeywordQuery('hello, world!');
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).not.toContain(',');
    expect(result).not.toContain('!');
  });

  it('handles empty input', () => {
    const result = buildKeywordQuery('');
    expect(typeof result).toBe('string');
  });

  it('handles whitespace-only input', () => {
    const result = buildKeywordQuery('   ');
    expect(typeof result).toBe('string');
  });

  it('correctly converts to lower case for filtering', () => {
    const result = buildKeywordQuery('The Quick');
    // "the" is stop word (case-insensitive), "Quick" stays with original casing
    expect(result).toContain('Quick');
    // Should not contain "the" (filtered as stop word)
    expect(result.split(' AND ').map((s) => s.trim().toLowerCase())).not.toContain('the');
  });

  it('preserves order of surviving terms', () => {
    const result = buildKeywordQuery('network is the best tool');
    // "is" and "the" are stop words
    // remaining: network, best, tool
    const parts = result.split(' AND ').map((s) => s.trim());
    expect(parts[0]).toBe('network');
    expect(parts[1]).toBe('best');
    expect(parts[2]).toBe('tool');
  });

  it('handles terms with mixed punctuation and numbers', () => {
    const result = buildKeywordQuery('node.js v18 http2');
    // Should produce a non-empty result
    expect(result.length).toBeGreaterThan(0);
  });
});

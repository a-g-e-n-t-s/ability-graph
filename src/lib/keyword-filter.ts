/**
 * Keyword search stop-word filter and query builder.
 *
 * Filters stop words from natural language queries and builds
 * Lucene-compatible AND-joined term queries for ArcadeDB's search_fields().
 *
 * This is the single most impactful fix for keyword search quality.
 * Natural language queries ("how do I connect to a broker") return 0 results
 * without filtering because stop words dilute the full-text search.
 */

import { escapeSQL } from './sql.js';

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

/**
 * Comprehensive stop-word set for English.
 * These words are filtered from keyword search queries to improve precision.
 */
export const STOP_WORDS = new Set([
  'the', 'is', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of',
  'and', 'or', 'but', 'with', 'from', 'by', 'as', 'it', 'this',
  'that', 'was', 'are', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'can', 'shall', 'not', 'no', 'nor', 'so', 'if', 'then',
  'than', 'too', 'very', 'just', 'about', 'above', 'after', 'before',
  'between', 'into', 'through', 'during', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'only', 'own', 'same', 'also',
  'how', 'what', 'which', 'who', 'when', 'where', 'why', 'all',
  'both', 'every', 'any', 'many', 'much',
  // Additional common stop words
  'i', 'me', 'my', 'myself', 'we', 'our', 'you', 'your', 'he',
  'she', 'its', 'they', 'them', 'their', 'these', 'those',
  'am', 'were', 'up', 'out', 'off', 'over', 'under', 'again',
  'further', 'once', 'here', 'there', 'while', 'because',
  'need', 'dare', 'ought', 'below', 'whom',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a keyword search query from a natural language input.
 *
 * 1. Splits the input into words.
 * 2. Strips punctuation from each word.
 * 3. Filters out stop words and single-character terms.
 * 4. Joins remaining terms with AND for Lucene-compatible search.
 *
 * If all terms are stop words, falls back to the original query (escaped).
 * If only one term remains, returns just that term (no AND).
 *
 * @param rawQuery - The user's natural language search query.
 * @param join     - Join operator for multiple terms: 'AND' (strict) or 'OR' (broad). Default: 'OR'.
 * @returns A Lucene-compatible search query string.
 */
export function buildKeywordQuery(rawQuery: string, join: 'AND' | 'OR' = 'OR'): string {
  if (!rawQuery || !rawQuery.trim()) return '';

  const terms = rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[?!.,;:'"()[\]{}]/g, ''))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t.toLowerCase()));

  if (terms.length === 0) return escapeSQL(rawQuery); // fallback
  if (terms.length === 1) return escapeSQL(terms[0]);
  return terms.map((t) => escapeSQL(t)).join(` ${join} `);
}

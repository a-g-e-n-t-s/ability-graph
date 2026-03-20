/**
 * Keyword signal — stop-word filtered full-text search.
 *
 * Filters stop words from the query, builds an AND-joined SQL LIKE query
 * from remaining terms, and executes against the target vertex type's
 * content field.
 *
 * The stop-word list is hardcoded per spec to ensure consistent behavior.
 */

import { buildKeywordQuery } from '../keyword-filter.js';
import { invokeWithRetry } from '../retry.js';
import { escapeSQL } from '../sql.js';
import type { ArcadeQueryResult, SignalContext, SignalResult } from '../types.js';
import type { SignalImplementation } from './index.js';

// ---------------------------------------------------------------------------
// Signal Implementation
// ---------------------------------------------------------------------------

export const keywordSignal: SignalImplementation = {
  name: 'keyword',
  requiresPriorResults: false,

  async execute(ctx: SignalContext): Promise<SignalResult[]> {
    const { abilities, database, query, vertexType, filters, limit } = ctx;

    // Build filtered keyword query
    const keywordQuery = buildKeywordQuery(query);
    if (!keywordQuery) {
      return [];
    }

    // Build WHERE clause with filters
    let filterClause = '';
    if (filters && Object.keys(filters).length > 0) {
      const conditions = buildFilterConditions(filters);
      if (conditions) {
        filterClause = ` AND ${conditions}`;
      }
    }

    // Use search_fields for full-text search on content field
    const sql =
      `SELECT *, search_fields(['content'], '${escapeSQL(keywordQuery)}') AS score` +
      ` FROM ${vertexType}` +
      ` WHERE search_fields(['content'], '${escapeSQL(keywordQuery)}') = true${filterClause}` +
      ` ORDER BY score DESC` +
      ` LIMIT ${limit}`;

    const result = await invokeWithRetry<ArcadeQueryResult>(
      abilities,
      'arcade-query',
      { database, query: sql },
    );

    if (!result.success || !result.result) {
      return [];
    }

    // Map results with rank-based pseudo-scores
    return result.result.map((row, index) => {
      const rid = (row['@rid'] as string) ?? '';
      const content = (row.content as string) ?? '';
      const importance = (row.importance as number) ?? 0.5;
      const props = filterSystemProps(row);

      // Rank-based scoring: higher rank = higher score
      const score = 1 / (index + 1);

      return {
        rid,
        id: rid,
        content,
        score,
        importance,
        matchedVia: ['keyword'],
        properties: props,
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build SQL WHERE conditions from a filters object.
 */
function buildFilterConditions(filters: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      parts.push(`${key} = '${escapeSQL(value)}'`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key} = ${value}`);
    } else if (Array.isArray(value)) {
      const escaped = value.map((v) =>
        typeof v === 'string' ? `'${escapeSQL(v)}'` : String(v),
      );
      parts.push(`${key} IN [${escaped.join(', ')}]`);
    }
  }

  return parts.join(' AND ');
}

/**
 * Filter out ArcadeDB system properties from a row.
 */
function filterSystemProps(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('@') && key !== 'score') {
      result[key] = value;
    }
  }
  return result;
}

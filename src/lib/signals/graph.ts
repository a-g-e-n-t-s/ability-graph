/**
 * Graph signal — MATCH traversal through Topic/Entity edges.
 *
 * Given entity or topic names from content or prior signal results,
 * traverses Topic/Entity edges to return connected vertices of the
 * target vertex type.
 */

import { invokeWithRetry } from '../retry.js';
import { escapeSQL } from '../sql.js';
import type { ArcadeQueryResult, SignalContext, SignalResult } from '../types.js';
import type { SignalImplementation } from './index.js';

// ---------------------------------------------------------------------------
// Signal Implementation
// ---------------------------------------------------------------------------

export const graphSignal: SignalImplementation = {
  name: 'graph',
  requiresPriorResults: false,

  async execute(ctx: SignalContext): Promise<SignalResult[]> {
    const { abilities, database, query, vertexType, filters, limit, priorResults } = ctx;

    // Extract entity/topic names from query text
    const searchTerms = extractSearchTerms(query);

    // Also collect entity names from prior results if available
    if (priorResults && priorResults.length > 0) {
      for (const result of priorResults) {
        if (result.properties?.name) {
          searchTerms.add(result.properties.name as string);
        }
      }
    }

    if (searchTerms.size === 0) {
      return [];
    }

    // Build filter clause
    let filterClause = '';
    if (filters && Object.keys(filters).length > 0) {
      const conditions = buildFilterConditions(filters);
      if (conditions) {
        filterClause = ` AND (${conditions})`;
      }
    }

    const results: SignalResult[] = [];
    const seenRids = new Set<string>();

    // Traverse via Topic edges
    for (const term of searchTerms) {
      const safeTerm = escapeSQL(term);

      // Topic traversal: Topic → HasTopic → target vertex type
      const topicSql =
        `MATCH {type: Topic, as: t, where: (name = '${safeTerm}')}` +
        `.in('HasTopic'){type: ${vertexType}, as: v, where: (1=1${filterClause})` +
        `} RETURN v`;

      const topicResult = await invokeWithRetry<ArcadeQueryResult>(
        abilities,
        'arcade-query',
        { database, query: topicSql },
      ).catch(() => ({ success: false, result: [] }) as ArcadeQueryResult);

      if (topicResult.success && topicResult.result) {
        for (const row of topicResult.result) {
          const v = (row.v ?? row) as Record<string, unknown>;
          const rid = (v['@rid'] as string) ?? '';
          if (!rid || seenRids.has(rid)) continue;
          seenRids.add(rid);

          results.push({
            rid,
            id: rid,
            content: (v.content as string) ?? '',
            score: 0.6, // Base score for graph traversal results
            importance: (v.importance as number) ?? 0.5,
            matchedVia: ['graph'],
            properties: filterSystemProps(v),
          });
        }
      }

      // Entity traversal: Entity → Mentions → target vertex type
      const entitySql =
        `MATCH {type: Entity, as: e, where: (name = '${safeTerm}')}` +
        `.in('Mentions'){type: ${vertexType}, as: v, where: (1=1${filterClause})` +
        `} RETURN v`;

      const entityResult = await invokeWithRetry<ArcadeQueryResult>(
        abilities,
        'arcade-query',
        { database, query: entitySql },
      ).catch(() => ({ success: false, result: [] }) as ArcadeQueryResult);

      if (entityResult.success && entityResult.result) {
        for (const row of entityResult.result) {
          const v = (row.v ?? row) as Record<string, unknown>;
          const rid = (v['@rid'] as string) ?? '';
          if (!rid || seenRids.has(rid)) continue;
          seenRids.add(rid);

          results.push({
            rid,
            id: rid,
            content: (v.content as string) ?? '',
            score: 0.6,
            importance: (v.importance as number) ?? 0.5,
            matchedVia: ['graph'],
            properties: filterSystemProps(v),
          });
        }
      }

      if (results.length >= limit) break;
    }

    return results.slice(0, limit);
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract potential entity/topic names from a query string.
 *
 * Splits by common delimiters and filters short/stop words.
 * This is a heuristic — more sophisticated NER happens during entity extraction.
 */
function extractSearchTerms(query: string): Set<string> {
  const terms = new Set<string>();

  // Split into words and multi-word phrases
  const words = query.split(/[\s,;:!?]+/).filter((w) => w.length > 2);

  // Add individual words (capitalized ones are likely entities)
  for (const word of words) {
    const clean = word.replace(/['"()[\]{}]/g, '');
    if (clean.length > 2) {
      terms.add(clean);
      terms.add(clean.toLowerCase());
    }
  }

  return terms;
}

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
    if (!key.startsWith('@')) {
      result[key] = value;
    }
  }
  return result;
}

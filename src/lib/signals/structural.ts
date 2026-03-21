/**
 * Structural signal — edge-following expansion from prior results.
 *
 * Takes IDs from prior signals, follows configured structuralEdges,
 * and returns neighboring vertices. This is a dependent signal that
 * requires explicit opt-in and structuralEdges configuration.
 *
 * Returns [] if no structuralEdges config is provided or no prior results exist.
 */

import { invokeWithRetry } from '../retry.js';
import { escapeSQL, buildFilterConditions, filterSystemProps } from '../sql.js';
import type { ArcadeQueryResult, SignalContext, SignalResult } from '../types.js';
import type { SignalImplementation } from './index.js';

// ---------------------------------------------------------------------------
// Signal Implementation
// ---------------------------------------------------------------------------

export const structuralSignal: SignalImplementation = {
  name: 'structural',
  requiresPriorResults: true,

  async execute(ctx: SignalContext): Promise<SignalResult[]> {
    const { abilities, database, vertexType, filters, limit, priorResults, signalConfig } = ctx;

    // Structural signal requires explicit configuration
    const structuralEdges = (signalConfig?.structuralEdges as string[]) ?? [];
    const structuralDepth = (signalConfig?.structuralDepth as number) ?? 1;

    if (structuralEdges.length === 0) {
      return [];
    }

    if (!priorResults || priorResults.length === 0) {
      return [];
    }

    const seenRids = new Set<string>(priorResults.map((r) => r.rid));
    const results: SignalResult[] = [];

    // For each prior result, follow structural edges
    for (const prior of priorResults) {
      if (!prior.rid) continue;

      for (const edgeType of structuralEdges) {
        // Traverse outgoing edges
        const outResults = await traverseEdge(
          abilities, database, prior.rid, edgeType, 'out',
          vertexType, filters, structuralDepth,
        );

        for (const row of outResults) {
          const rid = (row['@rid'] as string) ?? '';
          if (!rid || seenRids.has(rid)) continue;
          seenRids.add(rid);

          results.push({
            rid,
            id: rid,
            content: (row.content as string) ?? '',
            score: 0.4 + Math.random() * 0.1, // Base score 0.4-0.5
            importance: (row.importance as number) ?? 0.5,
            matchedVia: ['structural'],
            properties: filterSystemProps(row),
          });
        }

        // Traverse incoming edges
        const inResults = await traverseEdge(
          abilities, database, prior.rid, edgeType, 'in',
          vertexType, filters, structuralDepth,
        );

        for (const row of inResults) {
          const rid = (row['@rid'] as string) ?? '';
          if (!rid || seenRids.has(rid)) continue;
          seenRids.add(rid);

          results.push({
            rid,
            id: rid,
            content: (row.content as string) ?? '',
            score: 0.4 + Math.random() * 0.1,
            importance: (row.importance as number) ?? 0.5,
            matchedVia: ['structural'],
            properties: filterSystemProps(row),
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
 * Traverse an edge type from a starting vertex in a given direction.
 */
async function traverseEdge(
  abilities: { invoke: <T>(tool: string, params: Record<string, unknown>) => Promise<T> },
  database: string,
  startRid: string,
  edgeType: string,
  direction: 'out' | 'in',
  vertexType: string,
  filters: Record<string, unknown> | undefined,
  depth: number,
): Promise<Array<Record<string, unknown>>> {
  const safeEdge = escapeSQL(edgeType);

  // Build filter clause
  let filterClause = '';
  if (filters && Object.keys(filters).length > 0) {
    const conditions = buildFilterConditions(filters);
    if (conditions) {
      filterClause = `, where: (${conditions})`;
    }
  }

  // MATCH traversal based on direction
  const traversalDir = direction === 'out' ? 'out' : 'in';
  const sql =
    `MATCH {as: start, where: (@rid = ${startRid})}` +
    `.${traversalDir}('${safeEdge}'){type: ${vertexType}, as: neighbor${filterClause}, maxDepth: ${depth}}` +
    ` RETURN neighbor`;

  try {
    const result = await invokeWithRetry<ArcadeQueryResult>(
      abilities,
      'arcade-query',
      { database, query: sql },
    );

    if (!result.success || !result.result) return [];

    return result.result.map((row) => {
      const neighbor = (row.neighbor ?? row) as Record<string, unknown>;
      return neighbor;
    });
  } catch {
    return [];
  }
}

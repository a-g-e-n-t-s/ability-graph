/**
 * Semantic signal — embed query → vectorCosineSimilarity search.
 *
 * Uses the embedding pipeline to generate a query vector, then performs
 * a cosine similarity search against the target vertex type's embedding field.
 */

import { embedTexts } from '../embedder.js';
import { invokeWithRetry } from '../retry.js';
import { escapeSQL, buildFilterConditions, filterSystemProps } from '../sql.js';
import type { ArcadeQueryResult, SignalContext, SignalResult } from '../types.js';
import type { SignalImplementation } from './index.js';

// ---------------------------------------------------------------------------
// Signal Implementation
// ---------------------------------------------------------------------------

export const semanticSignal: SignalImplementation = {
  name: 'semantic',
  requiresPriorResults: false,

  async execute(ctx: SignalContext): Promise<SignalResult[]> {
    const { abilities, database, query, vertexType, filters, limit, embedding } = ctx;

    // Step 1: Embed the query
    const embedResult = await embedTexts(
      abilities,
      [query],
      embedding?.model ?? 'text-embedding-3-small',
      {
        transport: (embedding?.transport as 'broker' | 'api') ?? 'broker',
        apiUrl: embedding?.apiUrl,
        apiKey: embedding?.apiKey,
      },
    );

    if (embedResult.vectors.length === 0 || embedResult.vectors[0].length === 0) {
      return [];
    }

    const queryVector = embedResult.vectors[0];

    // Step 2: Build cosine similarity query
    const vectorStr = `[${queryVector.join(',')}]`;
    let whereClause = '';

    if (filters && Object.keys(filters).length > 0) {
      const conditions = buildFilterConditions(filters);
      if (conditions) {
        whereClause = ` AND ${conditions}`;
      }
    }

    const sql =
      `SELECT *, vectorCosineSimilarity(embedding, ${vectorStr}) AS score` +
      ` FROM ${vertexType}` +
      ` WHERE embedding IS NOT NULL${whereClause}` +
      ` ORDER BY score DESC` +
      ` LIMIT ${limit}`;

    // Step 3: Execute query
    const result = await invokeWithRetry<ArcadeQueryResult>(
      abilities,
      'arcade-query',
      { database, query: sql },
    );

    if (!result.success || !result.result) {
      return [];
    }

    // Step 4: Map results
    return result.result.map((row) => {
      const rid = (row['@rid'] as string) ?? '';
      const score = (row.score as number) ?? 0;
      const content = (row.content as string) ?? '';
      const importance = (row.importance as number) ?? 0.5;
      const props = filterSystemProps(row);

      return {
        rid,
        id: rid,
        content,
        score,
        importance,
        matchedVia: ['semantic'],
        properties: props,
      };
    });
  },
};

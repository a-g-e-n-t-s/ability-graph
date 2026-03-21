/**
 * graph-repair-embeddings tool — find vertices with missing embeddings and
 * re-embed them.
 *
 * Useful after a transient embedding failure where vertices were stored
 * without embedding vectors (batch-store treats embedding errors as non-fatal).
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { embedTexts } from '../lib/embedder.js';
import { extractRid, updateVertex } from '../lib/graph.js';
import { invokeWithRetry } from '../lib/retry.js';
import { schemaRegistry } from '../lib/schema-registry.js';
import type { ArcadeQueryResult, SignalAbilities } from '../lib/types.js';

const MAX_BATCH_SIZE = 100;

export function registerRepairEmbeddingsTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-repair-embeddings',
      description:
        'Find vertices with missing embedding vectors and re-embed them. ' +
        'Useful after a transient failure during batch-store left vertices ' +
        'without embeddings (semantic search cannot find them).',
      input: z.object({
        vertexType: z.string().describe('Vertex type to repair (e.g., DocNode, Memory)'),
        database: z.string().optional().describe('Target database (default: from config)'),
        limit: z.number().optional().describe('Max vertices to repair per invocation (default: 500)'),
        dryRun: z.boolean().optional().describe('If true, only count missing — do not re-embed'),
      }),
    },
    async (input) => {
      const database = input.database ?? config.database;
      const vertexType = input.vertexType;
      const limit = input.limit ?? 500;
      const dryRun = input.dryRun ?? false;

      try {
        // 1. Find vertices with missing embeddings
        const query = `SELECT @rid, content FROM ${vertexType} WHERE embedding IS NULL AND content IS NOT NULL LIMIT ${limit}`;

        const queryResult = await invokeWithRetry<ArcadeQueryResult>(
          abilities,
          'arcade-query',
          { database, query },
        );

        const rows = queryResult.result ?? [];

        if (rows.length === 0) {
          return {
            success: true,
            message: `No ${vertexType} vertices found with missing embeddings.`,
            repaired: 0,
            failed: 0,
          };
        }

        if (dryRun) {
          return {
            success: true,
            message: `Found ${rows.length} ${vertexType} vertices with missing embeddings (dry run — no changes made).`,
            found: rows.length,
            repaired: 0,
            failed: 0,
          };
        }

        // 2. Batch-embed their content
        const texts = rows.map((row) => String(row.content ?? ''));

        console.error(
          `[graph-repair-embeddings] Embedding ${texts.length} ${vertexType} vertices…`,
        );

        const embedResult = await embedTexts(
          abilities,
          texts,
          config.embeddingModel,
          {
            transport: config.embeddingTransport,
            apiUrl: config.apiUrl,
            apiKey: config.apiKey,
          },
        );

        if (embedResult.vectors.length === 0) {
          return {
            success: false,
            error: 'Embedding returned 0 vectors.',
            found: rows.length,
            repaired: 0,
            failed: rows.length,
          };
        }

        // 3. Ensure vector index exists
        try {
          await schemaRegistry.ensureVectorIndex(
            abilities, database, vertexType, embedResult.dimensions,
          );
        } catch {
          // May already exist
        }

        // 4. Update each vertex with its embedding
        let repaired = 0;
        let failed = 0;
        const errors: Array<{ rid: string; error: string }> = [];

        for (let i = 0; i < rows.length; i++) {
          const rid = extractRid(rows[i]);
          const vector = embedResult.vectors[i];

          if (!vector) {
            failed++;
            errors.push({ rid, error: 'No vector returned for this index' });
            continue;
          }

          try {
            await updateVertex(abilities, database, rid, { embedding: vector });
            repaired++;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            failed++;
            errors.push({ rid, error: message });
          }

          if ((repaired + failed) % 50 === 0) {
            console.error(
              `[graph-repair-embeddings] Progress: ${repaired + failed}/${rows.length} (${repaired} repaired, ${failed} failed)`,
            );
          }
        }

        console.error(
          `[graph-repair-embeddings] Done: ${repaired} repaired, ${failed} failed out of ${rows.length} total.`,
        );

        return {
          success: true,
          message: `Repaired ${repaired}/${rows.length} ${vertexType} embeddings (${embedResult.dimensions}d).`,
          found: rows.length,
          repaired,
          failed,
          ...(errors.length > 0 ? { errors: errors.slice(0, 20) } : {}),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-repair-embeddings] ${message}`,
          tool: 'graph-repair-embeddings',
        };
      }
    },
  );
}

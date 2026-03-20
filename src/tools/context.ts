/**
 * graph-context tool — recall + neighbor expansion for richer context.
 *
 * Performs a recall, then expands the top results by traversing the graph
 * to include connected vertices and edges.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { traverseGraph } from '../lib/graph.js';
import { hybridRecall } from '../lib/signals/index.js';
import type { RecallRequest, SignalAbilities } from '../lib/types.js';

export function registerContextTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-context',
      description:
        'Recall vertices then expand via graph traversal for richer context. ' +
        'Returns both the recalled results and their connected neighbors.',
      input: z.object({
        query: z.string().describe('Search query'),
        vertexType: z.string().describe('Vertex type to search'),
        depth: z.number().optional().describe('Traversal depth (default: 1, max: 4)'),
        limit: z.number().optional().describe('Max recalled results to expand (default: 5)'),
        filters: z.record(z.string(), z.unknown()).optional().describe('Additional filters'),
        signals: z.array(z.string()).optional().describe('Recall signals'),
        database: z.string().optional().describe('Target database'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;
        const depth = Math.max(1, Math.min(4, input.depth ?? 1));
        const limit = input.limit ?? 5;

        // Step 1: Recall top results
        const request: RecallRequest = {
          query: input.query,
          vertexType: input.vertexType,
          mode: 'hybrid',
          signals: input.signals ?? ['semantic', 'keyword', 'graph'],
          filters: input.filters,
          limit,
          database,
        };

        const recalled = await hybridRecall(request, abilities, config);

        // Step 2: Expand each result via graph traversal
        const contextResults = [];

        for (const result of recalled) {
          if (!result.rid) continue;

          const graph = await traverseGraph(
            abilities,
            database,
            result.rid,
            depth,
            input.filters,
          );

          contextResults.push({
            ...result,
            neighbors: graph.vertices.filter((v) => v.rid !== result.rid),
            edges: graph.edges,
          });
        }

        return {
          results: contextResults,
          count: contextResults.length,
          depth,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-context] ${message}`,
          tool: 'graph-context',
        };
      }
    },
  );
}

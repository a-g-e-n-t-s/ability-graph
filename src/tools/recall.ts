/**
 * graph-recall tool — N-signal hybrid search over any vertex type.
 *
 * REQUIRES vertexType. No defaults. The calling domain layer must always specify it.
 *
 * Delegates to hybridRecall() for the signal engine.
 * Default signals: ['semantic', 'keyword', 'graph']. Structural only if explicit.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { hybridRecall } from '../lib/signals/index.js';
import type { RecallRequest, SignalAbilities } from '../lib/types.js';

export function registerRecallTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-recall',
      description:
        'Search the graph using N-signal hybrid recall. Supports semantic, keyword, ' +
        'graph traversal, and structural signals. Requires vertexType — no default.',
      input: z.object({
        query: z.string().describe('Search query text'),
        vertexType: z.string().describe('REQUIRED: vertex type to search'),
        mode: z.enum(['semantic', 'keyword', 'graph', 'hybrid']).optional()
          .describe('Search mode (default: hybrid)'),
        signals: z.array(z.string()).optional()
          .describe('Signals for hybrid mode (default: semantic, keyword, graph)'),
        structuralEdges: z.array(z.string()).optional()
          .describe('Edge types for structural signal'),
        structuralDepth: z.number().optional()
          .describe('Expansion hops for structural (default: 1)'),
        structuralTopK: z.number().optional()
          .describe('Expand from top N results for structural (default: 5)'),
        filters: z.record(z.string(), z.unknown()).optional()
          .describe('Additional WHERE clause filters'),
        limit: z.number().optional().describe('Max results (default: 10)'),
        database: z.string().optional().describe('Target database'),
        embedding: z.object({
          model: z.string().optional(),
          transport: z.enum(['broker', 'api']).optional(),
          apiUrl: z.string().optional(),
          apiKey: z.string().optional(),
        }).optional().describe('Embedding configuration'),
      }),
    },
    async (input) => {
      try {
        if (!input.vertexType) {
          throw new Error('vertexType is required — the calling domain layer must specify it');
        }

        const mode = input.mode ?? 'hybrid';

        // For single-mode, use only that signal
        let signals: string[];
        if (mode === 'hybrid') {
          signals = input.signals ?? ['semantic', 'keyword', 'graph'];
        } else {
          signals = [mode];
        }

        const request: RecallRequest = {
          query: input.query,
          vertexType: input.vertexType,
          mode,
          signals,
          structuralEdges: input.structuralEdges,
          structuralDepth: input.structuralDepth,
          structuralTopK: input.structuralTopK,
          filters: input.filters,
          limit: input.limit ?? 10,
          database: input.database ?? config.database,
          embedding: input.embedding ?? {
            model: config.embeddingModel,
            transport: config.embeddingTransport,
            apiUrl: config.apiUrl,
            apiKey: config.apiKey,
          },
        };

        const results = await hybridRecall(request, abilities, config, signals);

        return {
          results,
          count: results.length,
          mode,
          signals,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-recall] ${message}`,
          tool: 'graph-recall',
        };
      }
    },
  );
}

/**
 * graph-relate tool — create a typed edge between two vertices.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { createEdge } from '../lib/graph.js';
import type { SignalAbilities } from '../lib/types.js';

export function registerRelateTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-relate',
      description:
        'Create a typed edge between two vertices. Uses IF NOT EXISTS to avoid duplicates.',
      input: z.object({
        edgeType: z.string().describe('Edge type name (e.g., RelatedTo, HasTopic)'),
        fromRid: z.string().describe('Source vertex RID'),
        toRid: z.string().describe('Target vertex RID'),
        properties: z.record(z.string(), z.unknown()).optional()
          .describe('Edge properties'),
        database: z.string().optional().describe('Target database'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;

        await createEdge(
          abilities,
          database,
          input.edgeType,
          input.fromRid,
          input.toRid,
          input.properties,
        );

        return {
          success: true,
          edgeType: input.edgeType,
          from: input.fromRid,
          to: input.toRid,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-relate] ${message}`,
          tool: 'graph-relate',
        };
      }
    },
  );
}

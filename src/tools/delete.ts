/**
 * graph-delete tool — delete a vertex with optional cascade of orphaned entities.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { deleteVertex, findOrphans } from '../lib/graph.js';
import type { SignalAbilities } from '../lib/types.js';

export function registerDeleteTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-delete',
      description:
        'Delete a vertex by RID. Optionally cascade-deletes orphaned Topic/Entity ' +
        'vertices that have no remaining edges after the deletion.',
      input: z.object({
        rid: z.string().describe('RID of the vertex to delete'),
        cascade: z.boolean().optional()
          .describe('Delete orphaned Topics/Entities after removal (default: false)'),
        database: z.string().optional().describe('Target database'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;

        // Delete the vertex
        await deleteVertex(abilities, database, input.rid);

        let orphansDeleted = 0;

        // Cascade: delete orphaned Topics and Entities
        if (input.cascade) {
          const orphanRids = await findOrphans(abilities, database);

          for (const orphanRid of orphanRids) {
            try {
              await deleteVertex(abilities, database, orphanRid);
              orphansDeleted++;
            } catch {
              // Continue on orphan deletion failure
            }
          }
        }

        return {
          success: true,
          deleted: input.rid,
          orphansDeleted,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-delete] ${message}`,
          tool: 'graph-delete',
        };
      }
    },
  );
}

/**
 * graph-query tool — read-only SQL query passthrough to ArcadeDB.
 *
 * Allows executing SELECT, MATCH, and TRAVERSE queries directly against the
 * graph database. All invocations use invokeWithRetry for automatic retry
 * with exponential backoff.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { invokeWithRetry } from '../lib/retry.js';
import type { ArcadeQueryResult, SignalAbilities } from '../lib/types.js';

export function registerQueryTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-query',
      description:
        'Execute a read-only SQL query against the graph database. Returns raw result rows. ' +
        'Use for SELECT, MATCH, and TRAVERSE queries.',
      input: z.object({
        query: z.string().describe('The read-only SQL query to execute'),
        database: z.string().optional().describe('Target database (default: from config)'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;

        const response = await invokeWithRetry<ArcadeQueryResult>(
          abilities,
          'arcade-query',
          { database, query: input.query },
        );

        return {
          success: true,
          result: response.result ?? [],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-query] ${message}`,
          tool: 'graph-query',
        };
      }
    },
  );
}

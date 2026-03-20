/**
 * graph-command tool — write SQL command passthrough to ArcadeDB.
 *
 * Allows executing CREATE, UPDATE, DELETE, and other mutating SQL operations
 * directly against the graph database. All invocations use invokeWithRetry
 * for automatic retry with exponential backoff.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { invokeWithRetry } from '../lib/retry.js';
import type { ArcadeCommandResult, SignalAbilities } from '../lib/types.js';

export function registerCommandTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-command',
      description:
        'Execute a write SQL command against the graph database. Use for CREATE, UPDATE, ' +
        'DELETE, and other mutating operations.',
      input: z.object({
        command: z.string().describe('The SQL command to execute'),
        database: z.string().optional().describe('Target database (default: from config)'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;

        const response = await invokeWithRetry<ArcadeCommandResult>(
          abilities,
          'arcade-command',
          { database, command: input.command },
        );

        return {
          success: true,
          result: response.result,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-command] ${message}`,
          tool: 'graph-command',
        };
      }
    },
  );
}

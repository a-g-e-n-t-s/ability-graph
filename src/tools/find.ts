/**
 * graph-find tool — higher-level vertex lookup by type and filter conditions.
 *
 * Builds a SQL SELECT query from structured inputs, providing a simpler
 * alternative to graph-query for common vertex lookups. All string values
 * are escaped via escapeSQL to prevent injection.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { invokeWithRetry } from '../lib/retry.js';
import { escapeSQL } from '../lib/sql.js';
import type { ArcadeQueryResult, SignalAbilities } from '../lib/types.js';

export function registerFindTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-find',
      description:
        'Find vertices by type and optional filter conditions. Returns matching vertices ' +
        'with their properties. Simpler alternative to graph-query for common lookups.',
      input: z.object({
        vertexType: z.string().describe('REQUIRED: vertex type to search (e.g., Memory, DocNode)'),
        filters: z.record(z.string(), z.unknown()).optional()
          .describe('WHERE conditions as key-value pairs'),
        orderBy: z.string().optional()
          .describe('ORDER BY clause (e.g., "timestamp DESC")'),
        limit: z.number().optional().describe('Max results (default: 100)'),
        fields: z.array(z.string()).optional()
          .describe('Specific fields to return (default: all)'),
        database: z.string().optional().describe('Target database (default: from config)'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;
        const fields = input.fields?.join(', ') ?? '*';
        const limit = input.limit ?? 100;

        // Build SELECT query
        let query = `SELECT ${fields} FROM \`${escapeSQL(input.vertexType)}\``;

        // Build WHERE clause from filters
        if (input.filters && Object.keys(input.filters).length > 0) {
          const conditions: string[] = [];

          for (const [key, value] of Object.entries(input.filters)) {
            if (value === null || value === undefined) {
              conditions.push(`${key} IS NULL`);
            } else if (key === '@rid' || key === 'rid') {
              // RIDs are not quoted
              conditions.push(`@rid = ${String(value)}`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
              conditions.push(`${key} = ${value}`);
            } else {
              conditions.push(`${key} = '${escapeSQL(String(value))}'`);
            }
          }

          query += ` WHERE ${conditions.join(' AND ')}`;
        }

        // ORDER BY
        if (input.orderBy) {
          query += ` ORDER BY ${input.orderBy}`;
        }

        // LIMIT
        query += ` LIMIT ${limit}`;

        const response = await invokeWithRetry<ArcadeQueryResult>(
          abilities,
          'arcade-query',
          { database, query },
        );

        const results = response.result ?? [];

        return {
          success: true,
          results,
          count: results.length,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-find] ${message}`,
          tool: 'graph-find',
        };
      }
    },
  );
}

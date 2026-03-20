/**
 * graph-count tool — count vertices by type with optional filters and grouping.
 *
 * Builds a SQL COUNT query from structured inputs. Supports optional WHERE
 * conditions and GROUP BY for aggregated counts. All string values are escaped
 * via escapeSQL to prevent injection.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { invokeWithRetry } from '../lib/retry.js';
import { escapeSQL } from '../lib/sql.js';
import type { ArcadeQueryResult, SignalAbilities } from '../lib/types.js';

export function registerCountTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-count',
      description:
        'Count vertices of a given type with optional filter conditions. Returns the count ' +
        'and optionally grouped counts.',
      input: z.object({
        vertexType: z.string().describe('REQUIRED: vertex type to count (e.g., Memory, DocNode)'),
        filters: z.record(z.string(), z.unknown()).optional()
          .describe('WHERE conditions as key-value pairs'),
        groupBy: z.string().optional()
          .describe('Field to group by for grouped counts'),
        database: z.string().optional().describe('Target database (default: from config)'),
      }),
    },
    async (input) => {
      try {
        const database = input.database ?? config.database;

        // Build WHERE clause from filters
        let whereClause = '';
        if (input.filters && Object.keys(input.filters).length > 0) {
          const conditions: string[] = [];

          for (const [key, value] of Object.entries(input.filters)) {
            if (value === null || value === undefined) {
              conditions.push(`${key} IS NULL`);
            } else if (key === '@rid' || key === 'rid') {
              conditions.push(`@rid = ${String(value)}`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
              conditions.push(`${key} = ${value}`);
            } else {
              conditions.push(`${key} = '${escapeSQL(String(value))}'`);
            }
          }

          whereClause = ` WHERE ${conditions.join(' AND ')}`;
        }

        let query: string;

        if (input.groupBy) {
          // Grouped count query
          query = `SELECT ${input.groupBy}, count(*) AS count FROM \`${escapeSQL(input.vertexType)}\`${whereClause} GROUP BY ${input.groupBy}`;
        } else {
          // Simple total count query
          query = `SELECT count(*) AS total FROM \`${escapeSQL(input.vertexType)}\`${whereClause}`;
        }

        const response = await invokeWithRetry<ArcadeQueryResult>(
          abilities,
          'arcade-query',
          { database, query },
        );

        const rows = response.result ?? [];

        if (input.groupBy) {
          // Build grouped results
          const groups: Record<string, number> = {};
          let total = 0;

          for (const row of rows) {
            const groupKey = String(row[input.groupBy] ?? 'unknown');
            const count = Number(row.count ?? 0);
            groups[groupKey] = count;
            total += count;
          }

          return {
            success: true,
            total,
            groups,
          };
        }

        // Simple count
        const total = Number(rows[0]?.total ?? 0);

        return {
          success: true,
          total,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-count] ${message}`,
          tool: 'graph-count',
        };
      }
    },
  );
}

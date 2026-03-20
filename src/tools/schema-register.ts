/**
 * graph-schema-register tool — register a schema definition with the graph engine.
 *
 * Takes a SchemaDefinition, registers it with the schema registry, and applies
 * DDL to ArcadeDB idempotently via ensureInfrastructure().
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { schemaRegistry } from '../lib/schema-registry.js';
import type { SchemaDefinition, SignalAbilities } from '../lib/types.js';

export function registerSchemaRegisterTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-schema-register',
      description:
        'Register a schema definition (vertex types, edge types, indexes) with the graph engine. ' +
        'Applies DDL to ArcadeDB idempotently — safe to call multiple times.',
      input: z.object({
        name: z.string().describe('Unique schema name'),
        database: z.string().optional().describe('Target database (default: from config)'),
        vertexTypes: z.array(z.object({
          name: z.string(),
          properties: z.record(z.string(), z.string()),
          indexes: z.array(z.object({
            property: z.string(),
            type: z.enum(['UNIQUE', 'NOTUNIQUE', 'FULL_TEXT']),
          })).optional(),
        })).describe('Vertex type definitions'),
        edgeTypes: z.array(z.object({
          name: z.string(),
          properties: z.record(z.string(), z.string()).optional(),
        })).describe('Edge type definitions'),
        entityTypes: z.array(z.string()).optional().describe('Allowed entity types'),
      }),
    },
    async (input) => {
      const startTime = Date.now();

      try {
        const schemaDef: SchemaDefinition = {
          name: input.name,
          database: input.database ?? config.database,
          vertexTypes: input.vertexTypes,
          edgeTypes: input.edgeTypes,
          entityTypes: input.entityTypes,
        };

        // Register the schema
        schemaRegistry.register(schemaDef);

        // Apply DDL to ArcadeDB
        const database = schemaDef.database ?? config.database;
        await schemaRegistry.ensureInfrastructure(abilities, database);

        return {
          success: true,
          schema: input.name,
          database,
          vertexTypes: input.vertexTypes.map((vt) => vt.name),
          edgeTypes: input.edgeTypes.map((et) => et.name),
          durationMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-schema-register] ${message}`,
          tool: 'graph-schema-register',
          durationMs: Date.now() - startTime,
        };
      }
    },
  );
}

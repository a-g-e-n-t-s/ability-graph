/**
 * graph-schema-list tool — list all registered schemas.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { schemaRegistry } from '../lib/schema-registry.js';

export function registerSchemaListTool(
  client: KadiClient,
  _config: GraphConfig,
): void {
  client.registerTool(
    {
      name: 'graph-schema-list',
      description: 'List all registered graph schemas and their definitions.',
      input: z.object({}),
    },
    async () => {
      const names = schemaRegistry.list();
      const schemas = names.map((name) => {
        const def = schemaRegistry.get(name);
        return {
          name,
          database: def?.database,
          vertexTypes: def?.vertexTypes.map((vt) => vt.name) ?? [],
          edgeTypes: def?.edgeTypes.map((et) => et.name) ?? [],
          entityTypes: def?.entityTypes ?? [],
        };
      });

      return {
        schemas,
        count: schemas.length,
      };
    },
  );
}

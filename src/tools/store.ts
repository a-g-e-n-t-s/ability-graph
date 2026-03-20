/**
 * graph-store tool — store a vertex with optional extraction, embedding, and edge creation.
 *
 * REQUIRES vertexType. No defaults. The calling domain layer must always specify it.
 *
 * Pipeline: extract metadata → embed content → create vertex (CONTENT JSON) →
 * upsert Topics/Entities → create edges.
 *
 * All DB calls use invokeWithRetry for automatic retry with exponential backoff.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { embedTexts } from '../lib/embedder.js';
import { extractMetadata } from '../lib/extractor.js';
import {
  createEdge,
  createVertex,
  extractRid,
  queryVertices,
  upsertEntity,
  upsertTopic,
} from '../lib/graph.js';
import { schemaRegistry } from '../lib/schema-registry.js';
import type { SignalAbilities } from '../lib/types.js';

export function registerStoreTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-store',
      description:
        'Store a vertex in the graph with automatic entity extraction, embedding, ' +
        'and graph linking. Requires vertexType — no default.',
      input: z.object({
        content: z.string().describe('The content to store'),
        vertexType: z.string().describe('REQUIRED: vertex type name (e.g., Memory, DocNode)'),
        properties: z.record(z.string(), z.unknown()).optional().describe('Additional properties'),
        topics: z.array(z.string()).optional().describe('Explicit topics (skip extraction)'),
        entities: z.array(z.object({
          name: z.string(),
          type: z.string(),
        })).optional().describe('Explicit entities (skip extraction)'),
        edges: z.array(z.object({
          type: z.string(),
          direction: z.enum(['out', 'in']),
          targetRid: z.string().optional(),
          targetQuery: z.object({
            vertexType: z.string(),
            where: z.record(z.string(), z.unknown()),
          }).optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
        })).optional().describe('Edges to create from/to this vertex'),
        database: z.string().optional().describe('Target database (default: from config)'),
        skipExtraction: z.boolean().optional().describe('Skip LLM extraction entirely'),
        importance: z.number().optional().describe('Importance score 0-1'),
        embedding: z.object({
          model: z.string().optional(),
          transport: z.enum(['broker', 'api']).optional(),
          apiUrl: z.string().optional(),
          apiKey: z.string().optional(),
        }).optional().describe('Embedding configuration'),
      }),
    },
    async (input) => {
      const startTime = Date.now();

      try {
        if (!input.vertexType) {
          throw new Error('vertexType is required — the calling domain layer must specify it');
        }

        const database = input.database ?? config.database;

        // Step 1: Extract metadata if needed
        let topics = input.topics ?? [];
        let entities = input.entities ?? [];
        let importance = input.importance ?? 0.5;

        if (!input.skipExtraction && topics.length === 0 && entities.length === 0) {
          const extraction = await extractMetadata(
            abilities,
            input.content,
            config.extractionModel,
            {
              transport: config.chatTransport,
              apiUrl: config.apiUrl,
              apiKey: config.apiKey,
            },
          );
          topics = extraction.topics;
          entities = extraction.entities;
          if (input.importance === undefined) {
            importance = extraction.importance;
          }
        }

        // Step 2: Embed content
        const embeddingConfig = input.embedding ?? {
          model: config.embeddingModel,
          transport: config.embeddingTransport,
        };

        const { vectors, dimensions } = await embedTexts(
          abilities,
          [input.content],
          embeddingConfig.model ?? config.embeddingModel,
          {
            transport: embeddingConfig.transport ?? config.embeddingTransport,
            apiUrl: embeddingConfig.apiUrl ?? config.apiUrl,
            apiKey: embeddingConfig.apiKey ?? config.apiKey,
          },
        );

        // Ensure vector index exists (lazy)
        if (dimensions > 0) {
          await schemaRegistry.ensureVectorIndex(abilities, database, input.vertexType, dimensions);
        }

        // Step 3: Create vertex using CONTENT JSON
        const vertexProps: Record<string, unknown> = {
          content: input.content,
          importance,
          ...(input.properties ?? {}),
        };

        if (vectors.length > 0 && vectors[0].length > 0) {
          vertexProps.embedding = vectors[0];
        }

        const vertexRid = await createVertex(
          abilities,
          database,
          input.vertexType,
          vertexProps,
        );

        // Step 4: Upsert Topics and create HasTopic edges
        for (const topicName of topics) {
          try {
            const topicRid = await upsertTopic(abilities, database, topicName);
            await createEdge(abilities, database, 'HasTopic', vertexRid, topicRid, { weight: 1.0 });
          } catch (err) {
            console.warn(`[graph-store] Failed to create topic "${topicName}":`, err);
          }
        }

        // Step 5: Upsert Entities and create Mentions edges
        for (const entity of entities) {
          try {
            const entityRid = await upsertEntity(abilities, database, entity.name, entity.type);
            await createEdge(abilities, database, 'Mentions', vertexRid, entityRid);
          } catch (err) {
            console.warn(`[graph-store] Failed to create entity "${entity.name}":`, err);
          }
        }

        // Step 6: Create explicit edges
        if (input.edges && input.edges.length > 0) {
          for (const edge of input.edges) {
            try {
              let targetRid = edge.targetRid;

              // Resolve target by query if needed
              if (!targetRid && edge.targetQuery) {
                const whereConditions = Object.entries(edge.targetQuery.where)
                  .map(([k, v]) => {
                    if (typeof v === 'string') return `${k} = '${v}'`;
                    return `${k} = ${v}`;
                  })
                  .join(' AND ');

                const targets = await queryVertices(
                  abilities, database, edge.targetQuery.vertexType,
                  whereConditions, 1,
                );

                if (targets.length > 0) {
                  targetRid = extractRid(targets[0]);
                }
              }

              if (targetRid) {
                const fromRid = edge.direction === 'out' ? vertexRid : targetRid;
                const toRid = edge.direction === 'out' ? targetRid : vertexRid;
                await createEdge(abilities, database, edge.type, fromRid, toRid, edge.properties);
              }
            } catch (err) {
              console.warn(`[graph-store] Failed to create edge "${edge.type}":`, err);
            }
          }
        }

        return {
          stored: true,
          rid: vertexRid,
          vertexType: input.vertexType,
          topics,
          entities,
          importance,
          embeddingDimensions: dimensions,
          durationMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          stored: false,
          error: `[graph-store] ${message}`,
          tool: 'graph-store',
          durationMs: Date.now() - startTime,
        };
      }
    },
  );
}

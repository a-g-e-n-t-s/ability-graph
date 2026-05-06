/**
 * Explorer API handlers.
 *
 * Each handler is an async function that takes a standardized context and
 * returns a plain object. Error handling wraps each in try/catch returning
 * `{ success: false, error: message }`.
 *
 * All ArcadeDB calls go through `invokeWithRetry` for automatic retry with
 * exponential backoff. Graph operations use existing helpers from src/lib/.
 */

import { invokeWithRetry } from '../lib/retry.js';
import { traverseGraph, filterSystemProps } from '../lib/graph.js';
import { hybridRecall } from '../lib/signals/index.js';
import { schemaRegistry } from '../lib/schema-registry.js';
import { getAllTemplates, getTemplatesForSchema } from './templates.js';
import {
  computeProjection,
  getCachedProjection,
  clearProjectionCacheFor,
} from './projection.js';
import type { SignalAbilities, ArcadeQueryResult, ArcadeCommandResult } from '../lib/types.js';
import type { GraphConfig } from '../lib/config.js';
import type { KadiClient } from '@kadi.build/core';

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

export interface ExplorerContext {
  abilities: SignalAbilities;
  graphConfig: GraphConfig;
  client: KadiClient;
}

// ---------------------------------------------------------------------------
// API Handlers
// ---------------------------------------------------------------------------

/**
 * List all databases.
 * GET /api/databases
 */
export async function handleDatabases(
  ctx: ExplorerContext,
): Promise<Record<string, unknown>> {
  try {
    const result = await invokeWithRetry(ctx.abilities, 'arcade-db-list', {});
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Get schema info for a database.
 * GET /api/schema/:db
 */
export async function handleSchema(
  ctx: ExplorerContext,
  database: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await invokeWithRetry(ctx.abilities, 'arcade-db-info', { database });
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Discover properties for one or more types by sampling 1 row from each.
 * POST /api/type-properties
 * Body: { database: string, types: string[] }
 * Returns: { success: true, types: { [typeName]: { properties: string[], hasEmbedding: boolean } } }
 */
export async function handleTypeProperties(
  ctx: ExplorerContext,
  body: { database: string; types: string[] },
): Promise<Record<string, unknown>> {
  try {
    const typeInfo: Record<string, { properties: string[]; hasEmbedding: boolean }> = {};
    const probes = body.types.map(async (typeName) => {
      try {
        const result = await invokeWithRetry<ArcadeQueryResult>(
          ctx.abilities,
          'arcade-query',
          { database: body.database, query: `SELECT * FROM ${typeName} LIMIT 1` },
        );
        const rows = result.result ?? [];
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          // Extract property names, excluding ArcadeDB internal @ fields
          const props = Object.keys(row).filter(k => !k.startsWith('@'));
          const hasEmbedding = props.includes('embedding');
          typeInfo[typeName] = { properties: props, hasEmbedding };
        } else {
          typeInfo[typeName] = { properties: [], hasEmbedding: false };
        }
      } catch {
        typeInfo[typeName] = { properties: [], hasEmbedding: false };
      }
    });
    await Promise.all(probes);
    return { success: true, types: typeInfo };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Get stats for a database.
 * GET /api/stats/:db
 */
export async function handleStats(
  ctx: ExplorerContext,
  database: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await invokeWithRetry(ctx.abilities, 'arcade-db-stats', { database });
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Execute a query (SELECT / MATCH / TRAVERSE).
 * POST /api/query
 */
export async function handleQuery(
  ctx: ExplorerContext,
  body: { database: string; query: string; language?: string },
): Promise<Record<string, unknown>> {
  try {
    const params: Record<string, unknown> = {
      database: body.database,
      query: body.query,
    };
    if (body.language) params.language = body.language;

    const result = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      params,
    );
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Execute a command (CREATE / UPDATE / DELETE).
 * POST /api/command
 */
export async function handleCommand(
  ctx: ExplorerContext,
  body: { database: string; command: string; language?: string },
): Promise<Record<string, unknown>> {
  try {
    const params: Record<string, unknown> = {
      database: body.database,
      command: body.command,
    };
    if (body.language) params.language = body.language;

    const result = await invokeWithRetry<ArcadeCommandResult>(
      ctx.abilities,
      'arcade-command',
      params,
    );
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Traverse the graph from a starting vertex.
 * POST /api/traverse
 */
export async function handleTraverse(
  ctx: ExplorerContext,
  body: { database: string; startRid: string; depth: number; filters?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  try {
    const result = await traverseGraph(
      ctx.abilities,
      body.database,
      body.startRid,
      body.depth,
      body.filters,
    );
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Get neighbors of a vertex.
 * POST /api/neighbors
 */
export async function handleNeighbors(
  ctx: ExplorerContext,
  body: { database: string; rid: string; edgeTypes?: string[]; direction?: 'both' | 'in' | 'out' },
): Promise<Record<string, unknown>> {
  try {
    const direction = body.direction ?? 'both';
    const expandFn = direction === 'both' ? 'bothE' : direction === 'in' ? 'inE' : 'outE';

    // Get edges
    const edgeSql = `SELECT expand(${expandFn}(${body.edgeTypes ? `'${body.edgeTypes.join("','")}'` : ''})) FROM ${body.rid}`;
    const edgeResult = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: body.database, query: edgeSql },
    );

    // Get connected vertices
    const vertexFn = direction === 'both' ? 'both' : direction === 'in' ? 'in' : 'out';
    const vertexSql = `SELECT expand(${vertexFn}(${body.edgeTypes ? `'${body.edgeTypes.join("','")}'` : ''})) FROM ${body.rid}`;
    const vertexResult = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: body.database, query: vertexSql },
    );

    const edges = (edgeResult.result ?? []).map((row) => ({
      rid: (row['@rid'] as string) ?? '',
      type: (row['@type'] as string) ?? '',
      from: (row['@out'] as string) ?? '',
      to: (row['@in'] as string) ?? '',
      properties: filterSystemProps(row),
    }));

    const vertices = (vertexResult.result ?? []).map((row) => ({
      rid: (row['@rid'] as string) ?? '',
      type: (row['@type'] as string) ?? '',
      properties: filterSystemProps(row),
    }));

    return { success: true, result: { vertices, edges } };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Hybrid search.
 * POST /api/search
 */
export async function handleSearch(
  ctx: ExplorerContext,
  body: {
    database: string;
    query: string;
    vertexType: string;
    mode?: string;
    signals?: string[];
    limit?: number;
  },
): Promise<Record<string, unknown>> {
  try {
    const result = await hybridRecall(
      {
        query: body.query,
        vertexType: body.vertexType,
        mode: (body.mode as 'hybrid' | 'semantic' | 'keyword' | 'graph') ?? 'hybrid',
        signals: body.signals,
        limit: body.limit ?? 10,
        database: body.database,
      },
      ctx.abilities,
      ctx.graphConfig,
      body.signals,
    );
    return { success: true, result };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * List registered schemas.
 * GET /api/schemas
 */
export async function handleRegisteredSchemas(
  _ctx: ExplorerContext,
): Promise<Record<string, unknown>> {
  try {
    const names = schemaRegistry.list();
    const schemas: Record<string, unknown>[] = [];
    for (const name of names) {
      const def = schemaRegistry.get(name);
      if (def) {
        schemas.push({
          name: def.name,
          database: def.database,
          vertexTypes: def.vertexTypes.map((vt) => ({
            name: vt.name,
            properties: vt.properties,
            indexes: vt.indexes ?? [],
          })),
          edgeTypes: def.edgeTypes.map((et) => ({
            name: et.name,
            properties: et.properties ?? {},
          })),
          entityTypes: def.entityTypes ?? [],
        });
      }
    }
    return { success: true, result: schemas };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Return query templates.
 * GET /api/templates       → all templates
 * GET /api/templates/:schema → filtered by schema (+ general)
 */
export function handleTemplates(
  _ctx: ExplorerContext,
  schema?: string,
): Record<string, unknown> {
  const templates = schema
    ? getTemplatesForSchema(schema)
    : getAllTemplates();
  return { success: true, templates };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Phase 3: Vector & Broker Handlers
// ---------------------------------------------------------------------------

/**
 * Embed text via create-embedding tool.
 * POST /api/embed
 */
export async function handleEmbed(
  ctx: ExplorerContext,
  body: { text: string },
): Promise<Record<string, unknown>> {
  try {
    if (!body.text) {
      return { success: false, error: 'Missing required field: text' };
    }

    const params: Record<string, unknown> = {
      input: body.text,
      model: ctx.graphConfig.embeddingModel || 'text-embedding-3-small',
    };

    // Always pass API key when available — model-manager may have
    // REQUIRE_USER_KEY enabled regardless of transport mode.
    // Note: the broker schema uses snake_case `api_key`, not camelCase.
    if (ctx.graphConfig.apiKey) params.api_key = ctx.graphConfig.apiKey;
    if (ctx.graphConfig.embeddingTransport === 'api' && ctx.graphConfig.apiUrl) {
      params.apiUrl = ctx.graphConfig.apiUrl;
    }

    const result = await invokeWithRetry<Record<string, unknown>>(
      ctx.abilities,
      'create-embedding',
      params,
    );

    // Extract embedding from result — handle different response shapes
    let embedding: number[] | undefined;
    if (Array.isArray(result)) {
      embedding = result as number[];
    } else if (result && typeof result === 'object') {
      if (Array.isArray((result as Record<string, unknown>).embedding)) {
        embedding = (result as Record<string, unknown>).embedding as number[];
      } else if (Array.isArray((result as Record<string, unknown>).data)) {
        const data = (result as Record<string, unknown>).data as Array<Record<string, unknown>>;
        if (data.length > 0 && Array.isArray(data[0].embedding)) {
          embedding = data[0].embedding as number[];
        }
      } else if (Array.isArray((result as Record<string, unknown>).vectors)) {
        const vectors = (result as Record<string, unknown>).vectors as number[][];
        if (vectors.length > 0) embedding = vectors[0];
      }
    }

    if (!embedding || embedding.length === 0) {
      return { success: false, error: 'Embedding service returned no data', raw: result };
    }

    return {
      success: true,
      embedding,
      model: ctx.graphConfig.embeddingModel || 'text-embedding-3-small',
      dimensions: embedding.length,
    };
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes('not found') || msg.includes('not available') || msg.includes('ABILITY_NOT_FOUND')) {
      return { success: false, error: 'Embedding service not available' };
    }
    return { success: false, error: msg };
  }
}

/**
 * Find similar vertices via vector search.
 * POST /api/similar
 */
export async function handleSimilar(
  ctx: ExplorerContext,
  body: {
    database: string;
    vertexType: string;
    text?: string;
    embedding?: number[];
    limit?: number;
  },
): Promise<Record<string, unknown>> {
  try {
    const { database, vertexType, limit = 10 } = body;
    let { embedding } = body;

    if (!database || !vertexType) {
      return { success: false, error: 'Missing required fields: database, vertexType' };
    }

    // If text provided but no embedding, embed it first
    if (body.text && !embedding) {
      const embedResult = await handleEmbed(ctx, { text: body.text });
      if (!embedResult.success) {
        return embedResult;
      }
      embedding = embedResult.embedding as number[];
    }

    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
      return { success: false, error: 'No embedding provided and no text to embed' };
    }

    // Try vector search SQL first
    const vectorStr = `[${embedding.join(',')}]`;
    try {
      const sql = `SELECT *, vectorSearch('embedding', ${vectorStr}, ${limit}) as score FROM ${vertexType}`;
      const queryResult = await invokeWithRetry<ArcadeQueryResult>(
        ctx.abilities,
        'arcade-query',
        { database, query: sql },
      );

      if (queryResult.success && queryResult.result && queryResult.result.length > 0) {
        const results = queryResult.result.map((row) => ({
          rid: (row['@rid'] as string) ?? '',
          score: (row.score as number) ?? 0,
          properties: filterSystemProps(row),
        }));
        return { success: true, results };
      }
    } catch {
      // vectorSearch function not available — fall back
    }

    // Fallback: fetch vertices with embeddings and compute cosine similarity in JS
    try {
      const fallbackSql = `SELECT @rid, @type, name, content, embedding FROM ${vertexType} WHERE embedding IS NOT NULL LIMIT 200`;
      const fallbackResult = await invokeWithRetry<ArcadeQueryResult>(
        ctx.abilities,
        'arcade-query',
        { database, query: fallbackSql },
      );

      const rows = fallbackResult.result ?? [];
      if (rows.length === 0) {
        return { success: true, results: [] };
      }

      const scored = rows
        .map((row) => {
          const rowEmb = row.embedding as number[] | undefined;
          if (!rowEmb || !Array.isArray(rowEmb)) return null;
          const score = cosineSimilarity(embedding!, rowEmb);
          const props: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            if (!k.startsWith('@') && k !== 'embedding') {
              props[k] = v;
            }
          }
          return {
            rid: (row['@rid'] as string) ?? '',
            score,
            properties: props,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return { success: true, results: scored };
    } catch (err: unknown) {
      return { success: false, error: `Fallback similarity search failed: ${errorMessage(err)}` };
    }
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Get cached or freshly computed 2D projection for a vertex type.
 * GET /api/projection/:db/:type
 */
export async function handleProjection(
  ctx: ExplorerContext,
  database: string,
  vertexType: string,
  filter?: string,
): Promise<Record<string, unknown>> {
  try {
    // Check cache (< 1 hour old)
    const cached = getCachedProjection(database, vertexType, filter);
    if (cached) {
      return { success: true, ...cached, cached: true };
    }

    const result = await computeProjection(ctx.abilities, database, vertexType, filter);
    return { success: true, ...result, cached: false };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * Force recompute 2D projection for a vertex type.
 * POST /api/projection/:db/:type
 */
export async function handleRefreshProjection(
  ctx: ExplorerContext,
  database: string,
  vertexType: string,
  filter?: string,
): Promise<Record<string, unknown>> {
  try {
    clearProjectionCacheFor(database, vertexType, filter);
    const result = await computeProjection(ctx.abilities, database, vertexType, filter);
    return { success: true, ...result, cached: false };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * List agents on the broker that provide ArcadeDB tools.
 * GET /api/broker/agents
 */
export async function handleBrokerAgents(
  ctx: ExplorerContext,
): Promise<Record<string, unknown>> {
  try {
    // Try to discover agents via the broker by invoking kadi-list-tools
    // or checking the client for available methods
    const client = ctx.client as unknown as Record<string, unknown>;

    // Method 1: Try client.listAgents() if available
    if (typeof client.listAgents === 'function') {
      try {
        const agents = await (client.listAgents as () => Promise<unknown[]>)();
        return { success: true, agents: formatAgents(agents) };
      } catch {
        // Fall through to other methods
      }
    }

    // Method 2: Try client.getAgents() if available
    if (typeof client.getAgents === 'function') {
      try {
        const agents = await (client.getAgents as () => Promise<unknown[]>)();
        return { success: true, agents: formatAgents(agents) };
      } catch {
        // Fall through
      }
    }

    // Method 3: Try invoking broker-list-agents tool
    try {
      const result = await invokeWithRetry<Record<string, unknown>>(
        ctx.abilities,
        'broker-list-agents',
        {},
      );
      if (result && (Array.isArray(result) || (result as Record<string, unknown>).agents)) {
        const agents = Array.isArray(result) ? result : (result as Record<string, unknown>).agents;
        return { success: true, agents: formatAgents(agents as unknown[]) };
      }
    } catch {
      // Fall through
    }

    // Method 4: Try invoking kadi-list-tools to get tool list with providers
    try {
      const result = await invokeWithRetry<Record<string, unknown>>(
        ctx.abilities,
        'kadi-list-tools',
        { includeProviders: true },
      );
      if (result && typeof result === 'object') {
        const tools = (result as Record<string, unknown>).tools as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(tools)) {
          const agentMap = new Map<string, { name: string; version: string; tools: string[] }>();
          for (const tool of tools) {
            const providers = (tool.providers as Array<Record<string, unknown>>) ?? [];
            for (const provider of providers) {
              const name = (provider.displayName as string) ?? (provider.name as string) ?? 'unknown';
              if (!agentMap.has(name)) {
                agentMap.set(name, {
                  name,
                  version: (provider.version as string) ?? '',
                  tools: [],
                });
              }
              agentMap.get(name)!.tools.push((tool.name as string) ?? '');
            }
          }
          // Filter to agents with arcade-query or arcade-command
          const allAgents = [...agentMap.values()];
          const arcadeAgents = allAgents.filter(
            (a) => a.tools.includes('arcade-query') || a.tools.includes('arcade-command'),
          );
          return {
            success: true,
            agents: arcadeAgents.length > 0 ? arcadeAgents : allAgents,
          };
        }
      }
    } catch {
      // Fall through
    }

    // All methods failed — return gracefully
    return {
      success: true,
      agents: [],
      note: 'Agent discovery not available on this broker',
    };
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Helpers
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 for zero-norm vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) return 0;
  return dot / denom;
}

/**
 * Format raw agent data into a consistent shape.
 */
function formatAgents(agents: unknown[]): Array<{ name: string; version: string; tools: string[] }> {
  if (!Array.isArray(agents)) return [];
  return agents.map((a) => {
    if (typeof a === 'object' && a !== null) {
      const obj = a as Record<string, unknown>;
      return {
        name: (obj.name as string) ?? (obj.displayName as string) ?? 'unknown',
        version: (obj.version as string) ?? '',
        tools: Array.isArray(obj.tools)
          ? (obj.tools as unknown[]).map((t) => (typeof t === 'string' ? t : (t as Record<string, unknown>).name as string ?? ''))
          : [],
      };
    }
    return { name: String(a), version: '', tools: [] };
  });
}

/**
 * Graph helpers — upsert vertices, create edges, traverse, and find orphans.
 *
 * All operations go through invokeWithRetry for automatic retry with
 * exponential backoff. SQL patterns follow validated-sql patterns.
 *
 * Key difference from memory-ability/src/lib/graph.ts:
 * - All DB calls use invokeWithRetry instead of raw client.invokeRemote()
 * - Vertex types are parameterized (not hardcoded to Memory/Topic/Entity)
 * - Uses SignalAbilities interface instead of KadiClient directly
 */

import { invokeWithRetry } from './retry.js';
import { escapeSQL } from './sql.js';
import type {
  ArcadeCommandResult,
  ArcadeQueryResult,
  GraphEdge,
  GraphVertex,
  SignalAbilities,
} from './types.js';

// ---------------------------------------------------------------------------
// Vertex upserts
// ---------------------------------------------------------------------------

/**
 * Upsert a Topic vertex — update lastSeen and increment frequency if exists,
 * create new if not.
 *
 * @returns The RID of the upserted Topic vertex.
 */
export async function upsertTopic(
  abilities: SignalAbilities,
  database: string,
  name: string,
): Promise<string> {
  const now = new Date().toISOString();
  const safeName = escapeSQL(name);

  // Check if exists
  const selectResult = await invokeWithRetry<ArcadeQueryResult>(
    abilities,
    'arcade-query',
    { database, query: `SELECT @rid FROM Topic WHERE name = '${safeName}'` },
  );

  if (selectResult.success && selectResult.result && selectResult.result.length > 0) {
    const rid = extractRid(selectResult.result[0]);
    await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      {
        database,
        command: `UPDATE Topic SET lastSeen = '${now}', frequency = frequency + 1 WHERE name = '${safeName}'`,
      },
    );
    return rid;
  }

  // Create new
  const createSql =
    `CREATE VERTEX Topic SET name = '${safeName}',` +
    ` firstSeen = '${now}', lastSeen = '${now}', frequency = 1`;

  const createResult = await invokeWithRetry<ArcadeCommandResult>(
    abilities,
    'arcade-command',
    { database, command: createSql },
  );

  if (!createResult.success) {
    throw new Error(`Failed to create Topic "${name}": ${createResult.error}`);
  }

  return extractRid(createResult.result![0]);
}

/**
 * Upsert an Entity vertex — update lastSeen if exists, create new if not.
 *
 * @returns The RID of the upserted Entity vertex.
 */
export async function upsertEntity(
  abilities: SignalAbilities,
  database: string,
  name: string,
  type: string,
): Promise<string> {
  const now = new Date().toISOString();
  const safeName = escapeSQL(name);
  const safeType = escapeSQL(type);

  // Check if exists
  const selectResult = await invokeWithRetry<ArcadeQueryResult>(
    abilities,
    'arcade-query',
    {
      database,
      query: `SELECT @rid FROM Entity WHERE name = '${safeName}' AND type = '${safeType}'`,
    },
  );

  if (selectResult.success && selectResult.result && selectResult.result.length > 0) {
    const rid = extractRid(selectResult.result[0]);
    await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      {
        database,
        command: `UPDATE Entity SET lastSeen = '${now}' WHERE name = '${safeName}' AND type = '${safeType}'`,
      },
    );
    return rid;
  }

  // Create new
  const createSql =
    `CREATE VERTEX Entity SET name = '${safeName}', type = '${safeType}',` +
    ` firstSeen = '${now}', lastSeen = '${now}'`;

  const createResult = await invokeWithRetry<ArcadeCommandResult>(
    abilities,
    'arcade-command',
    { database, command: createSql },
  );

  if (!createResult.success) {
    throw new Error(`Failed to create Entity "${name}" (${type}): ${createResult.error}`);
  }

  return extractRid(createResult.result![0]);
}

// ---------------------------------------------------------------------------
// Generic vertex creation via CONTENT JSON
// ---------------------------------------------------------------------------

/**
 * Create a vertex using CONTENT JSON syntax. Avoids escaping issues
 * with complex values (see Appendix A in spec).
 *
 * @returns The RID of the created vertex.
 */
export async function createVertex(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const contentJson = JSON.stringify(properties);
  const command = `CREATE VERTEX ${escapeSQL(vertexType)} CONTENT ${contentJson}`;

  const result = await invokeWithRetry<ArcadeCommandResult>(
    abilities,
    'arcade-command',
    { database, command },
  );

  if (!result.success) {
    throw new Error(
      `Failed to create ${vertexType} vertex: ${result.error}`,
    );
  }

  return extractRid(result.result![0]);
}

/**
 * Update a vertex's properties using SET syntax.
 */
export async function updateVertex(
  abilities: SignalAbilities,
  database: string,
  rid: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const setParts: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) {
      setParts.push(`${key} = NULL`);
    } else if (typeof value === 'string') {
      setParts.push(`${key} = '${escapeSQL(value)}'`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      setParts.push(`${key} = ${value}`);
    } else if (Array.isArray(value)) {
      setParts.push(`${key} = ${JSON.stringify(value)}`);
    } else {
      setParts.push(`${key} = ${JSON.stringify(value)}`);
    }
  }

  if (setParts.length === 0) return;

  const command = `UPDATE ${rid} SET ${setParts.join(', ')}`;

  const result = await invokeWithRetry<ArcadeCommandResult>(
    abilities,
    'arcade-command',
    { database, command },
  );

  if (!result.success) {
    throw new Error(`Failed to update vertex ${rid}: ${result.error}`);
  }
}

/**
 * Delete a vertex by RID.
 */
export async function deleteVertex(
  abilities: SignalAbilities,
  database: string,
  rid: string,
): Promise<void> {
  const result = await invokeWithRetry<ArcadeCommandResult>(
    abilities,
    'arcade-command',
    { database, command: `DELETE FROM ${rid}` },
  );

  if (!result.success) {
    throw new Error(`Failed to delete vertex ${rid}: ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// Edge creation
// ---------------------------------------------------------------------------

/**
 * Create an edge between two vertices. Uses IF NOT EXISTS to avoid duplicates.
 */
export async function createEdge(
  abilities: SignalAbilities,
  database: string,
  edgeType: string,
  fromRid: string,
  toRid: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  let setClause = '';
  if (properties && Object.keys(properties).length > 0) {
    const parts = Object.entries(properties).map(([key, value]) => {
      if (typeof value === 'string') {
        return `${key} = '${escapeSQL(value)}'`;
      }
      return `${key} = ${value}`;
    });
    setClause = ` SET ${parts.join(', ')}`;
  }

  const command =
    `CREATE EDGE ${escapeSQL(edgeType)}` +
    ` FROM ${fromRid} TO ${toRid} IF NOT EXISTS${setClause}`;

  const result = await invokeWithRetry<ArcadeCommandResult>(
    abilities,
    'arcade-command',
    { database, command },
  );

  if (!result.success) {
    throw new Error(
      `Failed to create ${edgeType} edge from ${fromRid} to ${toRid}: ${result.error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

/**
 * Traverse the graph from a starting vertex, collecting connected vertices
 * and edges up to `depth` levels.
 *
 * @param abilities - The abilities interface.
 * @param database  - Target ArcadeDB database name.
 * @param startRid  - RID of the starting vertex.
 * @param depth     - Maximum traversal depth (1-4).
 * @param filters   - Optional filters (e.g., agent filter for Memory vertices).
 * @returns Arrays of vertices and edges in the traversed subgraph.
 */
export async function traverseGraph(
  abilities: SignalAbilities,
  database: string,
  startRid: string,
  depth: number,
  filters?: Record<string, unknown>,
): Promise<{ vertices: GraphVertex[]; edges: GraphEdge[] }> {
  const safeDepth = Math.max(1, Math.min(4, depth));

  const sql = `TRAVERSE both() FROM ${startRid} MAXDEPTH ${safeDepth}`;

  const response = await invokeWithRetry<ArcadeQueryResult>(
    abilities,
    'arcade-query',
    { database, query: sql },
  );

  if (!response.success || !response.result) {
    return { vertices: [], edges: [] };
  }

  const vertices: GraphVertex[] = [];
  const edges: GraphEdge[] = [];

  for (const row of response.result) {
    const rid = extractRid(row);
    const cat = row['@cat'] as string | undefined;
    const type = (row['@type'] as string) ?? 'unknown';

    // Apply filters if provided
    if (filters) {
      let filtered = false;
      for (const [key, value] of Object.entries(filters)) {
        if (row[key] !== undefined && row[key] !== value) {
          filtered = true;
          break;
        }
      }
      if (filtered) continue;
    }

    if (cat === 'e') {
      edges.push({
        rid,
        type,
        from: (row['@out'] as string) ?? '',
        to: (row['@in'] as string) ?? '',
        properties: filterSystemProps(row),
      });
    } else {
      vertices.push({
        rid,
        type,
        properties: filterSystemProps(row),
      });
    }
  }

  return { vertices, edges };
}

/**
 * Find orphaned Topics and Entities that have no remaining edges.
 *
 * @returns Array of RIDs of orphaned vertices.
 */
export async function findOrphans(
  abilities: SignalAbilities,
  database: string,
): Promise<string[]> {
  const orphanRids: string[] = [];

  for (const type of ['Topic', 'Entity']) {
    const sql = `SELECT @rid FROM ${type} WHERE both().size() = 0`;

    const response = await invokeWithRetry<ArcadeQueryResult>(
      abilities,
      'arcade-query',
      { database, query: sql },
    );

    if (response.success && response.result) {
      for (const row of response.result) {
        orphanRids.push(extractRid(row));
      }
    }
  }

  return orphanRids;
}

/**
 * Get topics connected to a vertex via HasTopic edges.
 */
export async function getVertexTopics(
  abilities: SignalAbilities,
  database: string,
  vertexRid: string,
  vertexType: string,
): Promise<string[]> {
  const sql =
    `MATCH {type: ${vertexType}, as: v, where: (@rid = ${vertexRid})}` +
    ` .out('HasTopic'){type: Topic, as: t}` +
    ` RETURN t.name`;

  const response = await invokeWithRetry<ArcadeQueryResult>(
    abilities,
    'arcade-query',
    { database, query: sql },
  );

  if (!response.success || !response.result) return [];

  return response.result
    .map((row) => (row['t.name'] as string) ?? '')
    .filter(Boolean);
}

/**
 * Get entities connected to a vertex via Mentions edges.
 */
export async function getVertexEntities(
  abilities: SignalAbilities,
  database: string,
  vertexRid: string,
  vertexType: string,
): Promise<Array<{ name: string; type: string }>> {
  const sql =
    `MATCH {type: ${vertexType}, as: v, where: (@rid = ${vertexRid})}` +
    ` .out('Mentions'){type: Entity, as: e}` +
    ` RETURN e.name, e.type`;

  const response = await invokeWithRetry<ArcadeQueryResult>(
    abilities,
    'arcade-query',
    { database, query: sql },
  );

  if (!response.success || !response.result) return [];

  return response.result.map((row) => ({
    name: (row['e.name'] as string) ?? '',
    type: (row['e.type'] as string) ?? '',
  }));
}

/**
 * Query vertices by a SQL WHERE clause.
 */
export async function queryVertices(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  where: string,
  limit: number = 100,
): Promise<Array<Record<string, unknown>>> {
  const sql = `SELECT * FROM ${vertexType} WHERE ${where} LIMIT ${limit}`;

  const response = await invokeWithRetry<ArcadeQueryResult>(
    abilities,
    'arcade-query',
    { database, query: sql },
  );

  if (!response.success || !response.result) return [];
  return response.result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the RID string from an ArcadeDB result row.
 */
export function extractRid(row: Record<string, unknown>): string {
  return (row['@rid'] as string) ?? '';
}

/**
 * Filter out ArcadeDB system properties from a row.
 */
export function filterSystemProps(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('@')) {
      result[key] = value;
    }
  }
  return result;
}

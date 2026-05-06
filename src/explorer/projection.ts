/**
 * PCA-based 2D projection of embedding vectors.
 *
 * Pure math implementation — no external library. Uses power iteration
 * to find the top 2 principal components, then projects all embeddings
 * onto those components to produce (x, y) scatter plot coordinates.
 *
 * The projection is cached per database:vertexType key and expires after
 * 1 hour.
 */

import { invokeWithRetry } from '../lib/retry.js';
import type { SignalAbilities, ArcadeQueryResult } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectionPoint {
  rid: string;
  x: number;
  y: number;
  type: string;
  label: string;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  dimensions: number;
  count: number;
  sampledFrom: number;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const projectionCache = new Map<string, ProjectionResult>();

function cacheKey(database: string, vertexType: string, filter?: string): string {
  return filter ? `${database}:${vertexType}:${filter}` : `${database}:${vertexType}`;
}

/**
 * Get a cached projection result if it exists and is less than 1 hour old.
 */
export function getCachedProjection(database: string, vertexType: string, filter?: string): ProjectionResult | null {
  const key = cacheKey(database, vertexType, filter);
  const cached = projectionCache.get(key);
  if (!cached) return null;

  const age = Date.now() - new Date(cached.computedAt).getTime();
  if (age > 3_600_000) {
    projectionCache.delete(key);
    return null;
  }
  return cached;
}

/**
 * Clear all projection caches.
 */
export function clearProjectionCache(): void {
  projectionCache.clear();
}

/**
 * Clear cache for a specific database:vertexType.
 */
export function clearProjectionCacheFor(database: string, vertexType: string, filter?: string): void {
  if (filter) {
    projectionCache.delete(cacheKey(database, vertexType, filter));
  } else {
    // Clear all caches for this db:type (including any filtered variants)
    for (const key of projectionCache.keys()) {
      if (key.startsWith(`${database}:${vertexType}`)) {
        projectionCache.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PCA via Power Iteration
// ---------------------------------------------------------------------------

/**
 * Compute the 2D PCA projection for embeddings of a given vertex type.
 */
export async function computeProjection(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  filter?: string,
): Promise<ProjectionResult> {
  // Build the WHERE clause — always require embedding IS NOT NULL, optionally add user filter
  const whereParts = ['embedding IS NOT NULL'];
  if (filter && filter.trim()) {
    whereParts.push(`(${filter.trim()})`);
  }
  const whereClause = whereParts.join(' AND ');

  // Step 1: First get total count of vertices with embeddings
  const countSql = `SELECT count(*) FROM ${vertexType} WHERE ${whereClause}`;
  let totalCount = 0;
  try {
    const countResult = await invokeWithRetry<ArcadeQueryResult>(
      abilities,
      'arcade-query',
      { database, query: countSql },
    );
    const countRows = countResult.result ?? [];
    if (countRows.length > 0) {
      totalCount = (countRows[0]['count(*)'] as number) ?? 0;
    }
  } catch {
    // Count failed — continue with fetch
  }

  // Step 2: Fetch embeddings in batches to avoid broker payload limits.
  // Each 1536-dim embedding is ~12KB in JSON. Fetching 200 at a time
  // keeps each request under ~3MB which is safe for the broker.
  const batchSize = 200;
  const maxPoints = 2000;
  const allRows: Array<Record<string, unknown>> = [];

  for (let skip = 0; allRows.length < maxPoints; skip += batchSize) {
    const sql = `SELECT @rid, @type, name, content.left(80) as content, embedding FROM ${vertexType} WHERE ${whereClause} LIMIT ${batchSize} SKIP ${skip}`;
    try {
      const queryResult = await invokeWithRetry<ArcadeQueryResult>(
        abilities,
        'arcade-query',
        { database, query: sql },
      );
      const rows = queryResult.result ?? [];
      if (rows.length === 0) break; // No more data
      allRows.push(...rows);
      // If fewer rows returned than batch size, we've fetched everything
      if (rows.length < batchSize) break;
    } catch (err: unknown) {
      console.warn(`[projection] Batch fetch at skip=${skip} failed:`, err instanceof Error ? err.message : err);
      break; // Use whatever we fetched so far
    }
  }

  const rows = allRows;
  if (rows.length === 0) {
    const result: ProjectionResult = {
      points: [],
      dimensions: 0,
      count: 0,
      sampledFrom: totalCount || 0,
      computedAt: new Date().toISOString(),
    };
    projectionCache.set(cacheKey(database, vertexType, filter), result);
    return result;
  }

  const sampledFrom = totalCount || rows.length;

  // Step 3: Random sample if we have more than 2000 usable embeddings
  let sampled = rows;
  if (rows.length > 2000) {
    sampled = [];
    const indices = new Set<number>();
    while (indices.size < 2000) {
      indices.add(Math.floor(Math.random() * rows.length));
    }
    for (const idx of indices) {
      sampled.push(rows[idx]);
    }
  }

  // Step 4: Extract embeddings and metadata
  const embeddings: number[][] = [];
  const meta: Array<{ rid: string; type: string; label: string }> = [];

  for (const row of sampled) {
    const emb = row.embedding as number[] | undefined;
    if (!emb || !Array.isArray(emb) || emb.length === 0) continue;

    embeddings.push(emb);
    const name = (row.name as string) ?? '';
    const content = (row.content as string) ?? '';
    const label = name || (content.length > 60 ? content.slice(0, 60) + '…' : content) || String(row['@rid'] ?? '');

    meta.push({
      rid: (row['@rid'] as string) ?? '',
      type: (row['@type'] as string) ?? vertexType,
      label,
    });
  }

  if (embeddings.length === 0) {
    const result: ProjectionResult = {
      points: [],
      dimensions: 0,
      count: 0,
      sampledFrom,
      computedAt: new Date().toISOString(),
    };
    projectionCache.set(cacheKey(database, vertexType, filter), result);
    return result;
  }

  const dims = embeddings[0].length;
  const n = embeddings.length;

  // Handle single vector case
  if (n === 1) {
    const result: ProjectionResult = {
      points: [{ rid: meta[0].rid, x: 0, y: 0, type: meta[0].type, label: meta[0].label }],
      dimensions: dims,
      count: 1,
      sampledFrom,
      computedAt: new Date().toISOString(),
    };
    projectionCache.set(cacheKey(database, vertexType, filter), result);
    return result;
  }

  // Step 4: Center data (subtract mean of each dimension)
  const mean = new Float64Array(dims);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dims; d++) {
      mean[d] += embeddings[i][d];
    }
  }
  for (let d = 0; d < dims; d++) {
    mean[d] /= n;
  }

  // Build centered matrix A (n × dims)
  const A: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(dims);
    for (let d = 0; d < dims; d++) {
      row[d] = embeddings[i][d] - mean[d];
    }
    A.push(row);
  }

  // Step 5: Power iteration for top 2 principal components
  // PC1
  const pc1 = powerIteration(A, n, dims, 50);
  const xCoords = projectOnto(A, n, dims, pc1);

  // Deflate: subtract rank-1 component from A
  deflate(A, n, dims, pc1, xCoords);

  // PC2
  const pc2 = powerIteration(A, n, dims, 50);
  const yCoords = projectOnto(A, n, dims, pc2);

  // Step 6: Normalize to [-1, 1]
  normalizeRange(xCoords);
  normalizeRange(yCoords);

  // Step 7: Build points
  const points: ProjectionPoint[] = [];
  for (let i = 0; i < n; i++) {
    points.push({
      rid: meta[i].rid,
      x: xCoords[i],
      y: yCoords[i],
      type: meta[i].type,
      label: meta[i].label,
    });
  }

  const result: ProjectionResult = {
    points,
    dimensions: dims,
    count: n,
    sampledFrom,
    computedAt: new Date().toISOString(),
  };

  projectionCache.set(cacheKey(database, vertexType, filter), result);
  return result;
}

// ---------------------------------------------------------------------------
// Linear Algebra Helpers
// ---------------------------------------------------------------------------

/**
 * Power iteration to find dominant eigenvector of A^T * A.
 *
 * Instead of forming the full covariance matrix (dims × dims),
 * we compute A*v (n-vector) then A^T*(A*v) (dims-vector) per iteration.
 */
function powerIteration(
  A: Float64Array[],
  n: number,
  dims: number,
  iterations: number,
): Float64Array {
  // Random unit vector
  const v = new Float64Array(dims);
  for (let d = 0; d < dims; d++) {
    v[d] = Math.random() - 0.5;
  }
  normalize(v);

  for (let iter = 0; iter < iterations; iter++) {
    // Step 1: w = A * v  (n-dimensional)
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let dot = 0;
      for (let d = 0; d < dims; d++) {
        dot += A[i][d] * v[d];
      }
      w[i] = dot;
    }

    // Step 2: v_new = A^T * w  (dims-dimensional)
    const vNew = new Float64Array(dims);
    for (let d = 0; d < dims; d++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += A[i][d] * w[i];
      }
      vNew[d] = sum;
    }

    // Normalize
    const norm = Math.sqrt(vNew.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-10) {
      // Zero variance — return current v
      return v;
    }
    for (let d = 0; d < dims; d++) {
      v[d] = vNew[d] / norm;
    }
  }

  return v;
}

/**
 * Project each row of A onto a direction vector, returning the scalar projections.
 */
function projectOnto(
  A: Float64Array[],
  n: number,
  dims: number,
  direction: Float64Array,
): Float64Array {
  const projections = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let dot = 0;
    for (let d = 0; d < dims; d++) {
      dot += A[i][d] * direction[d];
    }
    projections[i] = dot;
  }
  return projections;
}

/**
 * Deflate matrix A by subtracting the rank-1 component along a principal direction.
 * A_i = A_i - (projections[i]) * direction
 */
function deflate(
  A: Float64Array[],
  n: number,
  dims: number,
  direction: Float64Array,
  projections: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dims; d++) {
      A[i][d] -= projections[i] * direction[d];
    }
  }
}

/**
 * Normalize a vector to unit length.
 */
function normalize(v: Float64Array): void {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm > 1e-10) {
    for (let i = 0; i < v.length; i++) {
      v[i] /= norm;
    }
  }
}

/**
 * Normalize an array of values to [-1, 1] range.
 */
function normalizeRange(arr: Float64Array): void {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  const range = max - min;
  if (range < 1e-10) {
    // All values same — center at 0
    for (let i = 0; i < arr.length; i++) {
      arr[i] = 0;
    }
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    arr[i] = ((arr[i] - min) / range) * 2 - 1;
  }
}

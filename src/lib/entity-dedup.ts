/**
 * Entity deduplication via embedding cosine similarity.
 *
 * Before creating a new Entity vertex, embed the name and compare against
 * existing entities. If similarity exceeds threshold, merge into the existing
 * entity instead of creating a duplicate.
 */

import type { SignalAbilities } from './types.js';
import type { GraphConfig } from './config.js';
import { invokeWithRetry } from './retry.js';

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

// ── Types ─────────────────────────────────────────────────────────────

interface EntityCandidate {
  rid: string;
  name: string;
  type: string;
  nameEmbedding: number[];
}

export interface DeduplicationResult {
  found: boolean;
  rid?: string;
  existingName?: string;
  similarity?: number;
}

// ── Public API ────────────────────────────────────────────────────────

export async function findSimilarEntity(
  name: string,
  type: string,
  abilities: SignalAbilities,
  database: string,
  config: GraphConfig,
  threshold?: number,
): Promise<DeduplicationResult> {
  const effectiveThreshold = threshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // Embed the incoming entity name
  const nameEmbedding = await embedEntityName(name, config);
  if (!nameEmbedding || nameEmbedding.length === 0) {
    return { found: false };
  }

  // Query existing entities that have embeddings
  const result = await invokeWithRetry<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>(abilities, 'arcade-query', {
    database,
    query: `SELECT @rid, name, type, name_embedding FROM Entity WHERE name_embedding IS NOT NULL`,
  });

  if (!result.success || !result.result || result.result.length === 0) {
    return { found: false };
  }

  // Find best match by cosine similarity
  let bestMatch: { rid: string; name: string; type: string; similarity: number } | null = null;

  for (const row of result.result) {
    const existing = row as unknown as { '@rid': string; name: string; type: string; name_embedding: number[] };
    const rid = String(existing['@rid'] ?? (row as any).rid ?? '');
    const existingName = String(existing.name ?? '');
    const existingType = String(existing.type ?? '');
    const existingEmbedding = existing.name_embedding;

    if (!Array.isArray(existingEmbedding) || existingEmbedding.length === 0) continue;

    const similarity = cosineSimilarity(nameEmbedding, existingEmbedding);

    // Boost score if types match
    const typeBoost = existingType.toLowerCase() === type.toLowerCase() ? 0.05 : 0;
    const adjustedSimilarity = Math.min(1.0, similarity + typeBoost);

    if (adjustedSimilarity >= effectiveThreshold) {
      if (!bestMatch || adjustedSimilarity > bestMatch.similarity) {
        bestMatch = { rid, name: existingName, type: existingType, similarity: adjustedSimilarity };
      }
    }
  }

  if (bestMatch) {
    console.log(
      `[entity-dedup] Matched "${name}" (${type}) → "${bestMatch.name}" (${bestMatch.type}) ` +
      `similarity=${bestMatch.similarity.toFixed(3)} rid=${bestMatch.rid}`,
    );
    return {
      found: true,
      rid: bestMatch.rid,
      existingName: bestMatch.name,
      similarity: bestMatch.similarity,
    };
  }

  return { found: false };
}

// ── Embedding ─────────────────────────────────────────────────────────

async function embedEntityName(name: string, config: GraphConfig): Promise<number[] | null> {
  if (!config.apiUrl || !config.apiKey) return null;

  try {
    const url = `${config.apiUrl.replace(/\/$/, '')}/v1/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: name,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// ── Vector math ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

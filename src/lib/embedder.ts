/**
 * Embedding pipeline — batches text through model-manager via either:
 *   - **broker**: `invokeWithRetry('create-embedding', ...)` over KADI protocol
 *   - **api**: direct HTTP POST to an OpenAI-compatible `/v1/embeddings` endpoint
 *
 * The transport is selected via {@link EmbeddingConfig.transport}.
 *
 * All broker-mode calls go through {@link invokeWithRetry} for automatic
 * retry with exponential backoff.
 */

import { invokeWithRetry, withRetry } from './retry.js';
import type { SignalAbilities } from './types.js';
import type { Transport } from './config.js';

// ---------------------------------------------------------------------------
// OpenAI-compatible embedding API response types
// ---------------------------------------------------------------------------

interface EmbeddingEntry {
  embedding: number[];
  index: number;
}

interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
}

interface EmbeddingApiResponse {
  data: EmbeddingEntry[];
  model: string;
  usage: EmbeddingUsage;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of an embedding operation over one or more texts. */
export interface EmbedResult {
  vectors: number[][];
  dimensions: number;
}

/** Configuration for how to reach the embedding service. */
export interface EmbeddingConfig {
  transport: Transport;
  apiUrl?: string;
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Embed an array of texts using model-manager.
 *
 * Texts are batched in groups of {@link MAX_BATCH_SIZE}. Broker-mode calls
 * use {@link invokeWithRetry} for automatic retry with exponential backoff.
 *
 * @param abilities - The abilities interface (or KadiClient for API mode).
 * @param texts     - Array of texts to embed.
 * @param model     - Embedding model name.
 * @param embedding - Transport configuration.
 * @returns Vectors in input order, plus the dimensionality.
 */
export async function embedTexts(
  abilities: SignalAbilities,
  texts: string[],
  model: string = 'nomic-embed-text',
  embedding: EmbeddingConfig = { transport: 'broker' },
): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { vectors: [], dimensions: 0 };
  }

  const allVectors: number[][] = [];
  const totalBatches = Math.ceil(texts.length / MAX_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * MAX_BATCH_SIZE;
    const batch = texts.slice(start, start + MAX_BATCH_SIZE);

    const context: BatchContext = { batchIndex, totalBatches, globalOffset: start };

    const response = embedding.transport === 'api'
      ? await requestEmbeddingsHttp(batch, model, embedding, context)
      : await requestEmbeddingsBroker(abilities, batch, model, embedding.apiKey, context);

    // Sort by index to guarantee input-order alignment
    const sorted = [...response.data].sort((a, b) => a.index - b.index);

    for (const entry of sorted) {
      allVectors.push(entry.embedding);
    }
  }

  return {
    vectors: allVectors,
    dimensions: allVectors[0].length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BatchContext {
  batchIndex: number;
  totalBatches: number;
  globalOffset: number;
}

/**
 * Send a batch via invokeWithRetry (broker mode).
 */
async function requestEmbeddingsBroker(
  abilities: SignalAbilities,
  texts: string[],
  model: string,
  apiKey: string | undefined,
  context: BatchContext,
): Promise<EmbeddingApiResponse> {
  const batchLabel = `batch ${context.batchIndex + 1}/${context.totalBatches}`;

  try {
    const params: Record<string, unknown> = { model, input: texts };
    if (apiKey) params.api_key = apiKey;

    const response = await invokeWithRetry<EmbeddingApiResponse>(
      abilities,
      'create-embedding',
      params,
    );
    return validateResponse(response, texts.length, model, batchLabel);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Embedding request failed via broker (${batchLabel}, ` +
      `offset ${context.globalOffset}, ${texts.length} texts, model: ${model}): ${message}`,
    );
  }
}

/**
 * Send a batch via direct HTTP to an OpenAI-compatible endpoint.
 *
 * Uses {@link withRetry} for automatic retry with exponential backoff on
 * transient network/server errors (fetch failed, 429, 502, 503, etc.).
 */
async function requestEmbeddingsHttp(
  texts: string[],
  model: string,
  config: EmbeddingConfig,
  context: BatchContext,
): Promise<EmbeddingApiResponse> {
  const batchLabel = `batch ${context.batchIndex + 1}/${context.totalBatches}`;

  if (!config.apiUrl) {
    throw new Error(
      `Embedding transport is "api" but no api_url is configured. ` +
      `Set MEMORY_API_URL env var or add the key to the "models" vault.`,
    );
  }

  const baseUrl = config.apiUrl.replace(/\/+$/, '');
  const url = baseUrl.includes('/v1/embeddings')
    ? baseUrl
    : `${baseUrl}/v1/embeddings`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return withRetry(async () => {
    let httpResponse: Response;
    try {
      httpResponse = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Embedding HTTP request failed (${batchLabel}, ` +
        `offset ${context.globalOffset}, ${texts.length} texts, model: ${model}, ` +
        `url: ${url}): ${message}`,
      );
    }

    if (!httpResponse.ok) {
      let body: string;
      try {
        body = await httpResponse.text();
      } catch {
        body = '(could not read response body)';
      }
      throw new Error(
        `Embedding HTTP ${httpResponse.status} from ${url} (${batchLabel}, ` +
        `model: ${model}): ${body.slice(0, 500)}`,
      );
    }

    let response: EmbeddingApiResponse;
    try {
      response = (await httpResponse.json()) as EmbeddingApiResponse;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Embedding response is not valid JSON (${batchLabel}, ` +
        `model: ${model}, url: ${url}): ${message}`,
      );
    }

    return validateResponse(response, texts.length, model, batchLabel);
  }, 'create-embedding');
}

/**
 * Validate that an embedding response has the expected shape and count.
 */
function validateResponse(
  response: EmbeddingApiResponse,
  expectedCount: number,
  model: string,
  batchLabel: string,
): EmbeddingApiResponse {
  if (!response || !Array.isArray(response.data)) {
    throw new Error(
      `Malformed embedding response (${batchLabel}, model: ${model}): ` +
      `expected { data: [...] }, got ${summarizeValue(response)}`,
    );
  }

  if (response.data.length !== expectedCount) {
    throw new Error(
      `Embedding count mismatch (${batchLabel}, model: ${model}): ` +
      `sent ${expectedCount} texts, received ${response.data.length} embeddings`,
    );
  }

  for (const entry of response.data) {
    if (!Array.isArray(entry.embedding) || typeof entry.index !== 'number') {
      throw new Error(
        `Malformed embedding entry (${batchLabel}, model: ${model}): ` +
        `expected { embedding: number[], index: number }, ` +
        `got ${summarizeValue(entry)}`,
      );
    }
  }

  return response;
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  try {
    const json = JSON.stringify(value);
    if (json.length <= 200) return json;
    return json.slice(0, 200) + '...';
  } catch {
    return typeof value;
  }
}

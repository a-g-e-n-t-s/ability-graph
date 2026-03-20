/**
 * graph-batch-store tool — bulk ingest items with batched embedding + extraction.
 *
 * "Batch" means application-level parallel processing, NOT arcade-batch
 * transactions. Each vertex upsert is its own arcade-command via invokeWithRetry.
 *
 * Supports dedup strategies (skip, replace) and progress tracking.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { embedTexts, type EmbedResult } from '../lib/embedder.js';
import { extractMetadata } from '../lib/extractor.js';
import {
  createEdge,
  createVertex,
  extractRid,
  queryVertices,
  updateVertex,
  upsertEntity,
  upsertTopic,
} from '../lib/graph.js';
import { jobManager } from '../lib/job-manager.js';
import { schemaRegistry } from '../lib/schema-registry.js';
import { escapeSQL } from '../lib/sql.js';
import type { BatchItem, SignalAbilities } from '../lib/types.js';

export function registerBatchStoreTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-batch-store',
      description:
        'Bulk store multiple items with batched embedding and parallel extraction. ' +
        'Each vertex is created via individual DB writes (not transactional batch). ' +
        'Supports dedup strategies (skip, replace) and progress tracking.',
      input: z.object({
        items: z.array(z.object({
          content: z.string(),
          vertexType: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
          topics: z.array(z.string()).optional(),
          entities: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
          edges: z.array(z.object({
            type: z.string(),
            direction: z.enum(['out', 'in']),
            targetRid: z.string().optional(),
            targetQuery: z.object({
              vertexType: z.string(),
              where: z.record(z.string(), z.unknown()),
            }).optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
          })).optional(),
          skipExtraction: z.boolean().optional(),
          importance: z.number().optional(),
        })).describe('Items to store'),
        vertexType: z.string().optional().describe('Default vertex type for all items'),
        database: z.string().optional().describe('Target database'),
        background: z.boolean().optional().describe('Run as background job (default: false)'),
        concurrency: z.number().optional().describe('Parallel extraction (default: 5)'),
        batchSize: z.number().optional().describe('Embedding batch size (default: 100)'),
        onDuplicate: z.enum(['skip', 'replace', 'error']).optional()
          .describe('Dedup strategy (default: error)'),
        deduplicateBy: z.array(z.string()).optional()
          .describe('Properties for duplicate detection'),
      }),
    },
    async (input) => {
      const startTime = Date.now();
      const database = input.database ?? config.database;
      const concurrency = input.concurrency ?? 5;
      const batchSize = input.batchSize ?? 100;
      const onDuplicate = input.onDuplicate ?? 'error';
      const deduplicateBy = input.deduplicateBy ?? [];

      if (!input.items || input.items.length === 0) {
        return {
          stored: 0,
          skipped: 0,
          failed: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        };
      }

      // If background, create a job and process asynchronously
      if (input.background) {
        const job = jobManager.startJob(input.items.length);

        // Fire and forget — process in background
        processBatch(
          abilities, config, input.items, input.vertexType, database,
          concurrency, batchSize, onDuplicate, deduplicateBy, job.jobId,
        ).catch((err) => {
          jobManager.fail(job.jobId, err instanceof Error ? err.message : String(err));
        });

        return {
          jobId: job.jobId,
          status: 'running',
          total: input.items.length,
        };
      }

      // Foreground — process inline
      return processBatch(
        abilities, config, input.items, input.vertexType, database,
        concurrency, batchSize, onDuplicate, deduplicateBy,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Batch processing pipeline
// ---------------------------------------------------------------------------

interface BatchResult {
  stored: number;
  skipped: number;
  failed: number;
  errors: Array<{ index: number; error: string }>;
  durationMs: number;
}

async function processBatch(
  abilities: SignalAbilities,
  config: GraphConfig,
  items: BatchItem[],
  defaultVertexType: string | undefined,
  database: string,
  concurrency: number,
  batchSize: number,
  onDuplicate: string,
  deduplicateBy: string[],
  jobId?: string,
): Promise<BatchResult> {
  const startTime = Date.now();
  let stored = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ index: number; error: string }> = [];

  // Step 1: Batch embeddings
  const textsToEmbed: string[] = [];
  const embedIndexMap: Map<number, number> = new Map(); // item index → embed array index

  for (let i = 0; i < items.length; i++) {
    textsToEmbed.push(items[i].content);
    embedIndexMap.set(i, textsToEmbed.length - 1);
  }

  let embedResult: EmbedResult = { vectors: [], dimensions: 0 };

  if (textsToEmbed.length > 0) {
    try {
      console.error(`[graph-batch-store] Embedding ${textsToEmbed.length} items…`);
      const embedStart = Date.now();
      embedResult = await embedTexts(
        abilities,
        textsToEmbed,
        config.embeddingModel,
        {
          transport: config.embeddingTransport,
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
        },
      );
      console.error(`[graph-batch-store] Embedding complete (${embedResult.dimensions}d, ${Date.now() - embedStart}ms)`);
    } catch (err) {
      console.warn('[graph-batch-store] Embedding batch failed:', err);
      // Continue without embeddings
    }
  }

  // Ensure vector index if we have embeddings
  if (embedResult.dimensions > 0 && defaultVertexType) {
    try {
      await schemaRegistry.ensureVectorIndex(
        abilities, database, defaultVertexType, embedResult.dimensions,
      );
    } catch {
      // May already exist
    }
  }

  // Step 2: Extract metadata in parallel (limited concurrency)
  const extractionResults: Array<{
    topics: string[];
    entities: Array<{ name: string; type: string }>;
    importance: number;
  }> = new Array(items.length);

  const extractionQueue: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.skipExtraction && !item.topics?.length && !item.entities?.length) {
      extractionQueue.push(i);
    } else {
      extractionResults[i] = {
        topics: item.topics ?? [],
        entities: item.entities ?? [],
        importance: item.importance ?? 0.5,
      };
    }
  }

  // Process extraction in batches of concurrency
  console.error(`[graph-batch-store] Extracting metadata for ${extractionQueue.length}/${items.length} items (concurrency=${concurrency})…`);
  const extractStart = Date.now();
  let extractionCompleted = 0;
  for (let batch = 0; batch < extractionQueue.length; batch += concurrency) {
    const batchIndexes = extractionQueue.slice(batch, batch + concurrency);

    const results = await Promise.all(
      batchIndexes.map(async (i) => {
        try {
          return await extractMetadata(
            abilities,
            items[i].content,
            config.extractionModel,
            {
              transport: config.chatTransport,
              apiUrl: config.apiUrl,
              apiKey: config.apiKey,
            },
          );
        } catch {
          return { topics: [], entities: [], importance: 0.5 };
        }
      }),
    );

    for (let j = 0; j < batchIndexes.length; j++) {
      extractionResults[batchIndexes[j]] = results[j];
    }
    extractionCompleted += batchIndexes.length;
    if (extractionCompleted % 25 === 0 || extractionCompleted === extractionQueue.length) {
      console.error(`[graph-batch-store] Extraction progress: ${extractionCompleted}/${extractionQueue.length}`);
    }
  }
  console.error(`[graph-batch-store] Extraction complete (${Date.now() - extractStart}ms)`);

  // Step 3: Store each item individually via arcade-command
  console.error(`[graph-batch-store] Storing ${items.length} vertices…`);
  const storeStart = Date.now();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const vertexType = item.vertexType ?? defaultVertexType;

    if (!vertexType) {
      errors.push({ index: i, error: 'No vertexType specified' });
      failed++;
      continue;
    }

    try {
      // Check for duplicates if configured
      if (deduplicateBy.length > 0) {
        const isDuplicate = await checkDuplicate(
          abilities, database, vertexType, item, deduplicateBy,
        );

        if (isDuplicate.found) {
          if (onDuplicate === 'skip') {
            skipped++;
            if (jobId) jobManager.updateProgress(jobId, stored + skipped + failed);
            continue;
          } else if (onDuplicate === 'replace') {
            // Update existing vertex
            const props: Record<string, unknown> = {
              content: item.content,
              importance: extractionResults[i]?.importance ?? item.importance ?? 0.5,
              ...(item.properties ?? {}),
            };

            const embedIndex = embedIndexMap.get(i);
            if (embedIndex !== undefined && embedResult.vectors[embedIndex]) {
              props.embedding = embedResult.vectors[embedIndex];
            }

            await updateVertex(abilities, database, isDuplicate.rid!, props);
            stored++;
            if (jobId) jobManager.updateProgress(jobId, stored + skipped + failed);
            continue;
          }
          // 'error' — fall through and try to create (will fail on unique constraint)
        }
      }

      // Build vertex properties
      const vertexProps: Record<string, unknown> = {
        content: item.content,
        importance: extractionResults[i]?.importance ?? item.importance ?? 0.5,
        ...(item.properties ?? {}),
      };

      const embedIndex = embedIndexMap.get(i);
      if (embedIndex !== undefined && embedResult.vectors[embedIndex]) {
        vertexProps.embedding = embedResult.vectors[embedIndex];
      }

      // Create vertex
      const vertexRid = await createVertex(
        abilities, database, vertexType, vertexProps,
      );

      // Create topic/entity edges
      const extraction = extractionResults[i];
      if (extraction) {
        for (const topicName of extraction.topics) {
          try {
            const topicRid = await upsertTopic(abilities, database, topicName);
            await createEdge(abilities, database, 'HasTopic', vertexRid, topicRid, { weight: 1.0 });
          } catch {
            // Continue on topic edge failure
          }
        }

        for (const entity of extraction.entities) {
          try {
            const entityRid = await upsertEntity(abilities, database, entity.name, entity.type);
            await createEdge(abilities, database, 'Mentions', vertexRid, entityRid);
          } catch {
            // Continue on entity edge failure
          }
        }
      }

      // Create explicit edges
      if (item.edges) {
        for (const edge of item.edges) {
          try {
            let targetRid = edge.targetRid;

            if (!targetRid && edge.targetQuery) {
              const whereConditions = Object.entries(edge.targetQuery.where)
                .map(([k, v]) => {
                  if (typeof v === 'string') return `${k} = '${escapeSQL(v)}'`;
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
          } catch {
            // Continue on edge failure
          }
        }
      }

      stored++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ index: i, error: message });
      failed++;
    }

    // Progress logging every 25 items or on the last item
    const processed = stored + skipped + failed;
    if (processed % 25 === 0 || i === items.length - 1) {
      console.error(`[graph-batch-store] Progress: ${processed}/${items.length} (stored=${stored}, skipped=${skipped}, failed=${failed})`);
    }

    if (jobId) jobManager.updateProgress(jobId, stored + skipped + failed);
  }

  console.error(`[graph-batch-store] Storage complete (${Date.now() - storeStart}ms)`);

  const result: BatchResult = {
    stored,
    skipped,
    failed,
    errors,
    durationMs: Date.now() - startTime,
  };

  if (jobId) {
    if (failed > 0 && stored === 0) {
      jobManager.fail(jobId, `All ${failed} items failed`);
    } else {
      jobManager.complete(jobId, result as unknown as Record<string, unknown>);
    }
  }

  console.error(`[graph-batch-store] Done: stored=${stored}, skipped=${skipped}, failed=${failed}, total=${Date.now() - startTime}ms`);
  return result;
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

async function checkDuplicate(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  item: BatchItem,
  deduplicateBy: string[],
): Promise<{ found: boolean; rid?: string }> {
  const conditions: string[] = [];

  for (const prop of deduplicateBy) {
    const value = item.properties?.[prop];
    if (value === undefined || value === null) continue;

    if (typeof value === 'string') {
      conditions.push(`${prop} = '${escapeSQL(value)}'`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      conditions.push(`${prop} = ${value}`);
    }
  }

  if (conditions.length === 0) return { found: false };

  const whereClause = conditions.join(' AND ');
  const results = await queryVertices(abilities, database, vertexType, whereClause, 1);

  if (results.length > 0) {
    return { found: true, rid: extractRid(results[0]) };
  }

  return { found: false };
}

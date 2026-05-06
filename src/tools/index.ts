/**
 * graph-index tool — chunk content and store each chunk as a vertex with embedding.
 * graph-index-file tool — read a file and delegate to graph-index.
 *
 * Pipeline: content → chunkContent(strategy) → for each chunk: graph-store with embedding
 */

import { KadiClient, z } from '@kadi.build/core';
import { readFileSync, existsSync } from 'fs';

import type { GraphConfig } from '../lib/config.js';
import { chunkContent, type ChunkStrategy } from '../lib/chunker.js';
import type { SignalAbilities } from '../lib/types.js';
import { createVertex } from '../lib/graph.js';
import { invokeWithRetry } from '../lib/retry.js';

export function registerIndexTools(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  // ── graph-index ───────────────────────────────────────────────────────

  client.registerTool(
    {
      name: 'graph-index',
      description:
        'Index content by chunking, embedding, and storing each chunk as a vertex. ' +
        'Supports 5 strategies: markdown-headers, code-blocks, paragraph, sliding-window, auto.',
      input: z.object({
        content: z.string().describe('Text content to index'),
        vertexType: z.string().optional().describe('Vertex type for chunks (default: Document)'),
        strategy: z.enum(['markdown-headers', 'code-blocks', 'paragraph', 'sliding-window', 'auto']).optional()
          .describe('Chunking strategy (default: auto)'),
        maxTokens: z.number().optional().describe('Max tokens per chunk (default: 500)'),
        overlap: z.number().optional().describe('Overlap tokens for sliding-window (default: 50)'),
        database: z.string().optional().describe('Target database'),
        source: z.string().optional().describe('Source identifier (file path, URL, etc.)'),
        collection: z.string().optional().describe('Collection/namespace for grouping indexed content'),
        properties: z.record(z.string(), z.unknown()).optional()
          .describe('Additional properties to set on each chunk vertex'),
        topics: z.array(z.string()).optional().describe('Topics to link to each chunk'),
      }),
    },
    async (input) => {
      const startTime = Date.now();
      try {
        const database = input.database ?? config.database;
        const vertexType = input.vertexType ?? 'Document';
        const strategy = (input.strategy ?? 'auto') as ChunkStrategy;

        const chunks = chunkContent(input.content, strategy, {
          maxTokens: input.maxTokens,
          overlap: input.overlap,
        });

        if (chunks.length === 0) {
          return { success: true, indexed: 0, durationMs: Date.now() - startTime };
        }

        const results: Array<{ rid: string; chunkIndex: number; tokens: number }> = [];

        for (const chunk of chunks) {
          // Embed the chunk
          let embedding: number[] | undefined;
          if (config.apiUrl && config.apiKey) {
            try {
              const url = `${config.apiUrl.replace(/\/$/, '')}/v1/embeddings`;
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({ model: config.embeddingModel, input: chunk.content }),
              });
              if (response.ok) {
                const data = await response.json() as { data: Array<{ embedding: number[] }> };
                embedding = data.data?.[0]?.embedding;
              }
            } catch { /* skip embedding on failure */ }
          }

          const properties: Record<string, unknown> = {
            ...(input.properties ?? {}),
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            tokens: chunk.tokens,
            strategy: chunk.metadata.strategy,
            ...(input.source ? { source: input.source } : {}),
            ...(input.collection ? { collection: input.collection } : {}),
            ...(embedding ? { embedding } : {}),
            timestamp: new Date().toISOString(),
          };

          // Add strategy-specific metadata
          if ('breadcrumb' in chunk.metadata) {
            properties.breadcrumb = chunk.metadata.breadcrumb;
          }
          if ('language' in chunk.metadata && chunk.metadata.type === 'code') {
            properties.language = chunk.metadata.language;
            properties.context = chunk.metadata.context;
          }

          const rid = await createVertex(abilities, database, vertexType, {
            content: chunk.content,
            ...properties,
          });

          // Link topics if provided
          if (input.topics && input.topics.length > 0) {
            for (const topic of input.topics) {
              try {
                await invokeWithRetry(abilities, 'arcade-command', {
                  database,
                  command: `CREATE VERTEX Topic SET name = '${topic}' UPSERT WHERE name = '${topic}'`,
                });
              } catch { /* topic may already exist */ }
            }
          }

          results.push({ rid, chunkIndex: chunk.chunkIndex, tokens: chunk.tokens });
        }

        return {
          success: true,
          indexed: results.length,
          strategy,
          source: input.source,
          collection: input.collection,
          chunks: results,
          durationMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-index] ${message}`,
          durationMs: Date.now() - startTime,
        };
      }
    },
  );

  // ── graph-index-file ──────────────────────────────────────────────────

  client.registerTool(
    {
      name: 'graph-index-file',
      description:
        'Read a file from disk and index its content via graph-index. ' +
        'Automatically sets source to the file path.',
      input: z.object({
        path: z.string().describe('Absolute or relative file path to index'),
        vertexType: z.string().optional().describe('Vertex type for chunks (default: Document)'),
        strategy: z.enum(['markdown-headers', 'code-blocks', 'paragraph', 'sliding-window', 'auto']).optional()
          .describe('Chunking strategy (default: auto)'),
        maxTokens: z.number().optional().describe('Max tokens per chunk (default: 500)'),
        overlap: z.number().optional().describe('Overlap tokens for sliding-window (default: 50)'),
        database: z.string().optional().describe('Target database'),
        collection: z.string().optional().describe('Collection/namespace'),
        properties: z.record(z.string(), z.unknown()).optional()
          .describe('Additional properties for each chunk'),
        topics: z.array(z.string()).optional().describe('Topics to link'),
      }),
    },
    async (input) => {
      try {
        if (!existsSync(input.path)) {
          return { success: false, error: `File not found: ${input.path}` };
        }

        const content = readFileSync(input.path, 'utf-8');
        if (!content.trim()) {
          return { success: false, error: `File is empty: ${input.path}` };
        }

        // Run the same indexing logic inline
        const database = input.database ?? config.database;
        const vertexType = input.vertexType ?? 'Document';
        const strategy = (input.strategy ?? 'auto') as ChunkStrategy;
        const startTime = Date.now();

        const chunks = chunkContent(content, strategy, {
          maxTokens: input.maxTokens,
          overlap: input.overlap,
        });

        if (chunks.length === 0) {
          return { success: true, indexed: 0, source: input.path, durationMs: Date.now() - startTime };
        }

        const results: Array<{ rid: string; chunkIndex: number; tokens: number }> = [];

        for (const chunk of chunks) {
          let embedding: number[] | undefined;
          if (config.apiUrl && config.apiKey) {
            try {
              const url = `${config.apiUrl.replace(/\/$/, '')}/v1/embeddings`;
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({ model: config.embeddingModel, input: chunk.content }),
              });
              if (response.ok) {
                const data = await response.json() as { data: Array<{ embedding: number[] }> };
                embedding = data.data?.[0]?.embedding;
              }
            } catch { /* skip */ }
          }

          const properties: Record<string, unknown> = {
            ...(input.properties ?? {}),
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            tokens: chunk.tokens,
            strategy: chunk.metadata.strategy,
            source: input.path,
            ...(input.collection ? { collection: input.collection } : {}),
            ...(embedding ? { embedding } : {}),
            timestamp: new Date().toISOString(),
          };

          if ('breadcrumb' in chunk.metadata) {
            properties.breadcrumb = chunk.metadata.breadcrumb;
          }
          if ('language' in chunk.metadata && chunk.metadata.type === 'code') {
            properties.language = chunk.metadata.language;
            properties.context = chunk.metadata.context;
          }

          const rid = await createVertex(abilities, database, vertexType, {
            content: chunk.content,
            ...properties,
          });

          results.push({ rid, chunkIndex: chunk.chunkIndex, tokens: chunk.tokens });
        }

        return {
          success: true,
          indexed: results.length,
          strategy,
          source: input.path,
          collection: input.collection,
          chunks: results,
          durationMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `[graph-index-file] ${message}` };
      }
    },
  );
}

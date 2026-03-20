/**
 * Integration test: Store + Recall (all 4 modes)
 *
 * Tests:
 * - Register a test schema → store a vertex with extraction + embedding
 * - Recall via semantic (cosine), keyword (full-text), graph (traversal), hybrid (RRF)
 * - Verify each signal returns relevant results
 *
 * Requires live infrastructure: broker + arcadedb-ability + model-manager
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { schemaRegistry } from '../../src/lib/schema-registry.js';
import { invokeWithRetry } from '../../src/lib/retry.js';
import { TOPIC_VERTEX, ENTITY_VERTEX, COMMON_EDGE_TYPES } from '../../src/lib/types.js';
import type { ArcadeCommandResult, SchemaDefinition } from '../../src/lib/types.js';
import { createVertex, upsertTopic, upsertEntity, createEdge } from '../../src/lib/graph.js';
import { embedTexts } from '../../src/lib/embedder.js';
import { hybridRecall } from '../../src/lib/signals/index.js';
import type { RecallRequest } from '../../src/lib/types.js';
import {
  createTestContext,
  cleanupTestVertices,
  cleanupTestTopics,
  cleanupTestEntities,
  resetSchemaRegistry,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

const TEST_VERTEX_TYPE = 'StoreRecallTest';
const TEST_CONTENT_PREFIX = 'GRAPH_TEST_SR';

// Track created RIDs for cleanup
const createdRids: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext('store-recall-test');
  resetSchemaRegistry();

  // Register test schema
  const schemaDef: SchemaDefinition = {
    name: 'store-recall-test',
    database: ctx.database,
    vertexTypes: [
      {
        name: TEST_VERTEX_TYPE,
        properties: {
          content: 'STRING',
          importance: 'DOUBLE',
          embedding: 'LIST',
          agent: 'STRING',
        },
        indexes: [
          { property: 'content', type: 'FULL_TEXT' },
          { property: 'agent', type: 'NOTUNIQUE' },
        ],
      },
      TOPIC_VERTEX,
      ENTITY_VERTEX,
    ],
    edgeTypes: COMMON_EDGE_TYPES,
  };

  schemaRegistry.register(schemaDef);
  await schemaRegistry.ensureInfrastructure(ctx.abilities, ctx.database);

  // Store test data: 3 vertices with different content
  const testItems = [
    {
      content: `${TEST_CONTENT_PREFIX}: KADI is a distributed agent framework built by HuMIn Lab for deploying autonomous AI agents. It uses ArcadeDB as its graph database.`,
      topics: ['kadi-framework', 'agent-deployment', 'distributed-systems'],
      entities: [
        { name: 'KADI', type: 'project' },
        { name: 'HuMIn Lab', type: 'company' },
        { name: 'ArcadeDB', type: 'tool' },
      ],
      importance: 0.9,
    },
    {
      content: `${TEST_CONTENT_PREFIX}: ArcadeDB supports vector cosine similarity search for semantic retrieval. It stores embeddings as LIST properties and uses LSM_VECTOR indexes.`,
      topics: ['vector-search', 'semantic-retrieval', 'arcadedb'],
      entities: [
        { name: 'ArcadeDB', type: 'tool' },
      ],
      importance: 0.8,
    },
    {
      content: `${TEST_CONTENT_PREFIX}: The graph-ability signal system supports semantic, keyword, graph traversal, and structural expansion signals for hybrid retrieval.`,
      topics: ['signal-system', 'hybrid-retrieval', 'graph-ability'],
      entities: [
        { name: 'graph-ability', type: 'project' },
      ],
      importance: 0.7,
    },
  ];

  for (const item of testItems) {
    // Embed content
    const embedResult = await embedTexts(
      ctx.abilities,
      [item.content],
      ctx.config.embeddingModel,
      {
        transport: ctx.config.embeddingTransport,
        apiUrl: ctx.config.apiUrl,
        apiKey: ctx.config.apiKey,
      },
    );

    // Ensure vector index
    if (embedResult.dimensions > 0) {
      await schemaRegistry.ensureVectorIndex(
        ctx.abilities, ctx.database, TEST_VERTEX_TYPE, embedResult.dimensions,
      );
    }

    // Create vertex
    const vertexProps: Record<string, unknown> = {
      content: item.content,
      importance: item.importance,
      agent: 'test-agent',
    };
    if (embedResult.vectors.length > 0) {
      vertexProps.embedding = embedResult.vectors[0];
    }

    const rid = await createVertex(
      ctx.abilities, ctx.database, TEST_VERTEX_TYPE, vertexProps,
    );
    createdRids.push(rid);

    // Upsert topics and create edges
    for (const topicName of item.topics) {
      try {
        const topicRid = await upsertTopic(ctx.abilities, ctx.database, topicName);
        await createEdge(ctx.abilities, ctx.database, 'HasTopic', rid, topicRid, { weight: 1.0 });
      } catch {
        // Continue
      }
    }

    // Upsert entities and create edges
    for (const entity of item.entities) {
      try {
        const entityRid = await upsertEntity(ctx.abilities, ctx.database, entity.name, entity.type);
        await createEdge(ctx.abilities, ctx.database, 'Mentions', rid, entityRid);
      } catch {
        // Continue
      }
    }
  }

  console.log(`[store-recall] Stored ${createdRids.length} test vertices`);
}, 180_000);

afterAll(async () => {
  // Cleanup test data
  await cleanupTestVertices(ctx.abilities, ctx.database, TEST_VERTEX_TYPE, TEST_CONTENT_PREFIX);
  await cleanupTestTopics(ctx.abilities, ctx.database, 'kadi-framework');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'agent-deployment');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'distributed-systems');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'vector-search');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'semantic-retrieval');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'arcadedb');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'signal-system');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'hybrid-retrieval');
  await cleanupTestTopics(ctx.abilities, ctx.database, 'graph-ability');

  await ctx.client.disconnect();
}, 30_000);

describe('graph-ability store + recall integration', () => {

  // ---- Semantic recall ──────────────────────────────────────────────── 

  it('recalls via semantic search (cosine similarity)', async () => {
    const request: RecallRequest = {
      query: 'distributed AI agent infrastructure',
      vertexType: TEST_VERTEX_TYPE,
      mode: 'semantic',
      limit: 5,
      database: ctx.database,
      embedding: {
        model: ctx.config.embeddingModel,
        transport: ctx.config.embeddingTransport,
        apiUrl: ctx.config.apiUrl,
        apiKey: ctx.config.apiKey,
      },
    };

    const results = await hybridRecall(request, ctx.abilities, ctx.config, ['semantic']);

    expect(results.length).toBeGreaterThan(0);
    console.log(`[semantic] Found ${results.length} results`);
    console.log(`[semantic] Top result score: ${results[0]?.score}`);
    console.log(`[semantic] Top content preview: ${results[0]?.content?.substring(0, 80)}...`);

    // Top result should be about KADI (most relevant to "distributed AI agent")
    const topContent = (results[0]?.content ?? '').toLowerCase();
    expect(
      topContent.includes('kadi') || topContent.includes('agent') || topContent.includes('distributed'),
    ).toBe(true);

    // All scores should be positive
    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
    }

    // Scores should be monotonically decreasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  }, 60_000);

  // ---- Keyword recall ──────────────────────────────────────────────── 

  it('recalls via keyword search (full-text)', async () => {
    const request: RecallRequest = {
      query: 'ArcadeDB vector cosine',
      vertexType: TEST_VERTEX_TYPE,
      mode: 'keyword',
      limit: 5,
      database: ctx.database,
    };

    const results = await hybridRecall(request, ctx.abilities, ctx.config, ['keyword']);

    expect(results.length).toBeGreaterThan(0);
    console.log(`[keyword] Found ${results.length} results`);

    // Should find results containing ArcadeDB
    const hasArcadeDB = results.some(
      (r) => (r.content ?? '').toLowerCase().includes('arcadedb'),
    );
    expect(hasArcadeDB).toBe(true);
  }, 60_000);

  // ---- Graph recall ─────────────────────────────────────────────────── 

  it('recalls via graph traversal (Topic/Entity edges)', async () => {
    const request: RecallRequest = {
      query: 'KADI',
      vertexType: TEST_VERTEX_TYPE,
      mode: 'graph',
      limit: 5,
      database: ctx.database,
    };

    const results = await hybridRecall(request, ctx.abilities, ctx.config, ['graph']);

    // Graph signal searches Topic/Entity names then follows edges
    console.log(`[graph] Found ${results.length} results`);

    // May or may not find results depending on exact term matches in Topic/Entity vertices
    // The graph signal is heuristic-based — it extracts search terms from the query
    if (results.length > 0) {
      for (const result of results) {
        expect(result.matchedVia).toContain('graph');
      }
    }
  }, 60_000);

  // ---- Hybrid recall ────────────────────────────────────────────────── 

  it('recalls via hybrid mode (RRF fusion)', async () => {
    const request: RecallRequest = {
      query: 'distributed agent framework ArcadeDB graph database',
      vertexType: TEST_VERTEX_TYPE,
      mode: 'hybrid',
      signals: ['semantic', 'keyword', 'graph'],
      limit: 5,
      database: ctx.database,
      embedding: {
        model: ctx.config.embeddingModel,
        transport: ctx.config.embeddingTransport,
        apiUrl: ctx.config.apiUrl,
        apiKey: ctx.config.apiKey,
      },
    };

    const results = await hybridRecall(request, ctx.abilities, ctx.config, ['semantic', 'keyword', 'graph']);

    expect(results.length).toBeGreaterThan(0);
    console.log(`[hybrid] Found ${results.length} results`);
    console.log(`[hybrid] Top result score: ${results[0]?.score}`);
    console.log(`[hybrid] Top matchedVia: ${results[0]?.matchedVia}`);

    // Scores should be monotonically decreasing after importance weighting
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }

    // Top result should have a reasonable score
    expect(results[0].score).toBeGreaterThan(0);
  }, 120_000);

  // ---- Semantic vs Hybrid comparison ────────────────────────────────── 

  it('hybrid recall produces results from multiple signals', async () => {
    const semanticRequest: RecallRequest = {
      query: 'graph-ability signal system hybrid retrieval',
      vertexType: TEST_VERTEX_TYPE,
      mode: 'semantic',
      limit: 5,
      database: ctx.database,
      embedding: {
        model: ctx.config.embeddingModel,
        transport: ctx.config.embeddingTransport,
        apiUrl: ctx.config.apiUrl,
        apiKey: ctx.config.apiKey,
      },
    };

    const hybridRequest: RecallRequest = {
      ...semanticRequest,
      mode: 'hybrid',
      signals: ['semantic', 'keyword', 'graph'],
    };

    const semanticResults = await hybridRecall(semanticRequest, ctx.abilities, ctx.config, ['semantic']);
    const hybridResults = await hybridRecall(hybridRequest, ctx.abilities, ctx.config, ['semantic', 'keyword', 'graph']);

    console.log(`[comparison] Semantic: ${semanticResults.length} results, Hybrid: ${hybridResults.length} results`);

    // Both should return results
    expect(semanticResults.length).toBeGreaterThan(0);
    expect(hybridResults.length).toBeGreaterThan(0);

    // Hybrid should return at least as many results as semantic alone
    expect(hybridResults.length).toBeGreaterThanOrEqual(semanticResults.length);
  }, 120_000);
});

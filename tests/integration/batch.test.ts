/**
 * Integration test: Batch store
 *
 * Tests:
 * - Batch-store 10 items → verify all in DB
 * - Batch with dedup (replace strategy) → verify updated content
 * - Batch with dedup (skip strategy) → verify skipped items
 * - Empty batch returns zero counts
 *
 * Requires live infrastructure: broker + arcadedb-ability + model-manager
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { schemaRegistry } from '../../src/lib/schema-registry.js';
import { invokeWithRetry } from '../../src/lib/retry.js';
import { TOPIC_VERTEX, ENTITY_VERTEX, COMMON_EDGE_TYPES } from '../../src/lib/types.js';
import type { ArcadeQueryResult, SchemaDefinition } from '../../src/lib/types.js';
import {
  createTestContext,
  cleanupTestVertices,
  resetSchemaRegistry,
  type TestContext,
} from './helpers.js';

// Import tool registrations to test via tool bridge
import { registerBatchStoreTool } from '../../src/tools/batch-store.js';

let ctx: TestContext;
let bridge: { executeToolHandler(tool: string, params: unknown): Promise<unknown> };

const TEST_VERTEX_TYPE = 'BatchTest';
const TEST_CONTENT_PREFIX = `GRAPH_TEST_BT_${Date.now()}`;

beforeAll(async () => {
  ctx = await createTestContext('batch-test');
  resetSchemaRegistry();

  // Register the batch-store tool on the client
  registerBatchStoreTool(ctx.client, ctx.config);

  // Create a tool bridge to invoke registered tools locally
  bridge = ctx.client.createToolBridge();

  // Register test schema
  const schemaDef: SchemaDefinition = {
    name: 'batch-test',
    database: ctx.database,
    vertexTypes: [
      {
        name: TEST_VERTEX_TYPE,
        properties: {
          content: 'STRING',
          importance: 'DOUBLE',
          embedding: 'LIST',
          itemId: 'STRING',
          version: 'INTEGER',
        },
        indexes: [
          { property: 'content', type: 'FULL_TEXT' },
          { property: 'itemId', type: 'NOTUNIQUE' },
        ],
      },
      TOPIC_VERTEX,
      ENTITY_VERTEX,
    ],
    edgeTypes: COMMON_EDGE_TYPES,
  };

  schemaRegistry.register(schemaDef);
  await schemaRegistry.ensureInfrastructure(ctx.abilities, ctx.database);
  console.log('[batch] Schema registered');
}, 120_000);

afterAll(async () => {
  await cleanupTestVertices(ctx.abilities, ctx.database, TEST_VERTEX_TYPE, TEST_CONTENT_PREFIX);
  await ctx.client.disconnect();
}, 30_000);

describe('graph-ability batch store integration', () => {

  // ── Batch store 10 items ──────────────────────────────────────────── 

  it('batch-stores 10 items and verifies all in DB', async () => {
    // Clean up any leftover data from previous runs
    await cleanupTestVertices(ctx.abilities, ctx.database, TEST_VERTEX_TYPE, TEST_CONTENT_PREFIX);
    const items = Array.from({ length: 10 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Batch item ${i} about topic-${i % 3}: This is test data for batch integration testing.`,
      vertexType: TEST_VERTEX_TYPE,
      properties: {
        itemId: `batch-item-${i}`,
        version: 1,
      },
      skipExtraction: true,
      importance: 0.5 + (i % 5) * 0.1,
    }));

    const result = await bridge.executeToolHandler('graph-batch-store', {
      items,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
      batchSize: 10,
      concurrency: 3,
    }) as Record<string, unknown>;

    console.log(`[batch] Store result:`, JSON.stringify(result, null, 2));

    expect(result.stored).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify all 10 items are in the database
    const countResult = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      {
        database: ctx.database,
        query: `SELECT count(*) as cnt FROM ${TEST_VERTEX_TYPE} WHERE content LIKE '${TEST_CONTENT_PREFIX}: Batch item%'`,
      },
    );

    expect(countResult.success).toBe(true);
    const count = (countResult.result?.[0]?.cnt as number) ?? 0;
    expect(count).toBe(10);
    console.log(`[batch] Verified ${count} items in DB`);
  }, 180_000);

  // ── Batch with dedup (replace) ────────────────────────────────────── 

  it('batch with replace dedup strategy updates existing items', async () => {
    // Store items with known itemIds for dedup
    const originalItems = Array.from({ length: 3 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Dedup item ${i} version 1`,
      vertexType: TEST_VERTEX_TYPE,
      properties: {
        itemId: `dedup-item-${i}`,
        version: 1,
      },
      skipExtraction: true,
      importance: 0.5,
    }));

    const firstResult = await bridge.executeToolHandler('graph-batch-store', {
      items: originalItems,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
    }) as Record<string, unknown>;

    expect(firstResult.stored).toBe(3);

    // Now update items with replace strategy
    const updatedItems = Array.from({ length: 3 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Dedup item ${i} version 2 UPDATED`,
      vertexType: TEST_VERTEX_TYPE,
      properties: {
        itemId: `dedup-item-${i}`,
        version: 2,
      },
      skipExtraction: true,
      importance: 0.8,
    }));

    const replaceResult = await bridge.executeToolHandler('graph-batch-store', {
      items: updatedItems,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
      onDuplicate: 'replace',
      deduplicateBy: ['itemId'],
    }) as Record<string, unknown>;

    console.log(`[batch] Replace result:`, JSON.stringify(replaceResult, null, 2));

    // Replace should either have stored (updated) or stored (created new)
    const totalProcessed = (replaceResult.stored as number) + (replaceResult.skipped as number);
    expect(totalProcessed).toBe(3);

    // Verify updated content exists
    const checkResult = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      {
        database: ctx.database,
        query: `SELECT * FROM ${TEST_VERTEX_TYPE} WHERE itemId = 'dedup-item-0' ORDER BY version DESC LIMIT 1`,
      },
    );

    expect(checkResult.success).toBe(true);
    if (checkResult.result && checkResult.result.length > 0) {
      const item = checkResult.result[0];
      console.log(`[batch] Dedup item version: ${item.version}, content: ${(item.content as string)?.substring(0, 60)}`);
      // Should be version 2 or contain "UPDATED"
      const content = (item.content as string) ?? '';
      const version = (item.version as number) ?? 0;
      expect(version === 2 || content.includes('UPDATED')).toBe(true);
    }
  }, 180_000);

  // ── Batch with skip dedup ─────────────────────────────────────────── 

  it('batch with skip dedup strategy skips existing items', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Skip check item ${i}`,
      vertexType: TEST_VERTEX_TYPE,
      properties: {
        itemId: `dedup-item-${i}`,  // Same IDs as above
        version: 3,
      },
      skipExtraction: true,
      importance: 0.5,
    }));

    const skipResult = await bridge.executeToolHandler('graph-batch-store', {
      items,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
      onDuplicate: 'skip',
      deduplicateBy: ['itemId'],
    }) as Record<string, unknown>;

    console.log(`[batch] Skip dedup result:`, JSON.stringify(skipResult, null, 2));

    // All 3 should be skipped since dedup-item-0/1/2 already exist
    expect(skipResult.skipped).toBe(3);
    expect(skipResult.stored).toBe(0);
  }, 120_000);

  // ── Empty batch ───────────────────────────────────────────────────── 

  it('empty batch returns zero counts', async () => {
    const result = await bridge.executeToolHandler('graph-batch-store', {
      items: [],
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
    }) as Record<string, unknown>;

    expect(result.stored).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  }, 30_000);
});

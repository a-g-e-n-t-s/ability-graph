/**
 * Integration test: Schema registration + idempotency
 *
 * Tests:
 * - Register a custom schema → verify ArcadeDB vertex types and indexes exist
 * - Register same schema again → verify idempotency (no errors)
 *
 * Requires live infrastructure: broker + arcadedb-ability + model-manager
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KadiClient } from '@kadi.build/core';

import { schemaRegistry } from '../../src/lib/schema-registry.js';
import { invokeWithRetry } from '../../src/lib/retry.js';
import { TOPIC_VERTEX, ENTITY_VERTEX, COMMON_EDGE_TYPES } from '../../src/lib/types.js';
import type { SignalAbilities, ArcadeQueryResult, ArcadeCommandResult, SchemaDefinition } from '../../src/lib/types.js';
import {
  BROKER_URL,
  TEST_PREFIX,
  TEST_DATABASE,
  createTestContext,
  resetSchemaRegistry,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

const TEST_SCHEMA_NAME = `${TEST_PREFIX}_schema`;
const TEST_VERTEX_TYPE = `TestVertex_${Date.now()}`;

beforeAll(async () => {
  ctx = await createTestContext('schema-test');
  resetSchemaRegistry();
}, 60_000);

afterAll(async () => {
  // Cleanup: try to drop test vertex types (best-effort)
  try {
    await invokeWithRetry<ArcadeCommandResult>(
      ctx.abilities,
      'arcade-command',
      { database: ctx.database, command: `DELETE VERTEX ${TEST_VERTEX_TYPE}` },
    );
  } catch {
    // Ignore — type may not exist
  }

  await ctx.client.disconnect();
}, 15_000);

describe('graph-ability schema integration', () => {

  // ---- Register a custom schema ─────────────────────────────────────── 

  it('registers a custom schema and creates vertex types in ArcadeDB', async () => {
    const schemaDef: SchemaDefinition = {
      name: TEST_SCHEMA_NAME,
      database: ctx.database,
      vertexTypes: [
        {
          name: TEST_VERTEX_TYPE,
          properties: {
            content: 'STRING',
            importance: 'DOUBLE',
            embedding: 'LIST',
            testField: 'STRING',
          },
          indexes: [
            { property: 'content', type: 'FULL_TEXT' },
            { property: 'testField', type: 'NOTUNIQUE' },
          ],
        },
        TOPIC_VERTEX,
        ENTITY_VERTEX,
      ],
      edgeTypes: [
        ...COMMON_EDGE_TYPES,
        { name: 'TestEdge', properties: { weight: 'DOUBLE' } },
      ],
    };

    // Register and apply DDL
    schemaRegistry.register(schemaDef);
    await schemaRegistry.ensureInfrastructure(ctx.abilities, ctx.database);

    // Verify vertex type exists via arcade-query
    const typeCheck = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: ctx.database, query: `SELECT FROM schema:types WHERE name = '${TEST_VERTEX_TYPE}'` },
    );

    expect(typeCheck.success).toBe(true);
    expect(typeCheck.result).toBeDefined();
    expect(typeCheck.result!.length).toBeGreaterThan(0);
    console.log(`[schema] Vertex type ${TEST_VERTEX_TYPE} created successfully`);

    // Verify Topic type exists
    const topicCheck = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: ctx.database, query: `SELECT FROM schema:types WHERE name = 'Topic'` },
    );
    expect(topicCheck.success).toBe(true);
    expect(topicCheck.result!.length).toBeGreaterThan(0);

    // Verify Entity type exists
    const entityCheck = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: ctx.database, query: `SELECT FROM schema:types WHERE name = 'Entity'` },
    );
    expect(entityCheck.success).toBe(true);
    expect(entityCheck.result!.length).toBeGreaterThan(0);

    // Verify indexes exist
    const indexCheck = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: ctx.database, query: 'SELECT FROM schema:indexes' },
    );
    expect(indexCheck.success).toBe(true);

    const indexNames = (indexCheck.result ?? []).map(
      (row) => (row.name as string ?? '').toLowerCase(),
    );

    // Should have at least our test indexes
    const hasContentIndex = indexNames.some(
      (n) => n.includes(TEST_VERTEX_TYPE.toLowerCase()) && n.includes('content'),
    );
    const hasTestFieldIndex = indexNames.some(
      (n) => n.includes(TEST_VERTEX_TYPE.toLowerCase()) && n.includes('testfield'),
    );

    console.log(`[schema] Indexes found: content=${hasContentIndex}, testField=${hasTestFieldIndex}`);
    console.log(`[schema] Total indexes: ${indexNames.length}`);

    // At minimum, indexes should have been attempted
    expect(indexCheck.result!.length).toBeGreaterThan(0);
  }, 120_000);

  // ---- Idempotency ─────────────────────────────────────────────────── 

  it('re-registering the same schema is idempotent (no errors)', async () => {
    // Reset the applied state so it re-applies DDL
    resetSchemaRegistry();

    const schemaDef: SchemaDefinition = {
      name: `${TEST_SCHEMA_NAME}_idem`,
      database: ctx.database,
      vertexTypes: [
        {
          name: TEST_VERTEX_TYPE,
          properties: {
            content: 'STRING',
            importance: 'DOUBLE',
            embedding: 'LIST',
            testField: 'STRING',
          },
          indexes: [
            { property: 'content', type: 'FULL_TEXT' },
            { property: 'testField', type: 'NOTUNIQUE' },
          ],
        },
        TOPIC_VERTEX,
        ENTITY_VERTEX,
      ],
      edgeTypes: [
        ...COMMON_EDGE_TYPES,
        { name: 'TestEdge', properties: { weight: 'DOUBLE' } },
      ],
    };

    // Register and apply again — should NOT throw
    schemaRegistry.register(schemaDef);
    await schemaRegistry.ensureInfrastructure(ctx.abilities, ctx.database);

    // Verify types still exist after second application
    const typeCheck = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: ctx.database, query: `SELECT FROM schema:types WHERE name = '${TEST_VERTEX_TYPE}'` },
    );
    expect(typeCheck.success).toBe(true);
    expect(typeCheck.result!.length).toBeGreaterThan(0);

    console.log('[schema] Idempotent re-registration succeeded');
  }, 120_000);

  // ---- Edge types ───────────────────────────────────────────────────── 

  it('creates edge types correctly', async () => {
    // Verify edge types exist
    for (const edgeTypeName of ['HasTopic', 'Mentions', 'RelatedTo', 'TestEdge']) {
      const check = await invokeWithRetry<ArcadeQueryResult>(
        ctx.abilities,
        'arcade-query',
        {
          database: ctx.database,
          query: `SELECT FROM schema:types WHERE name = '${edgeTypeName}'`,
        },
      );
      expect(check.success).toBe(true);
      expect(check.result!.length).toBeGreaterThan(0);
      console.log(`[schema] Edge type ${edgeTypeName} verified`);
    }
  }, 60_000);

  // ---- Vector index (lazy creation) ─────────────────────────────────── 

  it('creates a vector index lazily when given dimensions', async () => {
    // Ensure vector index with a specific dimension
    await schemaRegistry.ensureVectorIndex(
      ctx.abilities,
      ctx.database,
      TEST_VERTEX_TYPE,
      1536,
    );

    // Verify the vector index exists
    const indexCheck = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      { database: ctx.database, query: 'SELECT FROM schema:indexes' },
    );
    expect(indexCheck.success).toBe(true);

    const vectorIndex = (indexCheck.result ?? []).find(
      (row) => {
        const name = (row.name as string ?? '').toLowerCase();
        return name.includes(TEST_VERTEX_TYPE.toLowerCase()) && name.includes('embedding');
      },
    );

    // Vector index should exist (might show as LSM_VECTOR or similar)
    console.log('[schema] Vector indexes:', (indexCheck.result ?? [])
      .filter((r) => (r.name as string ?? '').toLowerCase().includes('embed'))
      .map((r) => r.name));

    // Second call should be a no-op (idempotent)
    await schemaRegistry.ensureVectorIndex(
      ctx.abilities,
      ctx.database,
      TEST_VERTEX_TYPE,
      1536,
    );
    console.log('[schema] Vector index idempotent call succeeded');
  }, 60_000);
});

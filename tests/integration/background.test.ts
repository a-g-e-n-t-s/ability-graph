/**
 * Integration test: Background job manager + batch-store background mode
 *
 * Tests:
 * - Background job lifecycle: start → running → complete
 * - Batch-store with background: true → poll job status → verify DB
 * - Job cancellation
 * - Stale job pruning
 * - Multiple concurrent background jobs
 *
 * Requires live infrastructure: broker + arcadedb-ability + model-manager
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jobManager } from '../../src/lib/job-manager.js';
import { schemaRegistry } from '../../src/lib/schema-registry.js';
import { invokeWithRetry } from '../../src/lib/retry.js';
import { TOPIC_VERTEX, ENTITY_VERTEX, COMMON_EDGE_TYPES } from '../../src/lib/types.js';
import type { ArcadeQueryResult, SchemaDefinition, JobStatus } from '../../src/lib/types.js';
import {
  createTestContext,
  cleanupTestVertices,
  resetSchemaRegistry,
  type TestContext,
} from './helpers.js';

// Import tool registrations
import { registerBatchStoreTool } from '../../src/tools/batch-store.js';

let ctx: TestContext;
let bridge: { executeToolHandler(tool: string, params: unknown): Promise<unknown> };

const TEST_VERTEX_TYPE = 'BgJobTest';
const TEST_CONTENT_PREFIX = `GRAPH_TEST_BJ_${Date.now()}`;

beforeAll(async () => {
  ctx = await createTestContext('background-test');
  resetSchemaRegistry();
  jobManager.clear();

  // Register batch-store tool
  registerBatchStoreTool(ctx.client, ctx.config);
  bridge = ctx.client.createToolBridge();

  // Register test schema
  const schemaDef: SchemaDefinition = {
    name: 'bg-job-test',
    database: ctx.database,
    vertexTypes: [
      {
        name: TEST_VERTEX_TYPE,
        properties: {
          content: 'STRING',
          importance: 'DOUBLE',
          embedding: 'LIST',
          itemId: 'STRING',
        },
        indexes: [
          { property: 'content', type: 'FULL_TEXT' },
        ],
      },
      TOPIC_VERTEX,
      ENTITY_VERTEX,
    ],
    edgeTypes: COMMON_EDGE_TYPES,
  };

  schemaRegistry.register(schemaDef);
  await schemaRegistry.ensureInfrastructure(ctx.abilities, ctx.database);
  console.log('[background] Schema registered');
}, 120_000);

afterAll(async () => {
  jobManager.clear();
  await cleanupTestVertices(ctx.abilities, ctx.database, TEST_VERTEX_TYPE, TEST_CONTENT_PREFIX);
  await ctx.client.disconnect();
}, 30_000);

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

async function waitForJob(
  jobId: string,
  maxWaitMs: number = 120_000,
  pollIntervalMs: number = 1000,
): Promise<JobStatus | undefined> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const status = jobManager.getStatus(jobId);
    if (!status) return undefined;
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return jobManager.getStatus(jobId);
}

describe('graph-ability background job integration', () => {

  // ── Job Manager unit-level checks (no infra needed) ────────────── 

  it('job lifecycle: start → update → complete', () => {
    const job = jobManager.startJob(100);
    expect(job.status).toBe('running');
    expect(job.progress).toBe(0);
    expect(job.total).toBe(100);

    jobManager.updateProgress(job.jobId, 50);
    const updated = jobManager.getStatus(job.jobId);
    expect(updated?.progress).toBe(50);
    expect(updated?.processed).toBe(50);

    jobManager.complete(job.jobId, { stored: 100 });
    const completed = jobManager.getStatus(job.jobId);
    expect(completed?.status).toBe('completed');
    expect(completed?.progress).toBe(100);
    expect(completed?.result?.stored).toBe(100);
    expect(completed?.completedAt).toBeDefined();
  });

  it('job lifecycle: start → fail', () => {
    const job = jobManager.startJob(10);
    jobManager.fail(job.jobId, 'Something went wrong');

    const status = jobManager.getStatus(job.jobId);
    expect(status?.status).toBe('failed');
    expect(status?.error).toBe('Something went wrong');
    expect(status?.completedAt).toBeDefined();
  });

  it('job cancellation', () => {
    const job = jobManager.startJob(50);

    const cancelled = jobManager.cancel(job.jobId);
    expect(cancelled).toBe(true);

    const status = jobManager.getStatus(job.jobId);
    expect(status?.status).toBe('cancelled');

    // Can't cancel again
    expect(jobManager.cancel(job.jobId)).toBe(false);
  });

  it('stale job pruning', async () => {
    jobManager.clear();

    // Create a job and immediately complete it
    const job1 = jobManager.startJob(1);
    jobManager.complete(job1.jobId);

    const job2 = jobManager.startJob(1);
    jobManager.complete(job2.jobId);

    const job3 = jobManager.startJob(100); // Still running

    expect(jobManager.listJobs().length).toBe(3);

    // Small delay so completed timestamps are in the past relative to Date.now()
    await new Promise((r) => setTimeout(r, 5));

    // Prune with 0ms max age — should remove completed jobs
    const pruned = jobManager.pruneStale(0);
    expect(pruned).toBe(2); // job1 and job2 removed
    expect(jobManager.listJobs().length).toBe(1);
    expect(jobManager.getStatus(job3.jobId)?.status).toBe('running');

    // Cleanup
    jobManager.cancel(job3.jobId);
  });

  // ── Background batch-store: fire-and-forget → poll → verify ──── 

  it('batch-store with background: true returns job and completes', async () => {
    jobManager.clear();

    // Clean up any leftover data from previous runs
    await cleanupTestVertices(ctx.abilities, ctx.database, TEST_VERTEX_TYPE, TEST_CONTENT_PREFIX);

    const items = Array.from({ length: 15 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Background item ${i} about distributed systems.`,
      vertexType: TEST_VERTEX_TYPE,
      properties: {
        itemId: `bg-item-${i}`,
      },
      skipExtraction: true,
      importance: 0.6,
    }));

    // Fire as background job
    const result = await bridge.executeToolHandler('graph-batch-store', {
      items,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
      background: true,
      concurrency: 5,
    }) as Record<string, unknown>;

    console.log(`[background] Batch-store returned:`, JSON.stringify(result, null, 2));

    expect(result.jobId).toBeDefined();
    expect(result.status).toBe('running');
    expect(result.total).toBe(15);

    const jobId = result.jobId as string;

    // Poll until complete
    const finalStatus = await waitForJob(jobId, 180_000, 2000);

    console.log(`[background] Job final status:`, JSON.stringify(finalStatus, null, 2));
    expect(finalStatus).toBeDefined();
    expect(finalStatus!.status).toBe('completed');
    expect(finalStatus!.progress).toBe(100);

    // Verify the result data
    if (finalStatus!.result) {
      const stored = (finalStatus!.result as Record<string, unknown>).stored as number;
      expect(stored).toBe(15);
    }

    // Verify items in DB
    const countResult = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      {
        database: ctx.database,
        query: `SELECT count(*) as cnt FROM ${TEST_VERTEX_TYPE} WHERE content LIKE '${TEST_CONTENT_PREFIX}: Background item%'`,
      },
    );

    expect(countResult.success).toBe(true);
    const count = (countResult.result?.[0]?.cnt as number) ?? 0;
    expect(count).toBe(15);
    console.log(`[background] Verified ${count}/15 items in DB`);
  }, 240_000);

  // ── Multiple concurrent background jobs ───────────────────────── 

  it('tracks multiple concurrent background jobs independently', async () => {
    // Clean up leftover data from previous runs
    await cleanupTestVertices(ctx.abilities, ctx.database, TEST_VERTEX_TYPE, TEST_CONTENT_PREFIX);
    jobManager.clear();

    const batch1Items = Array.from({ length: 5 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Concurrent batch A item ${i}`,
      vertexType: TEST_VERTEX_TYPE,
      properties: { itemId: `concurrent-a-${i}` },
      skipExtraction: true,
      importance: 0.5,
    }));

    const batch2Items = Array.from({ length: 5 }, (_, i) => ({
      content: `${TEST_CONTENT_PREFIX}: Concurrent batch B item ${i}`,
      vertexType: TEST_VERTEX_TYPE,
      properties: { itemId: `concurrent-b-${i}` },
      skipExtraction: true,
      importance: 0.7,
    }));

    // Fire both as background jobs
    const result1 = await bridge.executeToolHandler('graph-batch-store', {
      items: batch1Items,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
      background: true,
    }) as Record<string, unknown>;

    const result2 = await bridge.executeToolHandler('graph-batch-store', {
      items: batch2Items,
      vertexType: TEST_VERTEX_TYPE,
      database: ctx.database,
      background: true,
    }) as Record<string, unknown>;

    expect(result1.jobId).toBeDefined();
    expect(result2.jobId).toBeDefined();
    expect(result1.jobId).not.toBe(result2.jobId);

    // Wait for both
    const [status1, status2] = await Promise.all([
      waitForJob(result1.jobId as string, 120_000),
      waitForJob(result2.jobId as string, 120_000),
    ]);

    console.log(`[background] Job 1: ${status1?.status}, Job 2: ${status2?.status}`);

    expect(status1?.status).toBe('completed');
    expect(status2?.status).toBe('completed');

    // Verify jobs tracked independently
    const allJobs = jobManager.listJobs();
    expect(allJobs.filter(j => j.status === 'completed').length).toBeGreaterThanOrEqual(2);
  }, 180_000);
});

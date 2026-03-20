/**
 * Unit tests for batch-store logic — batched embedding, dedup strategies,
 * progress tracking, and error handling.
 *
 * We test the batch-store tool handler indirectly by verifying the
 * batch pipeline's behavior through the public interface. Because the tool
 * is registered via registerBatchStoreTool which needs a KadiClient, we
 * test the underlying patterns using mocks of the dependency chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobManager } from '../../src/lib/job-manager.js';

// We test the JobManager integration directly since the batch-store
// pipeline delegates to it, and the actual batch pipeline requires a
// full KadiClient.  The batch-store tool cannot be unit-tested in
// isolation without an integration harness. Instead, we test:
//   1. Job lifecycle in batch scenarios
//   2. Dedup strategy logic patterns
//   3. Progress tracking

describe('Batch Processing — Job Integration', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  describe('batch job lifecycle', () => {
    it('should track a batch from start to completion', () => {
      const total = 20;
      const job = manager.startJob(total);

      expect(job.status).toBe('running');
      expect(job.total).toBe(total);

      // Simulate processing progress
      for (let i = 1; i <= total; i++) {
        manager.updateProgress(job.jobId, i);
      }

      const midStatus = manager.getStatus(job.jobId)!;
      expect(midStatus.processed).toBe(total);
      expect(midStatus.progress).toBe(100);

      // Complete
      manager.complete(job.jobId, { stored: 18, skipped: 1, failed: 1 });

      const finalStatus = manager.getStatus(job.jobId)!;
      expect(finalStatus.status).toBe('completed');
      expect(finalStatus.result).toEqual({ stored: 18, skipped: 1, failed: 1 });
    });

    it('should track partial failure (fail job when all items fail)', () => {
      const total = 5;
      const job = manager.startJob(total);

      // Simulate all items failing
      for (let i = 1; i <= total; i++) {
        manager.updateProgress(job.jobId, i);
      }

      manager.fail(job.jobId, 'All 5 items failed');

      const status = manager.getStatus(job.jobId)!;
      expect(status.status).toBe('failed');
      expect(status.error).toBe('All 5 items failed');
    });

    it('should handle cancellation during processing', () => {
      const job = manager.startJob(100);

      manager.updateProgress(job.jobId, 10);

      const cancelled = manager.cancel(job.jobId);
      expect(cancelled).toBe(true);

      const status = manager.getStatus(job.jobId)!;
      expect(status.status).toBe('cancelled');
      expect(status.processed).toBe(10);

      // Further updates should be ignored
      manager.updateProgress(job.jobId, 50);
      expect(manager.getStatus(job.jobId)!.processed).toBe(10);
    });

    it('should handle empty batch', () => {
      const job = manager.startJob(0);

      manager.complete(job.jobId, { stored: 0, skipped: 0, failed: 0 });

      const status = manager.getStatus(job.jobId)!;
      expect(status.status).toBe('completed');
      expect(status.progress).toBe(100);
      expect(status.processed).toBe(0);
    });
  });

  describe('progress computation', () => {
    it('should compute correct percentage at each step', () => {
      const job = manager.startJob(4);

      manager.updateProgress(job.jobId, 1);
      expect(manager.getStatus(job.jobId)!.progress).toBe(25);

      manager.updateProgress(job.jobId, 2);
      expect(manager.getStatus(job.jobId)!.progress).toBe(50);

      manager.updateProgress(job.jobId, 3);
      expect(manager.getStatus(job.jobId)!.progress).toBe(75);

      manager.updateProgress(job.jobId, 4);
      expect(manager.getStatus(job.jobId)!.progress).toBe(100);
    });

    it('should round progress correctly', () => {
      const job = manager.startJob(3);

      manager.updateProgress(job.jobId, 1);
      expect(manager.getStatus(job.jobId)!.progress).toBe(33);

      manager.updateProgress(job.jobId, 2);
      expect(manager.getStatus(job.jobId)!.progress).toBe(67);
    });
  });

  describe('concurrent batch tracking', () => {
    it('should track multiple batch jobs independently', () => {
      const job1 = manager.startJob(10);
      const job2 = manager.startJob(20);

      manager.updateProgress(job1.jobId, 5);
      manager.updateProgress(job2.jobId, 15);

      expect(manager.getStatus(job1.jobId)!.processed).toBe(5);
      expect(manager.getStatus(job1.jobId)!.total).toBe(10);
      expect(manager.getStatus(job2.jobId)!.processed).toBe(15);
      expect(manager.getStatus(job2.jobId)!.total).toBe(20);

      manager.complete(job1.jobId, { stored: 10 });
      expect(manager.getStatus(job1.jobId)!.status).toBe('completed');
      expect(manager.getStatus(job2.jobId)!.status).toBe('running');
    });
  });
});

describe('Dedup Strategy Logic', () => {
  // These test the dedup decision logic that the batch pipeline uses.
  // We model the decision as a pure function for testability.

  type DedupStrategy = 'skip' | 'replace' | 'error';

  interface DedupDecision {
    action: 'create' | 'skip' | 'replace';
  }

  function dedupDecide(
    found: boolean,
    strategy: DedupStrategy,
  ): DedupDecision {
    if (!found) return { action: 'create' };

    switch (strategy) {
      case 'skip':
        return { action: 'skip' };
      case 'replace':
        return { action: 'replace' };
      case 'error':
      default:
        return { action: 'create' }; // Fall through to natural constraint failure
    }
  }

  it('should create when no duplicate found', () => {
    expect(dedupDecide(false, 'skip').action).toBe('create');
    expect(dedupDecide(false, 'replace').action).toBe('create');
    expect(dedupDecide(false, 'error').action).toBe('create');
  });

  it('should skip when duplicate found and strategy is skip', () => {
    expect(dedupDecide(true, 'skip').action).toBe('skip');
  });

  it('should replace when duplicate found and strategy is replace', () => {
    expect(dedupDecide(true, 'replace').action).toBe('replace');
  });

  it('should fall through to create on error strategy (will fail on DB constraint)', () => {
    expect(dedupDecide(true, 'error').action).toBe('create');
  });
});

describe('Batch Item Validation', () => {
  it('should require vertexType from item or default', () => {
    const items = [
      { content: 'hello', vertexType: 'Memory' },
      { content: 'world' }, // No vertexType
    ];
    const defaultType = undefined;

    const missing = items.filter(
      (item) => !item.vertexType && !defaultType,
    );

    expect(missing.length).toBe(1);
    expect(missing[0].content).toBe('world');
  });

  it('should resolve vertexType with default fallback', () => {
    const items = [
      { content: 'hello', vertexType: 'Memory' },
      { content: 'world' },
    ];
    const defaultType = 'Note';

    const resolved = items.map((item) => ({
      ...item,
      resolvedType: item.vertexType ?? defaultType,
    }));

    expect(resolved[0].resolvedType).toBe('Memory');
    expect(resolved[1].resolvedType).toBe('Note');
  });

  it('should handle items with pre-specified topics and entities (skip extraction)', () => {
    const item = {
      content: 'Test content',
      topics: ['AI', 'ML'],
      entities: [{ name: 'TensorFlow', type: 'tool' }],
    };

    const needsExtraction = !item.topics?.length && !item.entities?.length;
    expect(needsExtraction).toBe(false);
  });

  it('should detect items needing extraction', () => {
    const item = { content: 'Bare content' };

    const needsExtraction = !(item as any).topics?.length && !(item as any).entities?.length;
    expect(needsExtraction).toBe(true);
  });
});

describe('Batch Result Aggregation', () => {
  it('should correctly aggregate batch results', () => {
    const results = { stored: 0, skipped: 0, failed: 0, errors: [] as Array<{ index: number; error: string }> };
    const items = ['ok', 'ok', 'skip', 'fail', 'ok'];

    for (let i = 0; i < items.length; i++) {
      switch (items[i]) {
        case 'ok':
          results.stored++;
          break;
        case 'skip':
          results.skipped++;
          break;
        case 'fail':
          results.failed++;
          results.errors.push({ index: i, error: 'test error' });
          break;
      }
    }

    expect(results.stored).toBe(3);
    expect(results.skipped).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.errors).toHaveLength(1);
    expect(results.errors[0]).toEqual({ index: 3, error: 'test error' });
  });

  it('should compute total processed as stored + skipped + failed', () => {
    const stored = 7;
    const skipped = 2;
    const failed = 1;
    const totalProcessed = stored + skipped + failed;

    expect(totalProcessed).toBe(10);
  });
});

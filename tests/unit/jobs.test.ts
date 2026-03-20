/**
 * Unit tests for the job manager — start, status, progress, complete, fail, cancel, prune.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { JobManager } from '../../src/lib/job-manager.js';

describe('JobManager', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  describe('startJob', () => {
    it('should create a new running job', () => {
      const job = manager.startJob(10);

      expect(job.jobId).toBeTruthy();
      expect(job.status).toBe('running');
      expect(job.progress).toBe(0);
      expect(job.processed).toBe(0);
      expect(job.total).toBe(10);
      expect(job.startedAt).toBeTruthy();
    });

    it('should generate unique job IDs', () => {
      const job1 = manager.startJob(5);
      const job2 = manager.startJob(10);
      const job3 = manager.startJob(15);

      expect(job1.jobId).not.toBe(job2.jobId);
      expect(job2.jobId).not.toBe(job3.jobId);
      expect(job1.jobId).not.toBe(job3.jobId);
    });
  });

  describe('getStatus', () => {
    it('should return job status by ID', () => {
      const job = manager.startJob(10);
      const status = manager.getStatus(job.jobId);

      expect(status).toBeDefined();
      expect(status!.jobId).toBe(job.jobId);
      expect(status!.status).toBe('running');
    });

    it('should return undefined for unknown job ID', () => {
      const status = manager.getStatus('nonexistent-job');
      expect(status).toBeUndefined();
    });
  });

  describe('updateProgress', () => {
    it('should update processed count and progress percentage', () => {
      const job = manager.startJob(10);
      manager.updateProgress(job.jobId, 5);

      const status = manager.getStatus(job.jobId)!;
      expect(status.processed).toBe(5);
      expect(status.progress).toBe(50);
    });

    it('should handle progress at 100%', () => {
      const job = manager.startJob(10);
      manager.updateProgress(job.jobId, 10);

      const status = manager.getStatus(job.jobId)!;
      expect(status.processed).toBe(10);
      expect(status.progress).toBe(100);
    });

    it('should not update non-running jobs', () => {
      const job = manager.startJob(10);
      manager.complete(job.jobId);
      manager.updateProgress(job.jobId, 5);

      const status = manager.getStatus(job.jobId)!;
      expect(status.processed).toBe(10); // Should stay at total, not 5
    });

    it('should handle zero total gracefully', () => {
      const job = manager.startJob(0);
      manager.updateProgress(job.jobId, 0);

      const status = manager.getStatus(job.jobId)!;
      expect(status.progress).toBe(0);
    });
  });

  describe('complete', () => {
    it('should mark job as completed', () => {
      const job = manager.startJob(10);
      manager.complete(job.jobId, { stored: 10, failed: 0 });

      const status = manager.getStatus(job.jobId)!;
      expect(status.status).toBe('completed');
      expect(status.progress).toBe(100);
      expect(status.processed).toBe(10);
      expect(status.completedAt).toBeTruthy();
      expect(status.result).toEqual({ stored: 10, failed: 0 });
    });

    it('should ignore unknown job IDs', () => {
      // Should not throw
      manager.complete('nonexistent-job');
    });
  });

  describe('fail', () => {
    it('should mark job as failed with error message', () => {
      const job = manager.startJob(10);
      manager.updateProgress(job.jobId, 3);
      manager.fail(job.jobId, 'Database connection lost');

      const status = manager.getStatus(job.jobId)!;
      expect(status.status).toBe('failed');
      expect(status.error).toBe('Database connection lost');
      expect(status.completedAt).toBeTruthy();
      expect(status.processed).toBe(3); // Preserves progress
    });

    it('should ignore unknown job IDs', () => {
      manager.fail('nonexistent-job', 'error');
    });
  });

  describe('cancel', () => {
    it('should cancel a running job', () => {
      const job = manager.startJob(10);
      const cancelled = manager.cancel(job.jobId);

      expect(cancelled).toBe(true);

      const status = manager.getStatus(job.jobId)!;
      expect(status.status).toBe('cancelled');
      expect(status.completedAt).toBeTruthy();
    });

    it('should return false for non-running jobs', () => {
      const job = manager.startJob(10);
      manager.complete(job.jobId);

      const cancelled = manager.cancel(job.jobId);
      expect(cancelled).toBe(false);
    });

    it('should return false for unknown job IDs', () => {
      const cancelled = manager.cancel('nonexistent-job');
      expect(cancelled).toBe(false);
    });
  });

  describe('pruneStale', () => {
    it('should prune completed jobs older than maxAge', () => {
      const job1 = manager.startJob(10);
      manager.complete(job1.jobId);

      // Manually set completedAt to the past
      const status = manager.getStatus(job1.jobId)!;
      status.completedAt = new Date(Date.now() - 60_000).toISOString();

      const pruned = manager.pruneStale(30_000); // 30 seconds

      expect(pruned).toBe(1);
      expect(manager.getStatus(job1.jobId)).toBeUndefined();
    });

    it('should not prune running jobs', () => {
      const job = manager.startJob(10);

      const pruned = manager.pruneStale(0); // Prune everything
      expect(pruned).toBe(0);
      expect(manager.getStatus(job.jobId)).toBeDefined();
    });

    it('should not prune jobs within maxAge', () => {
      const job = manager.startJob(10);
      manager.complete(job.jobId);

      const pruned = manager.pruneStale(60_000_000); // Very large maxAge
      expect(pruned).toBe(0);
    });

    it('should prune failed and cancelled jobs', () => {
      const job1 = manager.startJob(10);
      manager.fail(job1.jobId, 'error');
      const s1 = manager.getStatus(job1.jobId)!;
      s1.completedAt = new Date(Date.now() - 60_000).toISOString();

      const job2 = manager.startJob(5);
      manager.cancel(job2.jobId);
      const s2 = manager.getStatus(job2.jobId)!;
      s2.completedAt = new Date(Date.now() - 60_000).toISOString();

      const pruned = manager.pruneStale(30_000);
      expect(pruned).toBe(2);
    });
  });

  describe('listJobs', () => {
    it('should list all jobs', () => {
      manager.startJob(5);
      manager.startJob(10);
      manager.startJob(15);

      const jobs = manager.listJobs();
      expect(jobs.length).toBe(3);
    });

    it('should return empty array when no jobs', () => {
      const jobs = manager.listJobs();
      expect(jobs).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all jobs', () => {
      manager.startJob(5);
      manager.startJob(10);
      manager.clear();

      const jobs = manager.listJobs();
      expect(jobs).toEqual([]);
    });
  });
});

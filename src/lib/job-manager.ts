/**
 * Job Manager — in-memory tracking for background batch operations.
 *
 * This is the INLINE version — no ProcessManager integration.
 * Just tracking state for batch operations with methods to start,
 * update, complete, fail, and cancel jobs.
 *
 * ProcessManager integration (optional, Session 7) will extend this.
 */

import type { JobStatus } from './types.js';

// ---------------------------------------------------------------------------
// Job Manager
// ---------------------------------------------------------------------------

export class JobManager {
  private jobs = new Map<string, JobStatus>();

  /**
   * Start a new job and track it.
   *
   * @param total - Total items in the job.
   * @returns The new job's status with generated jobId.
   */
  startJob(total: number): JobStatus {
    const jobId = generateJobId();
    const job: JobStatus = {
      jobId,
      status: 'running',
      progress: 0,
      processed: 0,
      total,
      startedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);
    return job;
  }

  /**
   * Get the status of a job by ID.
   *
   * @param jobId - The job identifier.
   * @returns The job status, or undefined if not found.
   */
  getStatus(jobId: string): JobStatus | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Update progress for a running job.
   *
   * @param jobId     - The job identifier.
   * @param processed - Number of items processed so far.
   */
  updateProgress(jobId: string, processed: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    job.processed = processed;
    job.progress = job.total > 0 ? Math.round((processed / job.total) * 100) : 0;
  }

  /**
   * Mark a job as completed.
   *
   * @param jobId  - The job identifier.
   * @param result - Optional result data.
   */
  complete(jobId: string, result?: Record<string, unknown>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'completed';
    job.progress = 100;
    job.processed = job.total;
    job.completedAt = new Date().toISOString();
    if (result) job.result = result;
  }

  /**
   * Mark a job as failed.
   *
   * @param jobId - The job identifier.
   * @param error - Error message.
   */
  fail(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error;
  }

  /**
   * Cancel a running job.
   *
   * @param jobId - The job identifier.
   * @returns true if the job was cancelled, false if not found or not running.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return false;

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    return true;
  }

  /**
   * Prune stale jobs older than maxAge.
   *
   * @param maxAgeMs - Maximum age in milliseconds. Jobs completed/failed
   *                   longer ago than this are removed.
   * @returns Number of jobs pruned.
   */
  pruneStale(maxAgeMs: number): number {
    const now = Date.now();
    let pruned = 0;

    for (const [jobId, job] of this.jobs) {
      if (job.status === 'running') continue; // Don't prune running jobs

      const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : 0;
      const startedAt = new Date(job.startedAt).getTime();
      const referenceTime = completedAt || startedAt;

      if (now - referenceTime > maxAgeMs) {
        this.jobs.delete(jobId);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * List all jobs.
   */
  listJobs(): JobStatus[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Clear all jobs (for testing).
   */
  clear(): void {
    this.jobs.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let jobCounter = 0;

function generateJobId(): string {
  jobCounter++;
  const ts = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `job-${ts}-${random}-${jobCounter}`;
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/** Global job manager instance. */
export const jobManager = new JobManager();

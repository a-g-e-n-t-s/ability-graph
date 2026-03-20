/**
 * graph-job-cancel tool — cancel a running background job.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { jobManager } from '../lib/job-manager.js';

export function registerJobCancelTool(
  client: KadiClient,
  _config: GraphConfig,
): void {
  client.registerTool(
    {
      name: 'graph-job-cancel',
      description: 'Cancel a running background job.',
      input: z.object({
        jobId: z.string().describe('The job identifier to cancel'),
      }),
    },
    async (input) => {
      const cancelled = jobManager.cancel(input.jobId);
      const status = jobManager.getStatus(input.jobId);

      if (!cancelled) {
        return {
          success: false,
          error: `Job "${input.jobId}" not found or not running`,
          tool: 'graph-job-cancel',
          status: status?.status,
        };
      }

      return {
        success: true,
        cancelled: true,
        jobId: input.jobId,
        progress: status?.progress ?? 0,
      };
    },
  );
}

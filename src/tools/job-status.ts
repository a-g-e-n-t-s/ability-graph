/**
 * graph-job-status tool — query job manager for status.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { jobManager } from '../lib/job-manager.js';

export function registerJobStatusTool(
  client: KadiClient,
  _config: GraphConfig,
): void {
  client.registerTool(
    {
      name: 'graph-job-status',
      description: 'Check the status and progress of a background job.',
      input: z.object({
        jobId: z.string().describe('The job identifier'),
      }),
    },
    async (input) => {
      const status = jobManager.getStatus(input.jobId);

      if (!status) {
        return {
          success: false,
          error: `Job "${input.jobId}" not found`,
          tool: 'graph-job-status',
        };
      }

      return {
        success: true,
        ...status,
      };
    },
  );
}

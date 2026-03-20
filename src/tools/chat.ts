/**
 * graph-chat tool — chat completion passthrough via the broker's model-manager.
 *
 * Sends a chat completion request with configurable model, temperature, and
 * token limits. Uses invokeWithRetry for automatic retry with exponential
 * backoff.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { GraphConfig } from '../lib/config.js';
import { invokeWithRetry } from '../lib/retry.js';
import type { SignalAbilities } from '../lib/types.js';

export function registerChatTool(
  client: KadiClient,
  config: GraphConfig,
): void {
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  client.registerTool(
    {
      name: 'graph-chat',
      description:
        'Send a chat completion request via the model manager. Supports system and user ' +
        'messages with configurable temperature and token limits.',
      input: z.object({
        messages: z.array(z.object({
          role: z.string().describe('Message role (e.g., system, user, assistant)'),
          content: z.string().describe('Message content'),
        })).describe('Chat messages to send'),
        model: z.string().optional().describe('Model to use (default: from config)'),
        temperature: z.number().optional().describe('Sampling temperature (default: 0.7)'),
        max_tokens: z.number().optional().describe('Maximum tokens to generate (default: 500)'),
        api_key: z.string().optional().describe('API key override'),
      }),
    },
    async (input) => {
      try {
        const params: Record<string, unknown> = {
          model: input.model ?? config.chatModel,
          messages: input.messages,
          temperature: input.temperature ?? 0.7,
          max_tokens: input.max_tokens ?? 500,
          api_key: input.api_key ?? config.apiKey,
        };

        const result = await invokeWithRetry(
          abilities,
          'chat-completion',
          params,
        );

        return {
          success: true,
          result,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[graph-chat] ${message}`,
          tool: 'graph-chat',
        };
      }
    },
  );
}

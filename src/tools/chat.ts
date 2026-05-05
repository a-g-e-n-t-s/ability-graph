/**
 * graph-chat tool — chat completion via model-manager HTTP API or broker.
 *
 * When chatTransport='api' (default): calls model-manager directly via HTTP
 * (OpenAI-compatible /v1/chat/completions endpoint).
 * When chatTransport='broker': falls back to invokeRemote('chat-completion').
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
        const apiKey = input.api_key ?? config.apiKey;
        const model = input.model ?? config.chatModel;
        const temperature = input.temperature ?? 0.7;
        const maxTokens = input.max_tokens ?? 500;

        // Direct HTTP call to model-manager (OpenAI-compatible)
        if (config.chatTransport === 'api' && config.apiUrl && apiKey) {
          const result = await callModelManagerHTTP(
            config.apiUrl, apiKey, model, input.messages, temperature, maxTokens,
          );
          return { success: true, result };
        }

        // Fallback: broker-based chat-completion tool
        const params: Record<string, unknown> = {
          model,
          messages: input.messages,
          temperature,
          max_tokens: maxTokens,
          api_key: apiKey,
        };

        const result = await invokeWithRetry(abilities, 'chat-completion', params);
        return { success: true, result };
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

// ── Direct HTTP call to model-manager ─────────────────────────────────

async function callModelManagerHTTP(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; model: string; usage?: Record<string, number> }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Model manager HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string | null } }>;
    model: string;
    usage?: Record<string, number>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (content === null || content === undefined) {
    throw new Error('Model manager returned no content');
  }

  return { content, model: data.model, usage: data.usage };
}

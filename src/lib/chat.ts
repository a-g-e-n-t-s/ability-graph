/**
 * Chat completion pipeline — routes through either:
 *   - **api**: direct HTTP POST to an OpenAI-compatible `/v1/chat/completions` endpoint
 *   - **broker**: `invokeWithRetry('chat-completion', ...)` over KADI protocol
 *
 * All broker-mode calls go through {@link invokeWithRetry} for automatic
 * retry with exponential backoff.
 */

import { invokeWithRetry } from './retry.js';
import type { SignalAbilities } from './types.js';
import type { Transport } from './config.js';

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completion response types
// ---------------------------------------------------------------------------

/** A single chat completion choice. */
export interface ChatChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

/** Full response from chat-completion. */
export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost?: number;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for how to reach the chat completion service. */
export interface ChatConfig {
  transport: Transport;
  apiUrl?: string;
  apiKey?: string;
}

/** Parameters for a chat completion request. */
export interface ChatCompletionParams {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: string };
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request via the configured transport.
 * Broker-mode calls use invokeWithRetry for automatic retry.
 */
export async function chatCompletion(
  abilities: SignalAbilities,
  params: ChatCompletionParams,
  chat: ChatConfig,
): Promise<ChatCompletionResponse> {
  return chat.transport === 'api'
    ? requestChatHttp(params, chat)
    : requestChatBroker(abilities, params, chat.apiKey);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request via invokeWithRetry (broker mode).
 */
async function requestChatBroker(
  abilities: SignalAbilities,
  params: ChatCompletionParams,
  apiKey: string | undefined,
): Promise<ChatCompletionResponse> {
  const brokerParams: Record<string, unknown> = { ...params };
  if (apiKey) brokerParams.api_key = apiKey;

  try {
    return await invokeWithRetry<ChatCompletionResponse>(
      abilities,
      'chat-completion',
      brokerParams,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Chat completion failed via broker (model: ${params.model}): ${message}`,
    );
  }
}

/**
 * Send a chat completion request via direct HTTP.
 */
async function requestChatHttp(
  params: ChatCompletionParams,
  config: ChatConfig,
): Promise<ChatCompletionResponse> {
  if (!config.apiUrl) {
    throw new Error(
      `Chat transport is "api" but no api_url is configured. ` +
      `Set MEMORY_API_URL env var or add the key to the "models" vault.`,
    );
  }

  const baseUrl = config.apiUrl.replace(/\/+$/, '');
  const url = baseUrl.includes('/v1/chat/completions')
    ? baseUrl
    : `${baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  let httpResponse: Response;
  try {
    httpResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Chat completion HTTP request failed (model: ${params.model}, url: ${url}): ${message}`,
    );
  }

  if (!httpResponse.ok) {
    let body: string;
    try {
      body = await httpResponse.text();
    } catch {
      body = '(could not read response body)';
    }
    throw new Error(
      `Chat completion HTTP ${httpResponse.status} from ${url} ` +
      `(model: ${params.model}): ${body.slice(0, 500)}`,
    );
  }

  let response: ChatCompletionResponse;
  try {
    response = (await httpResponse.json()) as ChatCompletionResponse;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Chat completion response is not valid JSON (model: ${params.model}, url: ${url}): ${message}`,
    );
  }

  if (!response || !Array.isArray(response.choices)) {
    throw new Error(
      `Malformed chat completion response (model: ${params.model}): ` +
      `expected { choices: [...] }, got ${summarizeValue(response)}`,
    );
  }

  return response;
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  try {
    const json = JSON.stringify(value);
    if (json.length <= 200) return json;
    return json.slice(0, 200) + '...';
  } catch {
    return typeof value;
  }
}

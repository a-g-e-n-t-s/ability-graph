/**
 * Retry infrastructure for graph-ability.
 *
 * Provides configurable exponential backoff with jitter for all remote tool
 * invocations. Each operation type has a default policy, and callers can
 * override per-invocation.
 *
 * Drop-in replacement for raw `abilities.invoke()` / `client.invokeRemote()`
 * that adds resilience to transient failures.
 */

import type { RetryPolicy, SignalAbilities } from './types.js';

// Re-export for convenience
export type { RetryPolicy };

// ---------------------------------------------------------------------------
// Default Retry Policies
// ---------------------------------------------------------------------------

/**
 * Default retry policies for known operation types.
 *
 * Each key corresponds to a tool name that may be invoked remotely.
 * These can be overridden per-call via the `policy` parameter.
 */
export const DEFAULT_RETRY_POLICIES: Record<string, RetryPolicy> = {
  'arcade-command': {
    maxRetries: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 10_000,
    jitter: true,
  },
  'arcade-query': {
    maxRetries: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 10_000,
    jitter: true,
  },
  'create-embedding': {
    maxRetries: 3,
    initialDelayMs: 2000,
    backoffMultiplier: 2,
    maxDelayMs: 15_000,
    jitter: true,
    isRetryable: (err: Error) => {
      const msg = err.message.toLowerCase();
      return (
        msg.includes('timeout') ||
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('network') ||
        msg.includes('econnreset')
      );
    },
  },
  'chat-completion': {
    maxRetries: 2,
    initialDelayMs: 2000,
    backoffMultiplier: 2,
    maxDelayMs: 10_000,
    jitter: true,
  },
};

// ---------------------------------------------------------------------------
// Retryable Error Detection
// ---------------------------------------------------------------------------

/**
 * Default predicate to determine if an error is retryable.
 * Used when no custom `isRetryable` function is provided in the policy.
 *
 * Retryable: timeouts, rate limits (429), server errors (503, 502),
 * network errors (ECONNRESET, ECONNREFUSED, etc.)
 *
 * NOT retryable: 400, 401, 403, schema/DDL errors
 */
export function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('epipe') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  );
}

// ---------------------------------------------------------------------------
// Core Retry Function
// ---------------------------------------------------------------------------

/**
 * Invoke a remote tool with configurable retry and exponential backoff.
 *
 * @param abilities - The abilities interface for invoking tools.
 * @param tool      - Tool name (also used for default policy lookup).
 * @param params    - Parameters to pass to the tool.
 * @param policy    - Optional policy overrides (merged with defaults).
 * @returns The result from the tool invocation.
 * @throws The last error if all retries are exhausted or error is non-retryable.
 */
export async function invokeWithRetry<T = unknown>(
  abilities: SignalAbilities,
  tool: string,
  params: Record<string, unknown>,
  policy?: Partial<RetryPolicy>,
): Promise<T> {
  const defaultPolicy = DEFAULT_RETRY_POLICIES[tool];
  const resolved: RetryPolicy = {
    maxRetries: policy?.maxRetries ?? defaultPolicy?.maxRetries ?? 0,
    initialDelayMs: policy?.initialDelayMs ?? defaultPolicy?.initialDelayMs ?? 1000,
    backoffMultiplier: policy?.backoffMultiplier ?? defaultPolicy?.backoffMultiplier ?? 2,
    maxDelayMs: policy?.maxDelayMs ?? defaultPolicy?.maxDelayMs ?? 10_000,
    jitter: policy?.jitter ?? defaultPolicy?.jitter ?? true,
    isRetryable: policy?.isRetryable ?? defaultPolicy?.isRetryable ?? isRetryableError,
    onRetry: policy?.onRetry ?? defaultPolicy?.onRetry,
  };

  let lastError: Error;

  for (let attempt = 0; attempt <= resolved.maxRetries; attempt++) {
    try {
      return await abilities.invoke<T>(tool, params);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // No more retries left
      if (attempt === resolved.maxRetries) break;

      // Check if the error is retryable
      if (resolved.isRetryable && !resolved.isRetryable(lastError)) break;

      // Calculate delay with exponential backoff + optional jitter
      let delay = resolved.initialDelayMs * Math.pow(resolved.backoffMultiplier, attempt);
      delay = Math.min(delay, resolved.maxDelayMs);

      if (resolved.jitter) {
        const jitterFactor = 0.2;
        delay += delay * jitterFactor * (Math.random() * 2 - 1);
      }

      // Ensure delay is non-negative
      delay = Math.max(0, delay);

      resolved.onRetry?.(attempt + 1, lastError, delay);
      console.warn(
        `[graph-ability] ${tool} attempt ${attempt + 1} failed: ${lastError.message} — retrying in ${Math.round(delay)}ms`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

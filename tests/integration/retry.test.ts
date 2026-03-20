/**
 * Integration test: Retry infrastructure
 *
 * Tests:
 * - invokeWithRetry succeeds on first try with live DB
 * - invokeWithRetry retries on transient errors then succeeds
 * - invokeWithRetry gives up on non-retryable errors immediately
 * - Custom retry policy overrides defaults
 * - onRetry callback fires on each retry attempt
 *
 * Tests 2-3 use a mock abilities wrapper to simulate controlled failures.
 * Test 1 uses live infrastructure to verify the happy path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  invokeWithRetry,
  isRetryableError,
  DEFAULT_RETRY_POLICIES,
} from '../../src/lib/retry.js';
import type { RetryPolicy, SignalAbilities, ArcadeQueryResult } from '../../src/lib/types.js';
import {
  createTestContext,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext('retry-test');
  console.log('[retry] Connected');
}, 60_000);

afterAll(async () => {
  await ctx.client.disconnect();
}, 15_000);

// ---------------------------------------------------------------------------
// Mock abilities that fail N times before succeeding
// ---------------------------------------------------------------------------

function createFailingAbilities(
  real: SignalAbilities,
  failCount: number,
  errorMessage: string = 'Simulated timeout error',
): { abilities: SignalAbilities; attempts: number[] } {
  let callCount = 0;
  const attempts: number[] = [];

  const abilities: SignalAbilities = {
    invoke: async <T>(tool: string, params: Record<string, unknown>): Promise<T> => {
      callCount++;
      attempts.push(callCount);

      if (callCount <= failCount) {
        throw new Error(errorMessage);
      }

      // Delegate to real abilities after failures exhausted
      return real.invoke<T>(tool, params);
    },
  };

  return { abilities, attempts };
}

// Non-retryable abilities — always throws a non-retryable error
function createNonRetryableAbilities(): SignalAbilities {
  return {
    invoke: async <T>(): Promise<T> => {
      throw new Error('401 Unauthorized — invalid API key');
    },
  };
}

describe('graph-ability retry integration', () => {

  // ── Happy path: succeed on first try ──────────────────────────────── 

  it('invokeWithRetry succeeds on first attempt with live DB', async () => {
    const result = await invokeWithRetry<ArcadeQueryResult>(
      ctx.abilities,
      'arcade-query',
      {
        database: ctx.database,
        query: 'SELECT 1 as test',
      },
    );

    expect(result.success).toBe(true);
  }, 30_000);

  // ── Retry on transient errors ─────────────────────────────────────── 

  it('retries on transient errors and succeeds after Nth attempt', async () => {
    const { abilities: failingAbilities, attempts } = createFailingAbilities(
      ctx.abilities,
      2, // Fail first 2 attempts
      'Simulated timeout error',
    );

    const result = await invokeWithRetry<ArcadeQueryResult>(
      failingAbilities,
      'arcade-query',
      {
        database: ctx.database,
        query: 'SELECT 1 as test',
      },
      {
        maxRetries: 3,
        initialDelayMs: 100, // Fast for testing
        backoffMultiplier: 1.5,
        maxDelayMs: 500,
        jitter: false,
      },
    );

    expect(result.success).toBe(true);
    expect(attempts.length).toBe(3); // Failed 2x + succeeded 1x
    console.log(`[retry] Retried ${attempts.length - 1} times before success`);
  }, 30_000);

  // ── Non-retryable error ───────────────────────────────────────────── 

  it('gives up immediately on non-retryable errors', async () => {
    const nonRetryable = createNonRetryableAbilities();

    const startTime = Date.now();
    let thrown: Error | undefined;

    try {
      await invokeWithRetry<ArcadeQueryResult>(
        nonRetryable,
        'arcade-query',
        {
          database: ctx.database,
          query: 'SELECT 1 as test',
        },
        {
          maxRetries: 5,
          initialDelayMs: 1000,
        },
      );
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }

    const elapsed = Date.now() - startTime;

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('401');
    // Should not retry — elapsed time should be well under the 1s initial delay
    expect(elapsed).toBeLessThan(2000);
    console.log(`[retry] Non-retryable error failed in ${elapsed}ms with no retries`);
  }, 15_000);

  // ── Custom policy override ────────────────────────────────────────── 

  it('respects custom retry policy overrides', async () => {
    const { abilities: failingAbilities, attempts } = createFailingAbilities(
      ctx.abilities,
      1, // Fail first attempt only
      'fetch failed: ECONNREFUSED',
    );

    const result = await invokeWithRetry<ArcadeQueryResult>(
      failingAbilities,
      'arcade-query',
      {
        database: ctx.database,
        query: 'SELECT 1 as test',
      },
      {
        maxRetries: 1,
        initialDelayMs: 50,
        jitter: false,
      },
    );

    expect(result.success).toBe(true);
    expect(attempts.length).toBe(2); // Failed 1x + succeeded 1x
  }, 15_000);

  // ── onRetry callback ──────────────────────────────────────────────── 

  it('fires onRetry callback with attempt, error, and delay', async () => {
    const retryLogs: Array<{ attempt: number; error: string; delay: number }> = [];

    const { abilities: failingAbilities } = createFailingAbilities(
      ctx.abilities,
      2,
      'socket hang up',
    );

    await invokeWithRetry<ArcadeQueryResult>(
      failingAbilities,
      'arcade-query',
      {
        database: ctx.database,
        query: 'SELECT 1 as test',
      },
      {
        maxRetries: 3,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        jitter: false,
        onRetry: (attempt, error, delay) => {
          retryLogs.push({
            attempt,
            error: error.message,
            delay: Math.round(delay),
          });
        },
      },
    );

    expect(retryLogs.length).toBe(2); // Two retries before success
    expect(retryLogs[0].attempt).toBe(1);
    expect(retryLogs[0].error).toContain('socket hang up');
    expect(retryLogs[0].delay).toBe(50); // initialDelayMs * 2^0

    expect(retryLogs[1].attempt).toBe(2);
    expect(retryLogs[1].delay).toBe(100); // 50 * 2^1

    console.log(`[retry] onRetry logs:`, retryLogs);
  }, 15_000);

  // ── Exhausted retries ─────────────────────────────────────────────── 

  it('throws after exhausting all retries', async () => {
    const { abilities: failingAbilities, attempts } = createFailingAbilities(
      ctx.abilities,
      10, // Will always fail
      'Simulated timeout error',
    );

    let thrown: Error | undefined;

    try {
      await invokeWithRetry<ArcadeQueryResult>(
        failingAbilities,
        'arcade-query',
        {
          database: ctx.database,
          query: 'SELECT 1 as test',
        },
        {
          maxRetries: 2,
          initialDelayMs: 50,
          jitter: false,
        },
      );
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('timeout');
    expect(attempts.length).toBe(3); // 1 initial + 2 retries
    console.log(`[retry] Exhausted retries after ${attempts.length} attempts`);
  }, 15_000);

  // ── isRetryableError utility ──────────────────────────────────────── 

  it('isRetryableError correctly classifies errors', () => {
    // Retryable
    expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);

    // NOT retryable
    expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
    expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
    expect(isRetryableError(new Error('Type not found'))).toBe(false);
    expect(isRetryableError(new Error('Syntax error in SQL'))).toBe(false);
  });

  // ── Default policies exist ────────────────────────────────────────── 

  it('has default policies for all known tool types', () => {
    expect(DEFAULT_RETRY_POLICIES['arcade-command']).toBeDefined();
    expect(DEFAULT_RETRY_POLICIES['arcade-query']).toBeDefined();
    expect(DEFAULT_RETRY_POLICIES['create-embedding']).toBeDefined();
    expect(DEFAULT_RETRY_POLICIES['chat-completion']).toBeDefined();

    // Verify reasonable defaults
    for (const [tool, policy] of Object.entries(DEFAULT_RETRY_POLICIES)) {
      expect(policy.maxRetries).toBeGreaterThan(0);
      expect(policy.initialDelayMs).toBeGreaterThan(0);
      expect(policy.backoffMultiplier).toBeGreaterThanOrEqual(1);
      console.log(`[retry] ${tool}: ${policy.maxRetries} retries, ${policy.initialDelayMs}ms initial`);
    }
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  invokeWithRetry,
  DEFAULT_RETRY_POLICIES,
  isRetryableError,
} from '../../src/lib/retry.js';
import type { SignalAbilities } from '../../src/lib/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAbilities(
  invokeFn: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): SignalAbilities {
  return { invoke: invokeFn as any };
}

// Suppress console.warn during tests
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DEFAULT_RETRY_POLICIES', () => {
  it('has policies for arcade-command', () => {
    const policy = DEFAULT_RETRY_POLICIES['arcade-command'];
    expect(policy).toBeDefined();
    expect(policy.maxRetries).toBe(3);
    expect(policy.initialDelayMs).toBe(1000);
    expect(policy.maxDelayMs).toBe(10_000);
  });

  it('has policies for arcade-query', () => {
    const policy = DEFAULT_RETRY_POLICIES['arcade-query'];
    expect(policy).toBeDefined();
    expect(policy.maxRetries).toBe(3);
    expect(policy.initialDelayMs).toBe(1000);
    expect(policy.maxDelayMs).toBe(10_000);
  });

  it('has policies for create-embedding', () => {
    const policy = DEFAULT_RETRY_POLICIES['create-embedding'];
    expect(policy).toBeDefined();
    expect(policy.maxRetries).toBe(3);
    expect(policy.initialDelayMs).toBe(2000);
    expect(policy.maxDelayMs).toBe(15_000);
  });

  it('has policies for chat-completion', () => {
    const policy = DEFAULT_RETRY_POLICIES['chat-completion'];
    expect(policy).toBeDefined();
    expect(policy.maxRetries).toBe(2);
    expect(policy.initialDelayMs).toBe(2000);
    expect(policy.maxDelayMs).toBe(10_000);
  });
});

describe('isRetryableError', () => {
  it('returns true for timeout errors', () => {
    expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
  });

  it('returns true for 429 rate limit errors', () => {
    expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('returns true for 503 errors', () => {
    expect(isRetryableError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isRetryableError(new Error('network error'))).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns false for 400 bad request', () => {
    expect(isRetryableError(new Error('HTTP 400 Bad Request'))).toBe(false);
  });

  it('returns false for 401 unauthorized', () => {
    expect(isRetryableError(new Error('HTTP 401 Unauthorized'))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isRetryableError(new Error('something went wrong'))).toBe(false);
  });
});

describe('invokeWithRetry', () => {
  it('succeeds on first try', async () => {
    const abilities = createMockAbilities(async () => ({ data: 'ok' }));

    const result = await invokeWithRetry(abilities, 'arcade-query', { query: 'test' });
    expect(result).toEqual({ data: 'ok' });
  });

  it('succeeds on 3rd try after retryable failures', async () => {
    let callCount = 0;
    const abilities = createMockAbilities(async () => {
      callCount++;
      if (callCount < 3) throw new Error('timeout error');
      return { data: 'success' };
    });

    const result = await invokeWithRetry(
      abilities,
      'arcade-query',
      { query: 'test' },
      { initialDelayMs: 1, maxDelayMs: 5, jitter: false },
    );

    expect(result).toEqual({ data: 'success' });
    expect(callCount).toBe(3);
  });

  it('fails immediately on non-retryable error', async () => {
    let callCount = 0;
    const abilities = createMockAbilities(async () => {
      callCount++;
      throw new Error('HTTP 400 Bad Request');
    });

    await expect(
      invokeWithRetry(
        abilities,
        'arcade-query',
        { query: 'test' },
        { initialDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow('HTTP 400 Bad Request');

    // Should only be called once — no retries for non-retryable errors
    expect(callCount).toBe(1);
  });

  it('exhausts max retries and throws last error', async () => {
    let callCount = 0;
    const abilities = createMockAbilities(async () => {
      callCount++;
      throw new Error('timeout error');
    });

    await expect(
      invokeWithRetry(
        abilities,
        'arcade-query',
        { query: 'test' },
        { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5, jitter: false },
      ),
    ).rejects.toThrow('timeout error');

    // 1 initial + 2 retries = 3 total calls
    expect(callCount).toBe(3);
  });

  it('respects backoff timing', async () => {
    const delays: number[] = [];
    let callCount = 0;
    let lastCallTime = Date.now();

    const abilities = createMockAbilities(async () => {
      const now = Date.now();
      if (callCount > 0) {
        delays.push(now - lastCallTime);
      }
      lastCallTime = now;
      callCount++;
      if (callCount < 3) throw new Error('timeout error');
      return { ok: true };
    });

    await invokeWithRetry(
      abilities,
      'unknown-tool', // no default policy
      { query: 'test' },
      {
        maxRetries: 3,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        maxDelayMs: 500,
        jitter: false,
      },
    );

    expect(callCount).toBe(3);
    // First retry delay should be ~50ms (within tolerance)
    expect(delays[0]).toBeGreaterThanOrEqual(40);
    // Second retry delay should be ~100ms (50 * 2^1)
    expect(delays[1]).toBeGreaterThanOrEqual(80);
  });

  it('applies jitter within ±20% bounds', async () => {
    const delays: number[] = [];

    for (let trial = 0; trial < 20; trial++) {
      let callCount = 0;
      const abilities = createMockAbilities(async () => {
        callCount++;
        if (callCount < 2) throw new Error('timeout error');
        return { ok: true };
      });

      const startTime = Date.now();
      await invokeWithRetry(
        abilities,
        'unknown-tool',
        {},
        {
          maxRetries: 1,
          initialDelayMs: 100,
          backoffMultiplier: 2,
          maxDelayMs: 1000,
          jitter: true,
        },
      );
      delays.push(Date.now() - startTime);
    }

    // With jitter ±20% of 100ms, delays should be in [80, 120] range
    // (plus some execution overhead). Be lenient.
    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);
    expect(minDelay).toBeGreaterThanOrEqual(60); // 80 - tolerance
    expect(maxDelay).toBeLessThan(200); // 120 + tolerance
  });

  it('allows custom policy override', async () => {
    let callCount = 0;
    const onRetryCalls: Array<{ attempt: number; delay: number }> = [];

    const abilities = createMockAbilities(async () => {
      callCount++;
      if (callCount < 3) throw new Error('timeout error');
      return { data: 'ok' };
    });

    const result = await invokeWithRetry(
      abilities,
      'arcade-query',
      {},
      {
        maxRetries: 5,
        initialDelayMs: 1,
        maxDelayMs: 10,
        jitter: false,
        onRetry: (attempt, _error, delay) => {
          onRetryCalls.push({ attempt, delay });
        },
      },
    );

    expect(result).toEqual({ data: 'ok' });
    expect(callCount).toBe(3);
    expect(onRetryCalls.length).toBe(2);
    expect(onRetryCalls[0].attempt).toBe(1);
    expect(onRetryCalls[1].attempt).toBe(2);
  });

  it('uses default policy lookup for known tools', async () => {
    let callCount = 0;
    const abilities = createMockAbilities(async () => {
      callCount++;
      if (callCount < 2) throw new Error('timeout error');
      return { ok: true };
    });

    const result = await invokeWithRetry(
      abilities,
      'arcade-command', // has default policy with maxRetries: 3
      {},
      { initialDelayMs: 1, maxDelayMs: 5, jitter: false },
    );

    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it('handles zero maxRetries (no retry)', async () => {
    let callCount = 0;
    const abilities = createMockAbilities(async () => {
      callCount++;
      throw new Error('timeout error');
    });

    await expect(
      invokeWithRetry(
        abilities,
        'unknown-tool',
        {},
        { maxRetries: 0 },
      ),
    ).rejects.toThrow('timeout error');

    expect(callCount).toBe(1);
  });
});

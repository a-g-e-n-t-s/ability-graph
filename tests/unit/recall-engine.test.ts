/**
 * Unit tests for the recall engine — signal orchestration, importance weighting,
 * and individual signal behavior (mocked DB calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hybridRecall,
  registerSignal,
  clearSignals,
  getSignal,
  listSignals,
} from '../../src/lib/signals/index.js';
import type { SignalImplementation } from '../../src/lib/signals/index.js';
import type { RecallRequest, SignalAbilities, SignalResult, SignalContext } from '../../src/lib/types.js';
import type { GraphConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockConfig: GraphConfig = {
  database: 'test_db',
  embeddingModel: 'test-model',
  extractionModel: 'test-extraction',
  chatModel: 'test-chat',
  defaultAgent: 'test-agent',
  embeddingTransport: 'broker',
  chatTransport: 'broker',
};

const mockAbilities: SignalAbilities = {
  invoke: vi.fn().mockResolvedValue({}),
};

function makeResult(id: string, score: number, importance: number = 0.5, signal: string = 'test'): SignalResult {
  return {
    rid: id,
    id,
    content: `Content for ${id}`,
    score,
    importance,
    matchedVia: [signal],
    properties: { content: `Content for ${id}` },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Signal Registry', () => {
  // Store original signals to restore after tests
  let originalSignals: string[];

  beforeEach(() => {
    originalSignals = listSignals();
  });

  afterEach(() => {
    // Re-register the built-in signals by re-importing
    // For now, just verify the registry works
  });

  it('should list built-in signals', () => {
    const signals = listSignals();
    expect(signals).toContain('semantic');
    expect(signals).toContain('keyword');
    expect(signals).toContain('graph');
    expect(signals).toContain('structural');
  });

  it('should get a registered signal', () => {
    const semantic = getSignal('semantic');
    expect(semantic).toBeDefined();
    expect(semantic!.name).toBe('semantic');
    expect(semantic!.requiresPriorResults).toBeFalsy();
  });

  it('should register custom signals', () => {
    const customSignal: SignalImplementation = {
      name: 'custom-test',
      execute: async () => [],
    };

    registerSignal(customSignal);
    expect(getSignal('custom-test')).toBeDefined();
    expect(listSignals()).toContain('custom-test');
  });

  it('should identify structural as dependent (requiresPriorResults)', () => {
    const structural = getSignal('structural');
    expect(structural).toBeDefined();
    expect(structural!.requiresPriorResults).toBe(true);
  });

  it('should identify semantic, keyword, graph as independent', () => {
    expect(getSignal('semantic')!.requiresPriorResults).toBeFalsy();
    expect(getSignal('keyword')!.requiresPriorResults).toBeFalsy();
    expect(getSignal('graph')!.requiresPriorResults).toBeFalsy();
  });
});

describe('Hybrid Recall Orchestration', () => {
  let executionOrder: string[];

  beforeEach(() => {
    executionOrder = [];
  });

  afterEach(() => {
    // Re-register built-ins to clean up test signals
    // They are auto-registered at module load time
  });

  it('should run independent signals in parallel, then dependent sequentially', async () => {
    // Register mock signals that track execution order
    const mockIndependent1: SignalImplementation = {
      name: 'mock-independent-1',
      requiresPriorResults: false,
      execute: async () => {
        executionOrder.push('independent-1');
        return [makeResult('#1:0', 0.9, 0.8, 'mock-independent-1')];
      },
    };

    const mockIndependent2: SignalImplementation = {
      name: 'mock-independent-2',
      requiresPriorResults: false,
      execute: async () => {
        executionOrder.push('independent-2');
        return [makeResult('#1:1', 0.8, 0.7, 'mock-independent-2')];
      },
    };

    const mockDependent: SignalImplementation = {
      name: 'mock-dependent',
      requiresPriorResults: true,
      execute: async (ctx: SignalContext) => {
        executionOrder.push('dependent');
        // Should receive prior results
        expect(ctx.priorResults).toBeDefined();
        expect(ctx.priorResults!.length).toBeGreaterThan(0);
        return [makeResult('#1:2', 0.7, 0.6, 'mock-dependent')];
      },
    };

    registerSignal(mockIndependent1);
    registerSignal(mockIndependent2);
    registerSignal(mockDependent);

    const request: RecallRequest = {
      query: 'test query',
      vertexType: 'TestVertex',
    };

    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['mock-independent-1', 'mock-independent-2', 'mock-dependent'],
    );

    // Verify dependent ran after independents
    const depIndex = executionOrder.indexOf('dependent');
    const ind1Index = executionOrder.indexOf('independent-1');
    const ind2Index = executionOrder.indexOf('independent-2');

    expect(depIndex).toBeGreaterThan(ind1Index);
    expect(depIndex).toBeGreaterThan(ind2Index);
    expect(results.length).toBeGreaterThan(0);
  });

  it('should use default signals: semantic, keyword, graph', async () => {
    // Create mock signals to track which are called
    const calledSignals: string[] = [];

    const mockSemantic: SignalImplementation = {
      name: 'semantic',
      execute: async () => {
        calledSignals.push('semantic');
        return [makeResult('#1:0', 0.9, 0.8, 'semantic')];
      },
    };

    const mockKeyword: SignalImplementation = {
      name: 'keyword',
      execute: async () => {
        calledSignals.push('keyword');
        return [makeResult('#1:1', 0.8, 0.7, 'keyword')];
      },
    };

    const mockGraph: SignalImplementation = {
      name: 'graph',
      execute: async () => {
        calledSignals.push('graph');
        return [makeResult('#1:2', 0.7, 0.6, 'graph')];
      },
    };

    const mockStructural: SignalImplementation = {
      name: 'structural',
      requiresPriorResults: true,
      execute: async () => {
        calledSignals.push('structural');
        return [];
      },
    };

    registerSignal(mockSemantic);
    registerSignal(mockKeyword);
    registerSignal(mockGraph);
    registerSignal(mockStructural);

    const request: RecallRequest = {
      query: 'test query',
      vertexType: 'TestVertex',
    };

    // Call without specifying signals — should use defaults
    await hybridRecall(request, mockAbilities, mockConfig);

    expect(calledSignals).toContain('semantic');
    expect(calledSignals).toContain('keyword');
    expect(calledSignals).toContain('graph');
    // Structural should NOT be called by default
    expect(calledSignals).not.toContain('structural');
  });

  it('should include structural only if explicitly requested', async () => {
    const calledSignals: string[] = [];

    const mockSemantic: SignalImplementation = {
      name: 'semantic',
      execute: async () => {
        calledSignals.push('semantic');
        return [makeResult('#1:0', 0.9, 0.8, 'semantic')];
      },
    };

    const mockStructural: SignalImplementation = {
      name: 'structural',
      requiresPriorResults: true,
      execute: async () => {
        calledSignals.push('structural');
        return [makeResult('#1:3', 0.45, 0.5, 'structural')];
      },
    };

    registerSignal(mockSemantic);
    registerSignal(mockStructural);

    const request: RecallRequest = {
      query: 'test query',
      vertexType: 'TestVertex',
      structuralEdges: ['NextSection'],
    };

    await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['semantic', 'structural'],
    );

    expect(calledSignals).toContain('semantic');
    expect(calledSignals).toContain('structural');
  });

  it('should apply importance weighting: score × (0.7 + 0.3 × importance)', async () => {
    const mockSignal: SignalImplementation = {
      name: 'mock-weight-test',
      execute: async () => [
        makeResult('#1:0', 0.9, 1.0, 'mock-weight-test'),  // high importance
        makeResult('#1:1', 0.9, 0.0, 'mock-weight-test'),  // low importance
        makeResult('#1:2', 0.9, 0.5, 'mock-weight-test'),  // mid importance
      ],
    };

    registerSignal(mockSignal);

    const request: RecallRequest = {
      query: 'test',
      vertexType: 'TestVertex',
      limit: 10,
    };

    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['mock-weight-test'],
    );

    // All had same base score but different importance
    // importance=1.0: score × (0.7 + 0.3 × 1.0) = score × 1.0
    // importance=0.0: score × (0.7 + 0.3 × 0.0) = score × 0.7
    // importance=0.5: score × (0.7 + 0.3 × 0.5) = score × 0.85

    const highImp = results.find((r) => r.rid === '#1:0');
    const lowImp = results.find((r) => r.rid === '#1:1');
    const midImp = results.find((r) => r.rid === '#1:2');

    expect(highImp).toBeDefined();
    expect(lowImp).toBeDefined();
    expect(midImp).toBeDefined();

    // High importance should have highest final score
    expect(highImp!.score).toBeGreaterThan(midImp!.score);
    expect(midImp!.score).toBeGreaterThan(lowImp!.score);
  });

  it('should handle empty results gracefully', async () => {
    const mockEmpty: SignalImplementation = {
      name: 'mock-empty',
      execute: async () => [],
    };

    registerSignal(mockEmpty);

    const request: RecallRequest = {
      query: 'nonexistent',
      vertexType: 'TestVertex',
    };

    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['mock-empty'],
    );

    expect(results).toEqual([]);
  });

  it('should handle signal failures gracefully', async () => {
    const mockFailing: SignalImplementation = {
      name: 'mock-failing',
      execute: async () => { throw new Error('Signal crashed'); },
    };

    const mockWorking: SignalImplementation = {
      name: 'mock-working',
      execute: async () => [makeResult('#1:0', 0.9, 0.8, 'mock-working')],
    };

    registerSignal(mockFailing);
    registerSignal(mockWorking);

    const request: RecallRequest = {
      query: 'test',
      vertexType: 'TestVertex',
    };

    // Should not throw, should return results from the working signal
    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['mock-failing', 'mock-working'],
    );

    expect(results.length).toBeGreaterThan(0);
  });

  it('should skip unknown signals', async () => {
    const request: RecallRequest = {
      query: 'test',
      vertexType: 'TestVertex',
    };

    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['nonexistent-signal'],
    );

    expect(results).toEqual([]);
  });

  it('should respect limit parameter', async () => {
    const mockMany: SignalImplementation = {
      name: 'mock-many',
      execute: async () =>
        Array.from({ length: 20 }, (_, i) =>
          makeResult(`#1:${i}`, 0.9 - i * 0.01, 0.5, 'mock-many'),
        ),
    };

    registerSignal(mockMany);

    const request: RecallRequest = {
      query: 'test',
      vertexType: 'TestVertex',
      limit: 5,
    };

    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['mock-many'],
    );

    expect(results.length).toBe(5);
  });

  it('should sort results by weighted score descending', async () => {
    const mockResults: SignalImplementation = {
      name: 'mock-sorted',
      execute: async () => [
        makeResult('#1:0', 0.5, 0.5, 'mock-sorted'),
        makeResult('#1:1', 0.9, 0.9, 'mock-sorted'),
        makeResult('#1:2', 0.7, 0.3, 'mock-sorted'),
      ],
    };

    registerSignal(mockResults);

    const request: RecallRequest = {
      query: 'test',
      vertexType: 'TestVertex',
    };

    const results = await hybridRecall(
      request,
      mockAbilities,
      mockConfig,
      ['mock-sorted'],
    );

    // Verify descending order of scores
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

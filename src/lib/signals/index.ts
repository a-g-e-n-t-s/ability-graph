/**
 * Signal registry and hybrid recall orchestrator.
 *
 * The signal system supports arbitrary signal implementations via the
 * {@link SignalImplementation} interface. Four built-in signals are registered
 * by default (semantic, keyword, graph, structural), but consumers can
 * register custom signals.
 *
 * Hybrid orchestration:
 * 1. Partition signals into independent and dependent (requiresPriorResults).
 * 2. Run independent signals in parallel.
 * 3. Fuse with RRF(k=60).
 * 4. Run dependent signals sequentially, feeding prior results.
 * 5. Re-fuse all rankings.
 * 6. Apply importance weighting: score × (0.7 + 0.3 × importance).
 * 7. Sort and limit.
 */

import { reciprocalRankFusion } from '../rrf.js';
import type { RecallRequest, SignalAbilities, SignalContext, SignalResult } from '../types.js';
import type { GraphConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Signal interface
// ---------------------------------------------------------------------------

/** A named, pluggable signal that can participate in hybrid recall. */
export interface SignalImplementation {
  /** Unique signal name (e.g., 'semantic', 'keyword', 'graph', 'structural'). */
  name: string;
  /** Whether this signal needs results from earlier signals. */
  requiresPriorResults?: boolean;
  /** Execute the signal and return ranked results. */
  execute(ctx: SignalContext): Promise<SignalResult[]>;
}

// ---------------------------------------------------------------------------
// Signal registry
// ---------------------------------------------------------------------------

/** Global registry of available signal implementations. */
const signalRegistry = new Map<string, SignalImplementation>();

/**
 * Register a signal implementation. Overwrites any existing signal with the same name.
 */
export function registerSignal(signal: SignalImplementation): void {
  signalRegistry.set(signal.name, signal);
}

/**
 * Get a registered signal by name, or undefined.
 */
export function getSignal(name: string): SignalImplementation | undefined {
  return signalRegistry.get(name);
}

/**
 * List all registered signal names.
 */
export function listSignals(): string[] {
  return Array.from(signalRegistry.keys());
}

/**
 * Clear all registered signals (for testing).
 */
export function clearSignals(): void {
  signalRegistry.clear();
}

// ---------------------------------------------------------------------------
// Register built-in signals
// ---------------------------------------------------------------------------

import { semanticSignal } from './semantic.js';
import { keywordSignal } from './keyword.js';
import { graphSignal } from './graph.js';
import { structuralSignal } from './structural.js';

registerSignal(semanticSignal);
registerSignal(keywordSignal);
registerSignal(graphSignal);
registerSignal(structuralSignal);

// ---------------------------------------------------------------------------
// Hybrid recall orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute hybrid recall using the specified signals (or defaults).
 *
 * @param request    - The recall request with query, vertexType, filters, etc.
 * @param abilities  - The abilities interface for invoking remote tools.
 * @param config     - Graph configuration (database, models, etc.).
 * @param signals    - Signal names to use (default: ['semantic', 'keyword', 'graph']).
 * @returns Fused and importance-weighted results.
 */
export async function hybridRecall(
  request: RecallRequest,
  abilities: SignalAbilities,
  config: GraphConfig,
  signals?: string[],
): Promise<SignalResult[]> {
  const signalNames = signals ?? request.signals ?? ['semantic', 'keyword', 'graph'];
  const limit = request.limit ?? 10;
  const database = request.database ?? config.database;

  // Resolve signal implementations
  const resolved: SignalImplementation[] = [];
  for (const name of signalNames) {
    const signal = signalRegistry.get(name);
    if (signal) {
      resolved.push(signal);
    } else {
      console.warn(`[graph-ability] Unknown signal "${name}" — skipping`);
    }
  }

  if (resolved.length === 0) {
    return [];
  }

  // Build base context
  const baseCtx: Omit<SignalContext, 'priorResults'> = {
    abilities,
    database,
    query: request.query,
    vertexType: request.vertexType,
    filters: request.filters,
    limit,
    embedding: request.embedding ?? {
      model: config.embeddingModel,
      transport: config.embeddingTransport,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
    },
    signalConfig: {
      structuralEdges: request.structuralEdges,
      structuralDepth: request.structuralDepth ?? 1,
      structuralTopK: request.structuralTopK ?? 5,
    },
  };

  // Partition into independent and dependent
  const independent = resolved.filter((s) => !s.requiresPriorResults);
  const dependent = resolved.filter((s) => s.requiresPriorResults);

  // Step 1: Run independent signals in parallel
  const independentRankings: SignalResult[][] = [];

  if (independent.length > 0) {
    const results = await Promise.all(
      independent.map((signal) =>
        signal.execute({ ...baseCtx }).catch((err) => {
          console.warn(
            `[graph-ability] Signal "${signal.name}" failed: ${err instanceof Error ? err.message : err}`,
          );
          return [] as SignalResult[];
        }),
      ),
    );
    independentRankings.push(...results);
  }

  // Step 2: Fuse independent results via RRF
  let fusedResults = fuseResults(independentRankings);

  // Step 3: Run dependent signals sequentially, feeding prior results
  const dependentRankings: SignalResult[][] = [];

  for (const signal of dependent) {
    try {
      const ctx: SignalContext = {
        ...baseCtx,
        priorResults: fusedResults.slice(0, (request.structuralTopK ?? 5)),
      };
      const results = await signal.execute(ctx);
      dependentRankings.push(results);
    } catch (err) {
      console.warn(
        `[graph-ability] Signal "${signal.name}" failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Step 4: Re-fuse all rankings (independent + dependent)
  if (dependentRankings.length > 0) {
    fusedResults = fuseResults([...independentRankings, ...dependentRankings]);
  }

  // Step 5: Apply importance weighting
  const weighted = fusedResults.map((result) => ({
    ...result,
    score: result.score * (0.7 + 0.3 * (result.importance ?? 0.5)),
  }));

  // Step 6: Sort by score descending, limit
  weighted.sort((a, b) => b.score - a.score);

  return weighted.slice(0, limit);
}

/**
 * Fuse multiple signal result rankings using RRF.
 */
function fuseResults(rankings: SignalResult[][]): SignalResult[] {
  if (rankings.length === 0) return [];
  if (rankings.length === 1) {
    // Single ranking — just normalize
    return rankings[0].map((r, i) => ({ ...r, score: 1 / (60 + i + 1) }));
  }

  const rrfInput = rankings.map((ranking) =>
    ranking.map((r) => ({ ...r, id: r.rid || r.id })),
  );

  const fused = reciprocalRankFusion(rrfInput);

  return fused.map((item) => ({
    rid: item.rid ?? item.id,
    id: item.id,
    content: item.content ?? '',
    score: item.score,
    importance: (item.importance as number) ?? 0.5,
    matchedVia: (item.matchedVia as string[]) ?? [],
    properties: (item.properties as Record<string, unknown>) ?? {},
  }));
}

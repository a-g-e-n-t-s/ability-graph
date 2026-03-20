/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists into a
 * single ranking that balances relevance signals from each source.
 *
 * Algorithm:
 *   RRF(d) = SUM over all rankings of  1 / (k + rank(d))
 *
 * where rank(d) is the 1-indexed position of document d in a given ranking,
 * and k is a smoothing constant (default 60).
 *
 * Reference: Cormack, Clarke & Buettcher (2009), "Reciprocal Rank Fusion
 * outperforms Condorcet and individual Rank Learning Methods."
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An item in a ranked list. Must have a string `id` for deduplication. */
export interface RankedItem {
  id: string;
  [key: string]: unknown;
}

/** The result of RRF: the original item enriched with its fused score. */
export type ScoredItem<T extends RankedItem = RankedItem> = T & {
  score: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * Items are identified by their `id` field. When the same ID appears in
 * multiple rankings, its RRF scores are summed. When a duplicate ID appears
 * within a single ranking, only its first occurrence is counted.
 *
 * @param rankings - Array of ranked lists. Each list is ordered by relevance
 *                   (index 0 = most relevant, rank 1).
 * @param k        - RRF smoothing constant (default 60).
 * @returns Merged results sorted by fused RRF score (descending).
 */
export function reciprocalRankFusion<T extends RankedItem>(
  rankings: T[][],
  k: number = 60,
): ScoredItem<T>[] {
  const scores = new Map<string, { score: number; item: T }>();

  for (const ranking of rankings) {
    // Track IDs seen within this ranking to skip duplicates.
    const seenInRanking = new Set<string>();

    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];

      if (seenInRanking.has(item.id)) continue;
      seenInRanking.add(item.id);

      // Convert 0-indexed array position to 1-indexed rank for the formula
      const rank = i + 1;
      const rrfScore = 1 / (k + rank);

      const existing = scores.get(item.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(item.id, { score: rrfScore, item });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ score, item }) => ({ ...item, score }));
}

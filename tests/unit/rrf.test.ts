import { describe, expect, it } from 'vitest';

import { reciprocalRankFusion, type RankedItem } from '../../src/lib/rrf.js';

describe('reciprocalRankFusion', () => {
  it('returns empty array for empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('returns empty array for empty rankings', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('handles single ranking list', () => {
    const ranking: RankedItem[] = [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ];
    const result = reciprocalRankFusion([ranking]);

    expect(result.length).toBe(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
    // Scores should be 1/(60+1) and 1/(60+2)
    expect(result[0].score).toBeCloseTo(1 / 61);
    expect(result[1].score).toBeCloseTo(1 / 62);
  });

  it('boosts items appearing in multiple rankings', () => {
    const ranking1: RankedItem[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const ranking2: RankedItem[] = [
      { id: 'b' },
      { id: 'a' },
      { id: 'd' },
    ];

    const result = reciprocalRankFusion([ranking1, ranking2]);

    const scoreA = result.find((r) => r.id === 'a')!.score;
    const scoreB = result.find((r) => r.id === 'b')!.score;
    expect(scoreA).toBeCloseTo(scoreB);

    const scoreC = result.find((r) => r.id === 'c')!.score;
    expect(scoreC).toBeCloseTo(1 / 63);

    // Items in both lists should score higher
    expect(scoreA).toBeGreaterThan(scoreC);
  });

  it('uses custom k parameter', () => {
    const ranking: RankedItem[] = [{ id: 'a' }];
    const result = reciprocalRankFusion([ranking], 10);
    expect(result[0].score).toBeCloseTo(1 / 11);
  });

  it('sorts by score descending', () => {
    const ranking1: RankedItem[] = [{ id: 'a' }, { id: 'b' }];
    const ranking2: RankedItem[] = [{ id: 'b' }, { id: 'c' }];
    const ranking3: RankedItem[] = [{ id: 'b' }, { id: 'a' }];

    const result = reciprocalRankFusion([ranking1, ranking2, ranking3]);

    expect(result[0].id).toBe('b');

    for (let i = 1; i < result.length; i++) {
      expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score);
    }
  });

  it('preserves extra properties from ranked items', () => {
    const ranking: RankedItem[] = [
      { id: 'a', title: 'Alpha', source: 'file.md' },
    ];
    const result = reciprocalRankFusion([ranking]);
    expect(result[0].title).toBe('Alpha');
    expect(result[0].source).toBe('file.md');
  });

  it('handles 3 rankings with deduplication', () => {
    const r1: RankedItem[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const r2: RankedItem[] = [{ id: 'c' }, { id: 'a' }, { id: 'd' }];
    const r3: RankedItem[] = [{ id: 'a' }, { id: 'd' }, { id: 'b' }];

    const result = reciprocalRankFusion([r1, r2, r3]);

    // 'a' appears in all 3 lists at rank 1, 2, 1 → highest fused score
    expect(result[0].id).toBe('a');
    // All 4 unique items should be present
    expect(result.length).toBe(4);
  });

  it('handles 4 rankings', () => {
    const r1: RankedItem[] = [{ id: 'x' }];
    const r2: RankedItem[] = [{ id: 'x' }];
    const r3: RankedItem[] = [{ id: 'x' }];
    const r4: RankedItem[] = [{ id: 'x' }];

    const result = reciprocalRankFusion([r1, r2, r3, r4]);
    expect(result.length).toBe(1);
    expect(result[0].score).toBeCloseTo(4 / 61);
  });

  it('skips duplicate IDs within a single ranking', () => {
    const ranking: RankedItem[] = [
      { id: 'a' },
      { id: 'a' }, // duplicate — should be ignored
      { id: 'b' },
    ];
    const result = reciprocalRankFusion([ranking]);

    expect(result.length).toBe(2);
    // 'a' should only get rank 1 score, not rank 1 + rank 2
    expect(result.find((r) => r.id === 'a')!.score).toBeCloseTo(1 / 61);
  });
});

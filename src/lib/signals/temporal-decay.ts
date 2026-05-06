/**
 * Temporal decay signal — weights newer and frequently-accessed memories higher.
 *
 * This is a dependent signal (requiresPriorResults: true) that reweights
 * prior results based on:
 * - Age: exponential decay with configurable half-life (default: 30 days)
 * - Access frequency: boost for higher access_count
 * - Mentions: boost for higher mentions count
 *
 * The decay formula: decayFactor = 2^(-age_days / half_life)
 * The access boost: accessBoost = log2(access_count + 1) / 10
 * The mentions boost: mentionsBoost = log2(mentions + 1) / 15
 *
 * Final score = priorScore * (decayWeight * decayFactor + accessWeight * accessBoost + mentionsWeight * mentionsBoost)
 */

import type { SignalContext, SignalResult } from '../types.js';
import type { SignalImplementation } from './index.js';

const DEFAULT_HALF_LIFE_DAYS = 30;
const DECAY_WEIGHT = 0.5;
const ACCESS_WEIGHT = 0.3;
const MENTIONS_WEIGHT = 0.2;

export const temporalDecaySignal: SignalImplementation = {
  name: 'temporal-decay',
  requiresPriorResults: true,

  async execute(ctx: SignalContext): Promise<SignalResult[]> {
    const { priorResults, signalConfig } = ctx;

    if (!priorResults || priorResults.length === 0) {
      return [];
    }

    const halfLifeDays = (signalConfig?.halfLifeDays as number) ?? DEFAULT_HALF_LIFE_DAYS;
    const now = Date.now();

    return priorResults.map((result) => {
      const decayFactor = computeDecayFactor(result.properties, now, halfLifeDays);
      const accessBoost = computeAccessBoost(result.properties);
      const mentionsBoost = computeMentionsBoost(result.properties);

      const temporalScore =
        DECAY_WEIGHT * decayFactor +
        ACCESS_WEIGHT * accessBoost +
        MENTIONS_WEIGHT * mentionsBoost;

      // Blend: 60% original score + 40% temporal score
      const blendedScore = 0.6 * result.score + 0.4 * temporalScore;

      return {
        ...result,
        score: blendedScore,
        matchedVia: [...(result.matchedVia ?? []), 'temporal-decay'],
      };
    });
  },
};

function computeDecayFactor(
  properties: Record<string, unknown>,
  now: number,
  halfLifeDays: number,
): number {
  const timestamp = (properties.timestamp as string)
    ?? (properties.createdAt as string)
    ?? (properties.indexedAt as string);

  if (!timestamp) return 0.5;

  const createdMs = new Date(timestamp).getTime();
  if (isNaN(createdMs)) return 0.5;

  const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0;

  // Exponential decay: 2^(-age / half_life)
  return Math.pow(2, -ageDays / halfLifeDays);
}

function computeAccessBoost(properties: Record<string, unknown>): number {
  const accessCount = Number(properties.access_count ?? properties.accessCount ?? 0);
  if (accessCount <= 0) return 0;
  // Logarithmic scaling: log2(count + 1) / 10, capped at 1.0
  return Math.min(1.0, Math.log2(accessCount + 1) / 10);
}

function computeMentionsBoost(properties: Record<string, unknown>): number {
  const mentions = Number(properties.mentions ?? 0);
  if (mentions <= 0) return 0;
  // Logarithmic scaling: log2(mentions + 1) / 15, capped at 1.0
  return Math.min(1.0, Math.log2(mentions + 1) / 15);
}

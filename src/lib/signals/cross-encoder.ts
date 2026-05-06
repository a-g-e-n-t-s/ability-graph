/**
 * Cross-encoder reranking signal — scores (query, candidate) pairs via LLM.
 *
 * This is a dependent signal (requiresPriorResults: true) that takes the
 * fused results from earlier signals and reranks them using an LLM-based
 * relevance scoring approach.
 *
 * Since model-manager doesn't have a dedicated /v1/rerank endpoint, we use
 * /v1/chat/completions with a structured scoring prompt. The LLM evaluates
 * each candidate's relevance to the query on a 0-10 scale.
 */

import { chatCompletion, type ChatConfig } from '../chat.js';
import type { SignalAbilities, SignalContext, SignalResult } from '../types.js';
import type { SignalImplementation } from './index.js';

const MAX_CANDIDATES = 10;
const RERANK_MODEL = 'gpt-5-mini';
const RERANK_TEMPERATURE = 0.0;
const MAX_CONTENT_PER_CANDIDATE = 800;

export const crossEncoderSignal: SignalImplementation = {
  name: 'rerank',
  requiresPriorResults: true,

  async execute(ctx: SignalContext): Promise<SignalResult[]> {
    const { abilities, priorResults, query, signalConfig } = ctx;

    if (!priorResults || priorResults.length === 0) {
      return [];
    }

    const candidates = priorResults.slice(0, MAX_CANDIDATES);

    const chatCfg: ChatConfig = {
      transport: (ctx.embedding?.transport as 'broker' | 'api') ?? 'api',
      apiUrl: ctx.embedding?.apiUrl,
      apiKey: ctx.embedding?.apiKey,
    };

    const model = (signalConfig?.rerankModel as string) ?? RERANK_MODEL;

    const scoredResults = await scoreCandidates(abilities, chatCfg, model, query, candidates);

    scoredResults.sort((a, b) => b.score - a.score);

    return scoredResults.map((r) => ({
      ...r,
      matchedVia: [...(r.matchedVia ?? []), 'rerank'],
    }));
  },
};

async function scoreCandidates(
  abilities: SignalAbilities,
  chatCfg: ChatConfig,
  model: string,
  query: string,
  candidates: SignalResult[],
): Promise<SignalResult[]> {
  const candidateTexts = candidates.map((c, i) => {
    const content = c.content.length > MAX_CONTENT_PER_CANDIDATE
      ? c.content.slice(0, MAX_CONTENT_PER_CANDIDATE) + '…'
      : c.content;
    return `[${i}] ${content}`;
  });

  const systemPrompt =
    'You are a relevance scoring engine. Given a query and a list of candidate documents, ' +
    'score each document\'s relevance to the query on a scale of 0-10.\n\n' +
    'Rules:\n' +
    '- 10 = perfectly answers the query\n' +
    '- 7-9 = highly relevant, contains key information\n' +
    '- 4-6 = somewhat relevant, tangentially related\n' +
    '- 1-3 = barely relevant\n' +
    '- 0 = completely irrelevant\n\n' +
    'Respond ONLY with a JSON array of scores in order, e.g. [8, 5, 2, 9, 1]\n' +
    'The array must have exactly the same number of elements as candidates.';

  const userPrompt =
    `Query: ${query}\n\nCandidates:\n${candidateTexts.join('\n\n')}`;

  try {
    const response = await chatCompletion(abilities, {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 200,
      temperature: RERANK_TEMPERATURE,
    }, chatCfg);

    const content = response.choices?.[0]?.message?.content ?? '';
    const scores = parseScores(content, candidates.length);

    return candidates.map((candidate, i) => ({
      ...candidate,
      score: scores[i] / 10,
    }));
  } catch (err) {
    console.warn(
      `[rerank] LLM scoring failed: ${err instanceof Error ? err.message : err}. Returning original order.`,
    );
    return candidates;
  }
}

function parseScores(content: string, expectedCount: number): number[] {
  const cleaned = content.replace(/```json?\s*/g, '').replace(/```/g, '').trim();

  const match = cleaned.match(/\[[\d\s,.]+\]/);
  if (!match) {
    return Array(expectedCount).fill(5);
  }

  try {
    const parsed = JSON.parse(match[0]) as number[];
    if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
      return Array(expectedCount).fill(5);
    }
    return parsed.map((s) => Math.max(0, Math.min(10, Number(s) || 5)));
  } catch {
    return Array(expectedCount).fill(5);
  }
}

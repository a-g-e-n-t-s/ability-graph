/**
 * Lightweight token estimation without a tokenizer dependency.
 *
 * Uses a whitespace-based heuristic: word count * 1.3 approximates BPE token
 * count for English text. The 1.3 multiplier accounts for subword splits that
 * BPE tokenizers (GPT, LLaMA, etc.) apply — most English words map to 1-2
 * tokens, averaging ~1.3. This is intentionally conservative (overestimates
 * slightly) so chunks stay within model context limits.
 */

const TOKENS_PER_WORD = 1.3;
const CHARS_PER_WORD = 5;
const SEARCH_BUFFER_CHARS = 200;

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * TOKENS_PER_WORD);
}

export function splitAtSentenceBoundary(
  text: string,
  maxTokens: number,
): [string, string] {
  if (estimateTokens(text) <= maxTokens) {
    return [text, ''];
  }

  const approxChars = Math.floor((maxTokens / TOKENS_PER_WORD) * CHARS_PER_WORD);
  const searchRegion = text.slice(0, Math.min(approxChars + SEARCH_BUFFER_CHARS, text.length));

  const sentencePos = findLastSentenceBoundary(text, searchRegion, maxTokens);
  if (sentencePos > 0) {
    return [text.slice(0, sentencePos).trimEnd(), text.slice(sentencePos).trimStart()];
  }

  return splitAtWordBoundary(text, maxTokens);
}

function findLastSentenceBoundary(
  fullText: string,
  searchRegion: string,
  maxTokens: number,
): number {
  let splitPos = -1;
  let idx = 0;

  while (true) {
    const nextDot = searchRegion.indexOf('. ', idx);
    if (nextDot === -1) break;

    const candidate = nextDot + 2;
    if (estimateTokens(fullText.slice(0, candidate)) <= maxTokens) {
      splitPos = candidate;
      idx = candidate;
    } else {
      break;
    }
  }

  return splitPos;
}

function splitAtWordBoundary(
  text: string,
  maxTokens: number,
): [string, string] {
  const words = text.split(/\s+/);
  let accumulated = '';

  for (let i = 0; i < words.length; i++) {
    const next = accumulated ? accumulated + ' ' + words[i] : words[i];

    if (estimateTokens(next) > maxTokens) {
      if (i === 0) {
        return [words[0], words.slice(1).join(' ')];
      }
      return [accumulated, words.slice(i).join(' ')];
    }

    accumulated = next;
  }

  return [text, ''];
}

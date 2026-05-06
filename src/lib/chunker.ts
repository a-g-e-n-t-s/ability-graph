/**
 * Chunking engine -- 5 strategies for splitting text content into indexable chunks.
 *
 * Strategies:
 *   - `markdown-headers`  -- Split on `#` headings with breadcrumb hierarchy
 *   - `code-blocks`       -- Separate fenced code blocks from prose
 *   - `paragraph`         -- Split on double newlines, merge short paragraphs
 *   - `sliding-window`    -- Fixed-size windows with configurable overlap
 *   - `auto`              -- Inspects content to pick the best strategy
 *
 * Ported from ability-search into ability-graph for consolidation.
 */

import { estimateTokens, splitAtSentenceBoundary } from './tokens.js';

// ── Public types ──────────────────────────────────────────────────────

interface BaseChunkMetadata {
  strategy: ChunkStrategy;
}

interface MarkdownHeadersMetadata extends BaseChunkMetadata {
  strategy: 'markdown-headers';
  breadcrumb: string;
}

interface CodeBlocksProseMetadata extends BaseChunkMetadata {
  strategy: 'code-blocks';
  type: 'prose';
}

interface CodeBlocksCodeMetadata extends BaseChunkMetadata {
  strategy: 'code-blocks';
  type: 'code';
  language: string;
  context: string;
}

interface ParagraphMetadata extends BaseChunkMetadata {
  strategy: 'paragraph';
}

interface SlidingWindowMetadata extends BaseChunkMetadata {
  strategy: 'sliding-window';
}

interface FallbackMetadata extends BaseChunkMetadata {
  strategy: 'auto';
}

export type ChunkMetadata =
  | MarkdownHeadersMetadata
  | CodeBlocksProseMetadata
  | CodeBlocksCodeMetadata
  | ParagraphMetadata
  | SlidingWindowMetadata
  | FallbackMetadata;

export interface Chunk {
  content: string;
  chunkIndex: number;
  totalChunks: number;
  tokens: number;
  metadata: ChunkMetadata;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlap?: number;
}

export type ChunkStrategy =
  | 'markdown-headers'
  | 'code-blocks'
  | 'paragraph'
  | 'sliding-window'
  | 'auto';

// ── Fence detection ───────────────────────────────────────────────────

const FENCE_PATTERN = /^(`{3,}|~{3,})/;

function parseFenceLine(
  line: string,
  inFencedBlock: boolean,
): { isFence: true; language: string } | { isFence: false } {
  const trimmed = line.trimStart();
  const match = trimmed.match(FENCE_PATTERN);
  if (!match) return { isFence: false };

  if (inFencedBlock) {
    if (trimmed.trimEnd() === match[1] || trimmed.trimEnd().match(/^(`{3,}|~{3,})\s*$/)) {
      return { isFence: true, language: '' };
    }
    return { isFence: false };
  }

  const afterFence = trimmed.slice(match[1].length).trim();
  const language = afterFence.split(/\s/)[0] || '';
  return { isFence: true, language };
}

// ── Strategy: markdown-headers ────────────────────────────────────────

interface MarkdownSection {
  heading: string;
  level: number;
  lines: string[];
}

function chunkByMarkdownHeaders(content: string, options: ChunkOptions): Chunk[] {
  const maxTokens = options.maxTokens ?? 500;
  const lines = content.split('\n');
  const sections = splitIntoMarkdownSections(lines);

  if (sections.length === 0) return [];

  const headingStack: Array<{ heading: string; level: number }> = [];
  const chunks: Chunk[] = [];

  for (const section of sections) {
    updateHeadingStack(headingStack, section);

    const bodyText = section.lines.join('\n').trim();
    if (!bodyText && !section.heading) continue;

    const breadcrumb = headingStack.map((h) => h.heading).join(' > ');
    const sectionContent = section.heading
      ? `${section.heading}\n\n${bodyText}`
      : bodyText;

    if (!sectionContent.trim()) continue;

    const sectionChunks = splitToFitTokenLimit(sectionContent, maxTokens);
    for (const part of sectionChunks) {
      chunks.push({
        content: part,
        chunkIndex: 0,
        totalChunks: 0,
        tokens: estimateTokens(part),
        metadata: { strategy: 'markdown-headers', breadcrumb },
      });
    }
  }

  return finalizeChunks(chunks);
}

function splitIntoMarkdownSections(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let currentHeading = '';
  let currentLevel = 0;
  let currentLines: string[] = [];
  let inFencedBlock = false;

  for (const line of lines) {
    const fence = parseFenceLine(line, inFencedBlock);
    if (fence.isFence) {
      inFencedBlock = !inFencedBlock;
      currentLines.push(line);
      continue;
    }

    if (inFencedBlock) {
      currentLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading) {
        sections.push({ heading: currentHeading, level: currentLevel, lines: currentLines });
      }
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading) {
    sections.push({ heading: currentHeading, level: currentLevel, lines: currentLines });
  }

  return sections;
}

function updateHeadingStack(
  stack: Array<{ heading: string; level: number }>,
  section: MarkdownSection,
): void {
  if (!section.heading) return;
  while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
    stack.pop();
  }
  stack.push({ heading: section.heading, level: section.level });
}

// ── Strategy: code-blocks ─────────────────────────────────────────────

interface ContentSegment {
  type: 'prose' | 'code';
  content: string;
  language: string;
}

function chunkByCodeBlocks(content: string, options: ChunkOptions): Chunk[] {
  const maxTokens = options.maxTokens ?? 500;
  const segments = splitIntoCodeSegments(content);
  const chunks: Chunk[] = [];
  let lastProseContext = '';

  for (const segment of segments) {
    const text = segment.content.trim();
    if (!text) continue;

    if (segment.type === 'prose') {
      lastProseContext = extractTrailingContext(text);
      const parts = splitToFitTokenLimit(text, maxTokens);
      for (const part of parts) {
        chunks.push({
          content: part,
          chunkIndex: 0,
          totalChunks: 0,
          tokens: estimateTokens(part),
          metadata: { strategy: 'code-blocks', type: 'prose' },
        });
      }
    } else {
      const codeContent = '```' + segment.language + '\n' + text + '\n```';
      chunks.push({
        content: codeContent,
        chunkIndex: 0,
        totalChunks: 0,
        tokens: estimateTokens(codeContent),
        metadata: {
          strategy: 'code-blocks',
          type: 'code',
          language: segment.language || 'unknown',
          context: lastProseContext,
        },
      });
    }
  }

  return finalizeChunks(chunks);
}

function splitIntoCodeSegments(content: string): ContentSegment[] {
  const lines = content.split('\n');
  const segments: ContentSegment[] = [];
  let currentType: 'prose' | 'code' = 'prose';
  let currentLines: string[] = [];
  let currentLang = '';
  let inFencedBlock = false;

  for (const line of lines) {
    const fence = parseFenceLine(line, inFencedBlock);
    if (fence.isFence) {
      if (!inFencedBlock) {
        if (currentLines.length > 0) {
          segments.push({ type: 'prose', content: currentLines.join('\n'), language: '' });
        }
        currentLines = [];
        currentType = 'code';
        currentLang = fence.language;
        inFencedBlock = true;
      } else {
        segments.push({ type: 'code', content: currentLines.join('\n'), language: currentLang });
        currentLines = [];
        currentType = 'prose';
        currentLang = '';
        inFencedBlock = false;
      }
      continue;
    }
    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    segments.push({ type: currentType, content: currentLines.join('\n'), language: currentLang });
  }

  return segments;
}

function extractTrailingContext(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z]|$)/);
  const trailing = sentences.slice(-2).join(' ');
  if (!trailing) return '';
  if (/[.!?]$/.test(trailing)) return trailing;
  return trailing + '.';
}

// ── Strategy: paragraph ───────────────────────────────────────────────

function chunkByParagraph(content: string, options: ChunkOptions): Chunk[] {
  const maxTokens = options.maxTokens ?? 500;
  const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (estimateTokens(para) > maxTokens) {
      if (buffer) {
        chunks.push(makeParagraphChunk(buffer));
        buffer = '';
      }
      const parts = splitToFitTokenLimit(para, maxTokens);
      for (const part of parts) {
        chunks.push(makeParagraphChunk(part));
      }
      continue;
    }

    const combined = buffer ? buffer + '\n\n' + para : para;
    if (estimateTokens(combined) > maxTokens) {
      if (buffer) chunks.push(makeParagraphChunk(buffer));
      buffer = para;
    } else {
      buffer = combined;
    }
  }

  if (buffer) {
    chunks.push(makeParagraphChunk(buffer));
  }

  return finalizeChunks(chunks);
}

function makeParagraphChunk(content: string): Chunk {
  return {
    content,
    chunkIndex: 0,
    totalChunks: 0,
    tokens: estimateTokens(content),
    metadata: { strategy: 'paragraph' },
  };
}

// ── Strategy: sliding-window ──────────────────────────────────────────

function chunkBySlidingWindow(content: string, options: ChunkOptions): Chunk[] {
  const maxTokens = options.maxTokens ?? 500;
  const overlap = options.overlap ?? 50;

  if (!content.trim()) return [];

  const sentences = splitIntoSentences(content);
  if (sentences.length === 0) return [];

  const chunks: Chunk[] = [];
  let windowStart = 0;

  while (windowStart < sentences.length) {
    let windowTokens = 0;
    let windowEnd = windowStart;

    while (windowEnd < sentences.length) {
      const sentenceTokens = estimateTokens(sentences[windowEnd]);
      if (windowTokens + sentenceTokens > maxTokens && windowEnd > windowStart) {
        break;
      }
      windowTokens += sentenceTokens;
      windowEnd++;
    }

    const windowContent = sentences.slice(windowStart, windowEnd).join(' ').trim();
    if (windowContent) {
      chunks.push({
        content: windowContent,
        chunkIndex: 0,
        totalChunks: 0,
        tokens: estimateTokens(windowContent),
        metadata: { strategy: 'sliding-window' },
      });
    }

    if (windowEnd >= sentences.length) break;

    let overlapTokens = 0;
    let newStart = windowEnd;
    for (let i = windowEnd - 1; i >= windowStart; i--) {
      overlapTokens += estimateTokens(sentences[i]);
      if (overlapTokens >= overlap) {
        newStart = i;
        break;
      }
      newStart = i;
    }

    if (newStart <= windowStart) {
      newStart = windowStart + 1;
    }
    windowStart = newStart;
  }

  return finalizeChunks(chunks);
}

// ── Strategy: auto ────────────────────────────────────────────────────

function countRealHeadings(content: string): number {
  const lines = content.split('\n');
  let inFence = false;
  let count = 0;

  for (const line of lines) {
    const fence = parseFenceLine(line, inFence);
    if (fence.isFence) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s+/.test(line)) {
      count++;
    }
  }

  return count;
}

function countCodeBlockPairs(content: string): number {
  const lines = content.split('\n');
  let inFence = false;
  let pairs = 0;

  for (const line of lines) {
    const fence = parseFenceLine(line, inFence);
    if (fence.isFence) {
      if (inFence) pairs++;
      inFence = !inFence;
    }
  }

  return pairs;
}

function chunkAuto(content: string, options: ChunkOptions): Chunk[] {
  if (countRealHeadings(content) >= 3) {
    return chunkByMarkdownHeaders(content, options);
  }

  if (countCodeBlockPairs(content) >= 3) {
    return chunkByCodeBlocks(content, options);
  }

  return chunkByParagraph(content, options);
}

// ── Dispatcher ────────────────────────────────────────────────────────

type StrategyFn = (content: string, options: ChunkOptions) => Chunk[];

const strategies: Record<ChunkStrategy, StrategyFn> = {
  'markdown-headers': chunkByMarkdownHeaders,
  'code-blocks': chunkByCodeBlocks,
  paragraph: chunkByParagraph,
  'sliding-window': chunkBySlidingWindow,
  auto: chunkAuto,
};

export function chunkContent(
  content: string,
  strategy: ChunkStrategy = 'auto',
  options: ChunkOptions = {},
): Chunk[] {
  const fn = strategies[strategy];
  if (!fn) {
    throw new Error(`Unknown chunk strategy: "${strategy as string}"`);
  }

  const result = fn(content, options);
  if (result.length > 0) return result;

  return makeSingleChunk(content);
}

// ── Shared helpers ────────────────────────────────────────────────────

function makeSingleChunk(content: string): Chunk[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  return [
    {
      content: trimmed,
      chunkIndex: 0,
      totalChunks: 1,
      tokens: estimateTokens(trimmed),
      metadata: { strategy: 'auto' },
    },
  ];
}

function finalizeChunks(chunks: Chunk[]): Chunk[] {
  const total = chunks.length;
  for (let i = 0; i < total; i++) {
    chunks[i].chunkIndex = i;
    chunks[i].totalChunks = total;
  }
  return chunks;
}

function splitToFitTokenLimit(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining) {
    const [part, rest] = splitAtSentenceBoundary(remaining, maxTokens);
    if (!part.trim()) break;
    parts.push(part);
    remaining = rest;
  }

  return parts;
}

function splitIntoSentences(text: string): string[] {
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.map((s) => s.trim()).filter(Boolean);
}

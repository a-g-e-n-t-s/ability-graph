/**
 * Entity and topic extraction via chat-completion.
 *
 * Extracts structured metadata (topics, entities, importance) from content
 * using an LLM. Routes through either broker or direct HTTP API.
 * Degrades gracefully on any failure — returns empty extraction rather
 * than crashing.
 *
 * All broker-mode calls go through {@link invokeWithRetry} via the
 * {@link chatCompletion} function.
 */

import { chatCompletion, type ChatConfig } from './chat.js';
import type { EntityType, ExtractionResult, SignalAbilities } from './types.js';
import { ENTITY_TYPES } from './types.js';

/**
 * System prompt for the extraction LLM.
 */
const EXTRACTION_PROMPT = `Extract topics, entities, and importance from the text.
Respond with JSON only:
{
  "topics": ["lowercase-hyphenated-topic"],
  "entities": [{ "name": "Entity Name", "type": "person|project|tool|company|concept" }],
  "importance": 0.0 to 1.0
}

Rules:
- Topics: 1-5 per text, lowercase-hyphenated format (e.g., "agent-development", "vector-search")
- Entities: name + type, where type is one of: person, project, tool, company, concept
- Importance: 0.0-1.0 based on how significant/actionable the content is
- Return valid JSON only, no markdown fences`;

/**
 * Empty extraction result returned on failure.
 */
const EMPTY_EXTRACTION: ExtractionResult = {
  topics: [],
  entities: [],
  importance: 0.5,
};

/**
 * Extract topics, entities, and importance from content using an LLM.
 *
 * **Graceful degradation**: On any failure, returns empty extraction.
 *
 * @param abilities - The abilities interface for invoking tools.
 * @param content   - The content to analyze.
 * @param model     - Model name for extraction.
 * @param chat      - Chat transport configuration.
 * @returns Extracted metadata, or empty extraction on failure.
 */
export async function extractMetadata(
  abilities: SignalAbilities,
  content: string,
  model: string,
  chat: ChatConfig,
): Promise<ExtractionResult> {
  try {
    const response = await chatCompletion(abilities, {
      model,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }, chat);

    const text = response.choices?.[0]?.message?.content;
    if (!text) return EMPTY_EXTRACTION;

    const parsed = JSON.parse(text) as Record<string, unknown>;
    return validateExtraction(parsed);
  } catch {
    return EMPTY_EXTRACTION;
  }
}

/**
 * Validate and clamp parsed extraction values.
 */
function validateExtraction(raw: Record<string, unknown>): ExtractionResult {
  // Topics: must be string array, max 5, lowercase-hyphenated
  let topics: string[] = [];
  if (Array.isArray(raw.topics)) {
    topics = raw.topics
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.toLowerCase().replace(/\s+/g, '-'))
      .slice(0, 5);
  }

  // Entities: must be array of { name, type }
  let entities: Array<{ name: string; type: EntityType }> = [];
  if (Array.isArray(raw.entities)) {
    entities = raw.entities
      .filter(
        (e): e is { name: string; type: string } =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as Record<string, unknown>).name === 'string' &&
          typeof (e as Record<string, unknown>).type === 'string',
      )
      .map((e) => ({
        name: e.name,
        type: ENTITY_TYPES.includes(e.type as EntityType)
          ? (e.type as EntityType)
          : 'concept',
      }));
  }

  // Importance: must be number 0-1
  let importance = 0.5;
  if (typeof raw.importance === 'number' && Number.isFinite(raw.importance)) {
    importance = Math.max(0, Math.min(1, raw.importance));
  }

  return { topics, entities, importance };
}

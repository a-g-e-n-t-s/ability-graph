/**
 * Query template system for the Graph Explorer.
 *
 * Provides pre-built, parameterized SQL queries grouped by schema family.
 * Each template belongs to a schema: 'agent-memory', 'docs', or 'general'.
 *
 * When filtering by schema, the matching schema templates PLUS all 'general'
 * templates are returned. An unknown schema returns only 'general' templates.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryTemplate {
  id: string;
  name: string;
  description: string;
  schema: string;           // 'agent-memory' | 'docs' | 'general'
  query: string;            // SQL with :paramName placeholders
  params: TemplateParam[];
  resultMode: 'table' | 'graph' | 'both';
}

export interface TemplateParam {
  name: string;
  label: string;
  type: 'string' | 'number';
  default?: string;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const templates: QueryTemplate[] = [
  // ── Agent Memory ─────────────────────────────────────────────────
  {
    id: 'am-memories-for-agent',
    name: 'All memories for agent',
    description: 'Retrieve all Memory vertices for a specific agent, ordered by timestamp.',
    schema: 'agent-memory',
    query: 'SELECT * FROM Memory WHERE agent = :agent ORDER BY timestamp DESC LIMIT :limit',
    params: [
      { name: 'agent', label: 'Agent name', type: 'string', required: true },
      { name: 'limit', label: 'Max results', type: 'number', default: '50', required: false },
    ],
    resultMode: 'table',
  },
  {
    id: 'am-recent-conversations',
    name: 'Recent conversations',
    description: 'List the most recent Conversation vertices.',
    schema: 'agent-memory',
    query: 'SELECT * FROM Conversation ORDER BY startTime DESC LIMIT :limit',
    params: [
      { name: 'limit', label: 'Max results', type: 'number', default: '20', required: false },
    ],
    resultMode: 'table',
  },
  {
    id: 'am-memory-topics',
    name: 'Memory → Topics subgraph',
    description: 'Graph of Memory vertices connected to their Topics via HasTopic edges.',
    schema: 'agent-memory',
    query: "MATCH {type: Memory, as: m}.out('HasTopic'){as: t} RETURN m, t LIMIT :limit",
    params: [
      { name: 'limit', label: 'Max results', type: 'number', default: '100', required: false },
    ],
    resultMode: 'graph',
  },
  {
    id: 'am-memory-entities',
    name: 'Memory → Entities subgraph',
    description: 'Graph of Memory vertices connected to Entities via Mentions edges.',
    schema: 'agent-memory',
    query: "MATCH {type: Memory, as: m}.out('Mentions'){as: e} RETURN m, e LIMIT :limit",
    params: [
      { name: 'limit', label: 'Max results', type: 'number', default: '100', required: false },
    ],
    resultMode: 'graph',
  },
  {
    id: 'am-orphaned-topics',
    name: 'Orphaned topics',
    description: 'Topic vertices with no edges — cleanup candidates.',
    schema: 'agent-memory',
    query: 'SELECT FROM Topic WHERE both().size() = 0',
    params: [],
    resultMode: 'table',
  },
  {
    id: 'am-conversation-graph',
    name: 'Full conversation graph',
    description: 'All Memory vertices belonging to a specific Conversation.',
    schema: 'agent-memory',
    query: 'MATCH {type: Conversation, as: c, where: (conversationId = :id)} <-InConversation- {type: Memory, as: m} RETURN c, m',
    params: [
      { name: 'id', label: 'Conversation ID', type: 'string', required: true },
    ],
    resultMode: 'graph',
  },

  // ── Documentation ────────────────────────────────────────────────
  {
    id: 'docs-pages-in-collection',
    name: 'All pages in collection',
    description: 'List unique pages in a documentation collection.',
    schema: 'docs',
    query: 'SELECT DISTINCT source, title, slug FROM DocNode WHERE collection = :collection',
    params: [
      { name: 'collection', label: 'Collection name', type: 'string', default: 'kadi-docs', required: false },
    ],
    resultMode: 'table',
  },
  {
    id: 'docs-page-chunk-chain',
    name: 'Page chunk chain',
    description: 'Follow the NextSection chain from the first chunk of a page.',
    schema: 'docs',
    query: "MATCH {type: DocNode, as: d, where: (slug = :slug AND chunkIndex = 0)}.out('NextSection'){as: n, while: ($depth < 50)} RETURN d, n",
    params: [
      { name: 'slug', label: 'Page slug', type: 'string', required: true },
    ],
    resultMode: 'graph',
  },
  {
    id: 'docs-cross-references',
    name: 'Cross-references',
    description: 'All Reference edges connected to a page slug.',
    schema: 'docs',
    query: "SELECT expand(bothE('References')) FROM DocNode WHERE slug = :slug",
    params: [
      { name: 'slug', label: 'Page slug', type: 'string', required: true },
    ],
    resultMode: 'table',
  },
  {
    id: 'docs-topic-frequency',
    name: 'Topic frequency',
    description: 'Most frequently referenced topics.',
    schema: 'docs',
    query: 'SELECT name, frequency FROM Topic ORDER BY frequency DESC LIMIT :limit',
    params: [
      { name: 'limit', label: 'Max results', type: 'number', default: '25', required: false },
    ],
    resultMode: 'table',
  },

  // ── General ──────────────────────────────────────────────────────
  {
    id: 'gen-vertex-type-counts',
    name: 'Vertex type counts',
    description: 'Count of vertices for a specific type. Use Schema Browser to see available types.',
    schema: 'general',
    query: 'SELECT count(*) as cnt FROM :vertexType',
    params: [
      { name: 'vertexType', label: 'Vertex type (e.g. Memory)', type: 'string', required: true },
    ],
    resultMode: 'table',
  },
  {
    id: 'gen-edge-type-counts',
    name: 'Edge type counts',
    description: 'Count of edges for a specific type. Use Schema Browser to see available edge types.',
    schema: 'general',
    query: 'SELECT count(*) as cnt FROM :edgeType',
    params: [
      { name: 'edgeType', label: 'Edge type (e.g. HasTopic)', type: 'string', required: true },
    ],
    resultMode: 'table',
  },
  {
    id: 'gen-edge-type-connections',
    name: 'Edge type connections',
    description: 'Edge type with its source and target vertex types.',
    schema: 'general',
    query: 'SELECT @type, out.@type as fromType, in.@type as toType, count(*) as cnt FROM :edgeType GROUP BY @type, out.@type, in.@type',
    params: [
      { name: 'edgeType', label: 'Edge type (e.g. HasTopic)', type: 'string', required: true },
    ],
    resultMode: 'table',
  },
  {
    id: 'gen-find-by-rid',
    name: 'Find vertex by RID',
    description: 'Look up a single vertex by its record ID.',
    schema: 'general',
    query: 'SELECT * FROM :rid',
    params: [
      { name: 'rid', label: 'Record ID (e.g. #12:0)', type: 'string', required: true },
    ],
    resultMode: 'table',
  },
  {
    id: 'gen-vertices-by-type',
    name: 'Vertices by type',
    description: 'List vertices of a specific type.',
    schema: 'general',
    query: 'SELECT * FROM :vertexType LIMIT :limit',
    params: [
      { name: 'vertexType', label: 'Vertex type', type: 'string', required: true },
      { name: 'limit', label: 'Max results', type: 'number', default: '50', required: false },
    ],
    resultMode: 'table',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all query templates across every schema family.
 */
export function getAllTemplates(): QueryTemplate[] {
  return [...templates];
}

/**
 * Return templates for a given schema family.
 *
 * The result always includes all 'general' templates. If the requested
 * schema matches a known family ('agent-memory', 'docs'), its templates are
 * included too. An unknown schema returns only 'general' templates.
 */
export function getTemplatesForSchema(schema: string): QueryTemplate[] {
  return templates.filter(
    (t) => t.schema === 'general' || t.schema === schema,
  );
}

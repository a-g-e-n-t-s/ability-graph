/**
 * Shared type definitions for graph-ability.
 *
 * These types define the schema registry, retry infrastructure, signal system,
 * and convenience constants for the graph ability engine.
 */

// ---------------------------------------------------------------------------
// Schema Registry Types
// ---------------------------------------------------------------------------

/** Definition of a named schema to register with the graph engine. */
export interface SchemaDefinition {
  /** Unique name for this schema (e.g., 'agent-memory', 'docs'). */
  name: string;
  /** Database to apply this schema to (default: config.database). */
  database?: string;
  /** Vertex type definitions. */
  vertexTypes: VertexTypeDef[];
  /** Edge type definitions. */
  edgeTypes: EdgeTypeDef[];
  /** Entity types allowed by this schema. */
  entityTypes?: string[];
}

/** Definition of a vertex type with its properties and indexes. */
export interface VertexTypeDef {
  /** The vertex type name (e.g., 'Memory', 'DocNode'). */
  name: string;
  /** Property name → ArcadeDB type string (e.g., 'STRING', 'DATETIME'). */
  properties: Record<string, string>;
  /** Indexes to create on this vertex type. */
  indexes?: IndexDef[];
}

/** Definition of an edge type with optional properties. */
export interface EdgeTypeDef {
  /** The edge type name (e.g., 'HasTopic', 'NextSection'). */
  name: string;
  /** Property name → ArcadeDB type string. */
  properties?: Record<string, string>;
}

/** Definition of an index to create on a vertex type. */
export interface IndexDef {
  /** Property name (or comma-separated names for composite index). */
  property: string;
  /** Index type. */
  type: 'UNIQUE' | 'NOTUNIQUE' | 'FULL_TEXT';
}

/** A single field on a vertex type. */
export interface VertexField {
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Retry Infrastructure Types
// ---------------------------------------------------------------------------

/** Configuration for retry behavior on a specific operation type. */
export interface RetryPolicy {
  /** Maximum retry attempts. 0 = no retry. */
  maxRetries: number;
  /** Initial delay before first retry (ms). */
  initialDelayMs: number;
  /** Multiplier for exponential backoff (default: 2). */
  backoffMultiplier: number;
  /** Maximum delay cap (ms). Prevents unbounded growth. */
  maxDelayMs: number;
  /** Add ±20% jitter to prevent thundering herd (default: true). */
  jitter: boolean;
  /** Function to determine if an error is retryable. */
  isRetryable?: (error: Error) => boolean;
  /** Optional callback on each retry (for logging/metrics). */
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
}

// ---------------------------------------------------------------------------
// Signal System Types
// ---------------------------------------------------------------------------

/** Result from a single recall signal. */
export interface SignalResult {
  /** Vertex RID in ArcadeDB. */
  rid: string;
  /** Unique identifier (typically same as rid). */
  id: string;
  /** Content of the vertex. */
  content: string;
  /** Relevance score from this signal. */
  score: number;
  /** Importance weighting of the vertex (0-1). */
  importance: number;
  /** Which signal(s) matched this result. */
  matchedVia: string[];
  /** All properties on the vertex. */
  properties: Record<string, unknown>;
}

/** Context passed to signal implementations during recall. */
export interface SignalContext {
  /** The abilities object for invoking remote tools. */
  abilities: SignalAbilities;
  /** Target ArcadeDB database. */
  database: string;
  /** The user's search query. */
  query: string;
  /** Which vertex type to search. */
  vertexType: string;
  /** Additional WHERE clause filters. */
  filters?: Record<string, unknown>;
  /** Maximum results to return. */
  limit: number;
  /** Embedding configuration. */
  embedding?: EmbeddingSignalConfig;
  /** Top results from earlier signals (for dependent signals like structural). */
  priorResults?: SignalResult[];
  /** Signal-specific configuration. */
  signalConfig?: Record<string, unknown>;
}

/** Embedding configuration for signals. */
export interface EmbeddingSignalConfig {
  model?: string;
  transport?: 'broker' | 'api';
  apiUrl?: string;
  apiKey?: string;
}

/** Abilities interface used by signals to invoke remote tools. */
export interface SignalAbilities {
  invoke<T = unknown>(tool: string, params: Record<string, unknown>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Store / Recall Request Types
// ---------------------------------------------------------------------------

/** Request to store a vertex in the graph. */
export interface StoreRequest {
  /** The content to store. */
  content: string;
  /** The vertex type (REQUIRED). */
  vertexType: string;
  /** Additional properties. */
  properties?: Record<string, unknown>;
  /** Explicit topics (skip extraction). */
  topics?: string[];
  /** Explicit entities (skip extraction). */
  entities?: Array<{ name: string; type: string }>;
  /** Edges to create from/to this vertex. */
  edges?: Array<{
    type: string;
    direction: 'out' | 'in';
    targetRid?: string;
    targetQuery?: { vertexType: string; where: Record<string, unknown> };
    properties?: Record<string, unknown>;
  }>;
  /** Target database. */
  database?: string;
  /** Skip entity/topic extraction. */
  skipExtraction?: boolean;
  /** Content importance (0-1). */
  importance?: number;
  /** Embedding configuration. */
  embedding?: EmbeddingSignalConfig;
}

/** Request to recall vertices from the graph. */
export interface RecallRequest {
  /** The search query. */
  query: string;
  /** The vertex type to search (REQUIRED). */
  vertexType: string;
  /** Search mode. */
  mode?: 'semantic' | 'keyword' | 'graph' | 'hybrid';
  /** Which signals for hybrid mode. */
  signals?: string[];
  /** Edge types for structural signal. */
  structuralEdges?: string[];
  /** Expansion hops for structural signal (default: 1). */
  structuralDepth?: number;
  /** Expand from top N results for structural (default: 5). */
  structuralTopK?: number;
  /** Additional WHERE clause filters. */
  filters?: Record<string, unknown>;
  /** Max results (default: 10). */
  limit?: number;
  /** Target database. */
  database?: string;
  /** Embedding configuration. */
  embedding?: EmbeddingSignalConfig;
}

/** A single item in a batch store operation. */
export interface BatchItem {
  /** The content to store. */
  content: string;
  /** The vertex type. */
  vertexType?: string;
  /** Additional properties. */
  properties?: Record<string, unknown>;
  /** Explicit topics (skip extraction). */
  topics?: string[];
  /** Explicit entities (skip extraction). */
  entities?: Array<{ name: string; type: string }>;
  /** Edges to create. */
  edges?: Array<{
    type: string;
    direction: 'out' | 'in';
    targetRid?: string;
    targetQuery?: { vertexType: string; where: Record<string, unknown> };
    properties?: Record<string, unknown>;
  }>;
  /** Skip extraction for this item. */
  skipExtraction?: boolean;
  /** Importance (0-1). */
  importance?: number;
}

// ---------------------------------------------------------------------------
// Job Status Types
// ---------------------------------------------------------------------------

/** Status of a background job. */
export interface JobStatus {
  /** Unique job identifier. */
  jobId: string;
  /** Current state. */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Progress (0-100). */
  progress: number;
  /** Number of items processed. */
  processed: number;
  /** Total items in the job. */
  total: number;
  /** Timestamp when the job started. */
  startedAt: string;
  /** Timestamp when the job completed/failed. */
  completedAt?: string;
  /** Result data (on completion). */
  result?: Record<string, unknown>;
  /** Error message (on failure). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Extraction Types
// ---------------------------------------------------------------------------

/** Entity type string literal. */
export type EntityType = 'person' | 'project' | 'tool' | 'company' | 'concept';

/** Known entity types. */
export const ENTITY_TYPES: EntityType[] = ['person', 'project', 'tool', 'company', 'concept'];

/** Result of entity/topic extraction from content. */
export interface ExtractionResult {
  topics: string[];
  entities: Array<{ name: string; type: EntityType }>;
  importance: number;
}

// ---------------------------------------------------------------------------
// Graph Types
// ---------------------------------------------------------------------------

/** A vertex in a graph traversal result. */
export interface GraphVertex {
  rid: string;
  type: string;
  properties: Record<string, unknown>;
}

/** An edge in a graph traversal result. */
export interface GraphEdge {
  rid: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SQL Result Types
// ---------------------------------------------------------------------------

/** Result shape returned by the `arcade-query` tool (SELECT statements). */
export interface ArcadeQueryResult {
  success: boolean;
  result?: Array<Record<string, unknown>>;
  error?: string;
}

/** Result shape returned by the `arcade-command` tool (DDL / DML statements). */
export interface ArcadeCommandResult {
  success: boolean;
  result?: Array<Record<string, unknown>>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Convenience Constants (EXPORTED, NOT auto-applied)
// ---------------------------------------------------------------------------

/**
 * Convenience definition for a Topic vertex type.
 * Domain layers include this in their schema registration if they want
 * standard knowledge-graph topics.
 */
export const TOPIC_VERTEX: VertexTypeDef = {
  name: 'Topic',
  properties: {
    name: 'STRING',
    description: 'STRING',
    firstSeen: 'DATETIME',
    lastSeen: 'DATETIME',
    frequency: 'INTEGER',
  },
  indexes: [{ property: 'name', type: 'UNIQUE' }],
};

/**
 * Convenience definition for an Entity vertex type.
 * Domain layers include this in their schema registration if they want
 * standard knowledge-graph entities.
 */
export const ENTITY_VERTEX: VertexTypeDef = {
  name: 'Entity',
  properties: {
    name: 'STRING',
    type: 'STRING',
    description: 'STRING',
    firstSeen: 'DATETIME',
    lastSeen: 'DATETIME',
  },
  indexes: [{ property: 'name,type', type: 'UNIQUE' }],
};

/**
 * Common edge types used by both agent-memory and docs-memory.
 * Domain layers spread these into their edge type arrays.
 */
export const COMMON_EDGE_TYPES: EdgeTypeDef[] = [
  { name: 'HasTopic', properties: { weight: 'DOUBLE' } },
  { name: 'Mentions', properties: { context: 'STRING' } },
  { name: 'RelatedTo', properties: { type: 'STRING', weight: 'DOUBLE', createdAt: 'DATETIME' } },
];

/**
 * Default entity types for extraction.
 * Domain layers pass this to their extraction configuration.
 */
export const DEFAULT_ENTITY_TYPES: string[] = ['person', 'project', 'tool', 'company', 'concept'];

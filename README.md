# graph-ability

General-purpose graph storage and retrieval engine for the [KĀDI](https://kadi.build) framework. Provides N-signal hybrid search, a schema registry, batch ingestion pipeline, background job processing, and full CRUD — all backed by [ArcadeDB](https://arcadedb.com).

## Features

- **15 registered tools** — schema management, store, recall, batch, context, relate, delete, job control, plus 5 passthrough tools (query, command, chat, find, count)
- **N-signal hybrid search** — pluggable signal architecture with semantic, keyword, graph, and structural signals fused via Reciprocal Rank Fusion (RRF)
- **Schema registry** — idempotent DDL: register vertex types, edge types, and indexes once; safe to re-call
- **Batch pipeline** — bulk store with parallel extraction, batched embedding, dedup strategies, and optional background jobs
- **Three deployment modes** — native library, remote broker ability, or standalone CLI
- **Vault-first credentials** — API keys loaded from the `models` vault via `secret-ability`; no `.env` files

## Quick Start

### Install as a KĀDI ability

```bash
kadi install graph-ability
```

### Use as a native library (in-process)

```typescript
import { KadiClient } from '@kadi.build/core';

const client = new KadiClient({ name: 'my-agent', version: '1.0.0' });
const graph = await client.loadNative('graph-ability');

// Register a schema
await graph.invoke('graph-schema-register', {
  name: 'my-schema',
  vertexTypes: [{ name: 'Document', properties: { content: 'STRING', title: 'STRING' } }],
  edgeTypes: [{ name: 'References', properties: { weight: 'DOUBLE' } }],
});

// Store a vertex
const result = await graph.invoke('graph-store', {
  content: 'Graph databases model relationships as first-class citizens.',
  vertexType: 'Document',
  properties: { title: 'Graph Intro' },
});
console.log(result.rid); // e.g. "#12:0"

// Recall with hybrid search
const hits = await graph.invoke('graph-recall', {
  query: 'how do graph databases work?',
  vertexType: 'Document',
});
console.log(hits.results);
```

### Use as a remote ability (via broker)

```typescript
const client = new KadiClient({
  name: 'my-agent',
  version: '1.0.0',
  brokers: { default: { url: 'wss://broker.kadi.build/kadi' } },
});
await client.connect();

// graph-ability must be running on the same broker
const result = await client.invokeRemote('graph-store', {
  content: 'Hello from the broker!',
  vertexType: 'Document',
});
```

### Run standalone (CLI)

```bash
# Broker mode — connect to broker and serve tools
kadi run start

# Or directly
node dist/index.js broker

# STDIO mode (for piped communication)
node dist/index.js stdio
```

## Tools

### `graph-schema-register`

Register a schema definition (vertex types, edge types, indexes) with the graph engine. Applies DDL to ArcadeDB idempotently — safe to call multiple times.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | **yes** | Unique schema name |
| `vertexTypes` | `VertexTypeDef[]` | **yes** | Vertex type definitions |
| `edgeTypes` | `EdgeTypeDef[]` | **yes** | Edge type definitions |
| `entityTypes` | `string[]` | no | Allowed entity types for extraction |
| `database` | `string` | no | Target database (default: from config) |

**Returns:** `{ success, schema, database, vertexTypes, edgeTypes, durationMs }`

---

### `graph-schema-list`

List all registered graph schemas and their definitions.

*No parameters.*

**Returns:** `{ schemas: [...], count }`

---

### `graph-store`

Store a vertex in the graph with automatic entity extraction, embedding, and graph linking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | **yes** | Text content to store |
| `vertexType` | `string` | **yes** | Vertex type name (e.g. `Memory`, `Document`) |
| `properties` | `Record<string, unknown>` | no | Additional vertex properties |
| `topics` | `string[]` | no | Explicit topics (skips LLM extraction) |
| `entities` | `{name, type}[]` | no | Explicit entities (skips LLM extraction) |
| `edges` | `{type, direction, targetRid?, targetQuery?, properties?}[]` | no | Edges to create |
| `skipExtraction` | `boolean` | no | Skip LLM extraction entirely |
| `importance` | `number` | no | Importance score 0–1 |
| `embedding` | `{model?, transport?, apiUrl?, apiKey?}` | no | Override embedding config |
| `database` | `string` | no | Target database |

**Returns:** `{ stored, rid, vertexType, topics, entities, importance, embeddingDimensions, durationMs }`

**Pipeline:** extract metadata → embed content → create vertex → upsert Topics/Entities → create edges.

---

### `graph-recall`

Search the graph using N-signal hybrid recall.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | **yes** | Search query |
| `vertexType` | `string` | **yes** | Vertex type to search |
| `mode` | `'semantic' \| 'keyword' \| 'graph' \| 'hybrid'` | no | Search mode (default: `hybrid`) |
| `signals` | `string[]` | no | Signals for hybrid (default: `['semantic','keyword','graph']`) |
| `structuralEdges` | `string[]` | no | Edge types for structural signal |
| `structuralDepth` | `number` | no | Expansion hops (default: 1) |
| `structuralTopK` | `number` | no | Expand from top N (default: 5) |
| `filters` | `Record<string, unknown>` | no | Additional WHERE filters |
| `limit` | `number` | no | Max results (default: 10) |
| `embedding` | `{model?, transport?, apiUrl?, apiKey?}` | no | Override embedding config |
| `database` | `string` | no | Target database |

**Returns:** `{ results: SignalResult[], count, mode, signals }`

---

### `graph-batch-store`

Bulk store multiple items with batched embedding and parallel extraction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `BatchItem[]` | **yes** | Items to store |
| `vertexType` | `string` | no | Default vertex type for all items |
| `background` | `boolean` | no | Run as background job (default: false) |
| `concurrency` | `number` | no | Parallel extraction workers (default: 5) |
| `batchSize` | `number` | no | Embedding batch size (default: 100) |
| `onDuplicate` | `'skip' \| 'replace' \| 'error'` | no | Dedup strategy (default: `error`) |
| `deduplicateBy` | `string[]` | no | Properties for duplicate detection |
| `database` | `string` | no | Target database |

**Returns (foreground):** `{ stored, skipped, failed, errors, durationMs }`
**Returns (background):** `{ jobId, status: 'running', total }`

---

### `graph-context`

Recall vertices then expand via graph traversal for richer context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | **yes** | Search query |
| `vertexType` | `string` | **yes** | Vertex type to search |
| `depth` | `number` | no | Traversal depth (default: 1, max: 4) |
| `limit` | `number` | no | Max recalled results to expand (default: 5) |
| `filters` | `Record<string, unknown>` | no | Additional filters |
| `signals` | `string[]` | no | Recall signals |
| `database` | `string` | no | Target database |

**Returns:** `{ results: [...{ neighbors, edges }], count, depth }`

---

### `graph-relate`

Create a typed edge between two vertices. Uses `IF NOT EXISTS` to avoid duplicates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `edgeType` | `string` | **yes** | Edge type name |
| `fromRid` | `string` | **yes** | Source vertex RID |
| `toRid` | `string` | **yes** | Target vertex RID |
| `properties` | `Record<string, unknown>` | no | Edge properties |
| `database` | `string` | no | Target database |

**Returns:** `{ success, edgeType, from, to }`

---

### `graph-delete`

Delete a vertex by RID with optional cascade of orphaned Topics/Entities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rid` | `string` | **yes** | Vertex RID to delete |
| `cascade` | `boolean` | no | Delete orphaned Topics/Entities (default: false) |
| `database` | `string` | no | Target database |

**Returns:** `{ success, deleted, orphansDeleted }`

---

### `graph-job-status`

Check progress of a background job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | `string` | **yes** | Job identifier |

**Returns:** `{ success, jobId, status, progress, processed, total, startedAt, completedAt?, result?, error? }`

---

### `graph-job-cancel`

Cancel a running background job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | `string` | **yes** | Job identifier |

**Returns:** `{ success, cancelled, jobId, progress }`

---

### `graph-query`

Execute a read-only SQL query against the graph database. Returns raw result rows. Use for SELECT, MATCH, and TRAVERSE queries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | **yes** | The read-only SQL query to execute |
| `database` | `string` | no | Target database (default: from config) |

**Returns:** `{ success, result: row[] }`

---

### `graph-command`

Execute a write SQL command against the graph database. Use for CREATE, UPDATE, DELETE, and other mutating operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | **yes** | The SQL command to execute |
| `database` | `string` | no | Target database (default: from config) |

**Returns:** `{ success, result }`

---

### `graph-chat`

Send a chat completion request via the model manager. Supports system and user messages with configurable temperature and token limits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | `{role, content}[]` | **yes** | Chat messages to send |
| `model` | `string` | no | Model to use (default: from config) |
| `temperature` | `number` | no | Sampling temperature (default: 0.7) |
| `max_tokens` | `number` | no | Maximum tokens to generate (default: 500) |
| `api_key` | `string` | no | API key override |

**Returns:** `{ success, result }` — result contains the raw chat completion response (e.g. `result.choices[0].message.content`)

> **Note:** The raw LLM response is wrapped in `{ success, result }`. Consumers must access `result.choices[0].message.content` to get the generated text.

---

### `graph-find`

Find vertices by type and optional filter conditions. Returns matching vertices with their properties. Simpler alternative to `graph-query` for common lookups.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vertexType` | `string` | **yes** | Vertex type to search (e.g. `Memory`, `DocNode`) |
| `filters` | `Record<string, unknown>` | no | WHERE conditions as key-value pairs |
| `orderBy` | `string` | no | ORDER BY clause (e.g. `"timestamp DESC"`) |
| `limit` | `number` | no | Max results (default: 100) |
| `fields` | `string[]` | no | Specific fields to return (default: all) |
| `database` | `string` | no | Target database (default: from config) |

**Returns:** `{ success, results: row[], count }`

---

### `graph-count`

Count vertices of a given type with optional filter conditions. Returns the count and optionally grouped counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vertexType` | `string` | **yes** | Vertex type to count (e.g. `Memory`, `DocNode`) |
| `filters` | `Record<string, unknown>` | no | WHERE conditions as key-value pairs |
| `groupBy` | `string` | no | Field to group by for grouped counts |
| `database` | `string` | no | Target database (default: from config) |

**Returns (simple):** `{ success, total }`
**Returns (grouped):** `{ success, total, groups: { [key]: count } }`

## Signal System

The recall engine uses a pluggable, registry-based signal architecture. Each signal implements `SignalImplementation`:

```typescript
interface SignalImplementation {
  name: string;
  requiresPriorResults?: boolean;
  execute(ctx: SignalContext): Promise<SignalResult[]>;
}
```

### Built-in Signals

| Signal | Independent | Strategy |
|--------|------------|----------|
| `semantic` | yes | Embeds query → cosine similarity via `vectorCosineSimilarity()` |
| `keyword` | yes | Stop-word filtered full-text search via `search_fields()` |
| `graph` | yes | Term extraction → MATCH traversal through Topic/Entity edges |
| `structural` | no (dependent) | Expands from prior results via configured edge types |

### Hybrid Recall Pipeline

1. **Partition** signals into independent and dependent
2. **Run independent signals in parallel** (`Promise.all`)
3. **Fuse rankings** via Reciprocal Rank Fusion (RRF, k=60)
4. **Run dependent signals** sequentially with prior results
5. **Re-fuse all rankings**
6. **Importance weighting:** `score × (0.7 + 0.3 × importance)`
7. **Sort descending, apply limit**

### Custom Signals

```typescript
import { registerSignal, type SignalImplementation } from '@kadi.build/graph-ability';

const mySignal: SignalImplementation = {
  name: 'recency',
  execute: async (ctx) => {
    // Custom scoring logic
    return results;
  },
};

registerSignal(mySignal);
```

## Schema Types

### Built-in Vertex Types

**Topic** — extracted discussion topics

| Property | Type |
|----------|------|
| `name` | STRING |
| `description` | STRING |
| `firstSeen` | DATETIME |
| `lastSeen` | DATETIME |
| `frequency` | INTEGER |

Index: `name` (UNIQUE)

**Entity** — extracted named entities

| Property | Type |
|----------|------|
| `name` | STRING |
| `type` | STRING |
| `description` | STRING |
| `firstSeen` | DATETIME |
| `lastSeen` | DATETIME |

Index: `name,type` (composite UNIQUE)

### Built-in Edge Types

| Edge | Properties | Purpose |
|------|-----------|---------|
| `HasTopic` | `weight: DOUBLE` | Vertex → Topic |
| `Mentions` | `context: STRING` | Vertex → Entity |
| `RelatedTo` | `type: STRING, weight: DOUBLE, createdAt: DATETIME` | Any → Any |

### Default Entity Types

`person`, `project`, `tool`, `company`, `concept`

## Configuration

Settings are resolved in order (highest priority wins):

1. **Environment variables** — `GRAPH_DATABASE`, `MEMORY_API_KEY`, etc.
2. **Vault `"models"`** — `MEMORY_API_KEY`, `MEMORY_API_URL` via `secret-ability`
3. **`config.yml`** — walk-up discovery from CWD (`graph:` section)
4. **Built-in defaults**

### Config Fields

| Field | Env Var | config.yml | Default |
|-------|---------|------------|---------|
| `database` | `GRAPH_DATABASE` / `MEMORY_DATABASE` | `graph.database` | `kadi_memory` |
| `embeddingModel` | `GRAPH_EMBEDDING_MODEL` / `MEMORY_EMBEDDING_MODEL` | `graph.embedding_model` | `text-embedding-3-small` |
| `extractionModel` | `GRAPH_EXTRACTION_MODEL` / `MEMORY_EXTRACTION_MODEL` | `graph.extraction_model` | `gpt-5-nano` |
| `chatModel` | `GRAPH_CHAT_MODEL` / `MEMORY_SUMMARIZATION_MODEL` | `graph.chat_model` | `gpt-5-mini` |
| `defaultAgent` | `GRAPH_DEFAULT_AGENT` / `MEMORY_DEFAULT_AGENT` | `graph.default_agent` | `default` |
| `apiKey` | `MEMORY_API_KEY` | *(vault only)* | — |
| `apiUrl` | `MEMORY_API_URL` | *(vault only)* | — |
| `embeddingTransport` | `GRAPH_EMBEDDING_TRANSPORT` / `MEMORY_EMBEDDING_TRANSPORT` | `graph.embedding_transport` | `api` |
| `chatTransport` | `GRAPH_CHAT_TRANSPORT` / `MEMORY_CHAT_TRANSPORT` | `graph.chat_transport` | `api` |

### Example `config.yml`

```yaml
graph:
  database: kadi_memory
  embedding_model: text-embedding-3-small
  extraction_model: gpt-5-nano
  chat_model: gpt-5-mini
  embedding_transport: api
  chat_transport: api
```

> **Credentials** (`MEMORY_API_KEY`, `MEMORY_API_URL`) are loaded from the `models` vault — never put them in `config.yml`.

### Setting up the vault

```bash
kadi secret set --vault models --key MEMORY_API_KEY --value "sk-..."
kadi secret set --vault models --key MEMORY_API_URL --value "https://api.openai.com"
```

## Library Exports

When used as a native library (`loadNative` or direct import), graph-ability exports its full internals:

### Functions

| Export | Description |
|--------|-------------|
| `loadGraphConfig()` | Sync config (no vault) |
| `loadGraphConfigWithVault(client)` | Async config with vault credentials |
| `embedTexts(texts, config, abilities)` | Generate embeddings |
| `chatCompletion(params, config, abilities)` | LLM chat completion |
| `extractMetadata(content, config, abilities)` | Extract topics, entities, importance |
| `hybridRecall(request, abilities)` | Run the full signal pipeline |
| `registerSignal(signal)` | Add a custom signal |
| `getSignal(name)` / `listSignals()` / `clearSignals()` | Signal registry management |
| `createVertex(...)` / `updateVertex(...)` / `deleteVertex(...)` | Direct vertex CRUD |
| `createEdge(...)` | Direct edge creation |
| `upsertTopic(...)` / `upsertEntity(...)` | Upsert graph nodes |
| `traverseGraph(...)` / `findOrphans(...)` / `queryVertices(...)` | Graph queries |
| `extractRid(result)` / `filterSystemProps(vertex)` | Utilities |
| `escapeSQL(str)` / `sanitizeInt(n)` | SQL safety |
| `reciprocalRankFusion(rankings, k)` | RRF fusion |
| `invokeWithRetry(fn, policy)` | Retry with backoff |
| `SchemaRegistry` / `schemaRegistry` | Schema registry singleton |
| `JobManager` / `jobManager` | Background job manager |
| `buildKeywordQuery(query)` / `STOP_WORDS` | Keyword filter utilities |

### Types

`SchemaDefinition`, `VertexTypeDef`, `EdgeTypeDef`, `IndexDef`, `VertexField`, `GraphConfig`, `Transport`, `RetryPolicy`, `SignalResult`, `SignalContext`, `SignalAbilities`, `SignalImplementation`, `EmbeddingSignalConfig`, `RecallRequest`, `StoreRequest`, `BatchItem`, `JobStatus`, `EntityType`, `ExtractionResult`, `GraphVertex`, `GraphEdge`, `ArcadeQueryResult`, `ArcadeCommandResult`, `EmbedResult`, `EmbeddingConfig`, `ChatChoice`, `ChatCompletionResponse`, `ChatConfig`, `ChatCompletionParams`, `RankedItem`, `ScoredItem`

### Constants

`TOPIC_VERTEX`, `ENTITY_VERTEX`, `COMMON_EDGE_TYPES`, `DEFAULT_ENTITY_TYPES`, `ENTITY_TYPES`

## Deployment

### Dependencies

- **Runtime:** [ArcadeDB](https://arcadedb.com) (graph database)
- **Broker services:** `arcadedb-ability` (provides `arcade-command`, `arcade-query`), `model-manager` (provides `create-embedding`, `chat-completion`)
- **Vault:** `secret-ability` for credential management

### agent.json

```json
{
  "name": "graph-ability",
  "version": "0.0.5",
  "type": "ability",
  "entrypoint": "dist/index.js",
  "abilities": {
    "secret-ability": "^0.9.1"
  },
  "brokers": {
    "default": "wss://broker.kadi.build/kadi"
  }
}
```

### Docker build & deploy

```bash
# Build the container
kadi build

# Deploy locally
kadi deploy local

# Deploy to Akash
kadi deploy akash
```

The container image receives vault secrets at startup via `kadi secret receive --vault models` before running `kadi run start`.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests (requires infra)
npm run test:integration

# Dev mode (tsx)
npm run dev
```

### Project Structure

```
graph-ability/
├── agent.json              # KĀDI ability manifest
├── config.yml              # Default configuration
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts            # Entry point — top-level await init + exports
│   ├── lib/
│   │   ├── config.ts       # Config resolution (env → vault → yml → defaults)
│   │   ├── graph.ts        # ArcadeDB vertex/edge CRUD
│   │   ├── embedder.ts     # Embedding generation
│   │   ├── chat.ts         # LLM chat completion
│   │   ├── extractor.ts    # Topic/entity/importance extraction
│   │   ├── keyword-filter.ts
│   │   ├── sql.ts          # SQL escaping utilities
│   │   ├── rrf.ts          # Reciprocal Rank Fusion
│   │   ├── retry.ts        # Retry with exponential backoff
│   │   ├── schema-registry.ts
│   │   ├── job-manager.ts  # Background job lifecycle
│   │   ├── types.ts        # Type definitions + constants
│   │   └── signals/
│   │       ├── index.ts    # Signal registry + hybridRecall orchestrator
│   │       ├── semantic.ts
│   │       ├── keyword.ts
│   │       ├── graph.ts
│   │       └── structural.ts
│   └── tools/
│       ├── schema-register.ts
│       ├── schema-list.ts
│       ├── store.ts
│       ├── recall.ts
│       ├── batch-store.ts
│       ├── context.ts
│       ├── relate.ts
│       ├── delete.ts
│       ├── job-status.ts
│       ├── job-cancel.ts
│       ├── query.ts          # graph-query — read-only SQL passthrough
│       ├── command.ts        # graph-command — write SQL passthrough
│       ├── chat.ts           # graph-chat — chat completion passthrough
│       ├── find.ts           # graph-find — structured vertex lookup
│       └── count.ts          # graph-count — vertex counting
└── tests/
    ├── unit/
    └── integration/
```

## License

Proprietary — [HuMIn Game Lab](https://humingamelab.com)

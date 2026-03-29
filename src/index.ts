/**
 * graph-ability — General-purpose graph storage and retrieval engine with
 * N-signal hybrid search, schema registry, batch pipeline, and background
 * processing.
 *
 * Supports three deployment modes:
 *   1. Native library  — `loadNative('graph-ability')` → tools available in-process
 *   2. Remote library   — `invokeRemote('graph-store', ...)` via broker
 *   3. CLI `kadi run`   — connects to broker and serves tools to other agents
 *
 * Credentials are loaded from the "models" vault via secret-ability at startup.
 * No .env files — uses vault → config.yml → built-in defaults.
 *
 * 16 tools registered:
 *   graph-schema-register, graph-schema-list, graph-store, graph-recall,
 *   graph-batch-store, graph-context, graph-relate, graph-delete,
 *   graph-job-status, graph-job-cancel, graph-query, graph-command,
 *   graph-chat, graph-find, graph-count, graph-repair-embeddings
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { KadiClient } from '@kadi.build/core';

import { loadGraphConfigWithVault, type GraphConfig } from './lib/config.js';
import { registerSchemaRegisterTool } from './tools/schema-register.js';
import { registerSchemaListTool } from './tools/schema-list.js';
import { registerStoreTool } from './tools/store.js';
import { registerRecallTool } from './tools/recall.js';
import { registerBatchStoreTool } from './tools/batch-store.js';
import { registerContextTool } from './tools/context.js';
import { registerRelateTool } from './tools/relate.js';
import { registerDeleteTool } from './tools/delete.js';
import { registerJobStatusTool } from './tools/job-status.js';
import { registerJobCancelTool } from './tools/job-cancel.js';
import { registerQueryTool } from './tools/query.js';
import { registerCommandTool } from './tools/command.js';
import { registerChatTool } from './tools/chat.js';
import { registerFindTool } from './tools/find.js';
import { registerCountTool } from './tools/count.js';
import { registerRepairEmbeddingsTool } from './tools/repair-embeddings.js';

// ── Read broker config from agent.json ────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadAgentJson(): Record<string, any> {
  let dir = __dirname;
  while (true) {
    try {
      const candidate = join(dir, 'agent.json');
      const content = readFileSync(candidate, 'utf8');
      return JSON.parse(content);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {};
}

function resolveBrokerUrl(): string {
  if (process.env.BROKER_URL) return process.env.BROKER_URL;

  const agent = loadAgentJson();
  const brokers = agent.brokers ?? {};

  // Prefer remote → default (legacy) → local
  for (const key of ['remote', 'default', 'local']) {
    const entry = brokers[key];
    if (typeof entry === 'string') return entry;
    if (entry?.url) return entry.url;
  }

  return 'ws://localhost:8080/kadi';
}

// ── Build the client ──────────────────────────────────────────────────

const brokerUrl = resolveBrokerUrl();
const agentJson = loadAgentJson();

const client = new KadiClient({
  name: agentJson.name ?? 'graph-ability',
  version: agentJson.version ?? '1.0.0',
  brokers: {
    default: { url: brokerUrl },
  },
});

// ── Async initialization (top-level await) ────────────────────────────
//
// Loads credentials from vault via secret-ability, connects to broker,
// then registers all tools.
// By the time `import()` resolves (for native consumers) or `kadi run`
// starts serving, all 10 tools are fully configured and registered.

const config: GraphConfig = await loadGraphConfigWithVault(client);

// Connect to broker — graph-ability's tools need arcade-command, arcade-query,
// create-embedding, and chat-completion from remote broker agents.
// This connection is needed regardless of deployment mode (native, broker, CLI).
try {
  await client.connect();
  console.log(`[graph-ability] Connected to broker: ${brokerUrl}`);
} catch (err: any) {
  console.warn(
    '[graph-ability] Broker connection failed (remote tools will be unavailable):',
    err?.message ?? err,
  );
}

registerSchemaRegisterTool(client, config);
registerSchemaListTool(client, config);
registerStoreTool(client, config);
registerRecallTool(client, config);
registerBatchStoreTool(client, config);
registerContextTool(client, config);
registerRelateTool(client, config);
registerDeleteTool(client, config);
registerJobStatusTool(client, config);
registerJobCancelTool(client, config);
registerQueryTool(client, config);
registerCommandTool(client, config);
registerChatTool(client, config);
registerFindTool(client, config);
registerCountTool(client, config);
registerRepairEmbeddingsTool(client, config);

console.log('[graph-ability] 16 tools registered');

// ── CLI entry point (kadi run / direct execution) ─────────────────────
//
// When run directly (not imported as a library), connect to broker and serve.
// Supports: `kadi run` (broker mode) or `node dist/index.js stdio`

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const mode = process.argv.includes('stdio') ? 'stdio' : 'broker';
  console.log(`[graph-ability] Starting in ${mode} mode → ${brokerUrl}`);

  if (mode === 'stdio') {
    client.serve('stdio').catch((err: Error) => {
      console.error('[graph-ability] Serve failed:', err.message);
      process.exit(1);
    });
  } else {
    // Broker mode — already connected at init, just stay alive
    console.log('[graph-ability] Serving via broker.');
    await new Promise(() => {}); // keep process alive
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────

function forceExit(): void {
  console.log('[graph-ability] Shutting down…');
  client.disconnect?.().catch(() => {});
  setTimeout(() => {
    console.log('[graph-ability] Force exit');
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', forceExit);
process.on('SIGTERM', forceExit);

// ── Default + library exports ─────────────────────────────────────────

export default client;

// ── Library exports for native consumers ──────────────────────────────

export { SchemaRegistry, schemaRegistry } from './lib/schema-registry.js';
export { invokeWithRetry, withRetry, DEFAULT_RETRY_POLICIES, isRetryableError } from './lib/retry.js';
export { reciprocalRankFusion } from './lib/rrf.js';
export { escapeSQL, sanitizeInt, buildFilterConditions } from './lib/sql.js';
export { embedTexts } from './lib/embedder.js';
export { chatCompletion } from './lib/chat.js';
export { extractMetadata } from './lib/extractor.js';
export { buildKeywordQuery, STOP_WORDS } from './lib/keyword-filter.js';
export {
  upsertTopic,
  upsertEntity,
  createVertex,
  updateVertex,
  deleteVertex,
  createEdge,
  traverseGraph,
  findOrphans,
  getVertexTopics,
  getVertexEntities,
  queryVertices,
  extractRid,
  filterSystemProps,
} from './lib/graph.js';
export { loadGraphConfig, loadGraphConfigWithVault } from './lib/config.js';
export { hybridRecall, registerSignal, getSignal, listSignals, clearSignals } from './lib/signals/index.js';
export type { SignalImplementation } from './lib/signals/index.js';
export { JobManager, jobManager } from './lib/job-manager.js';

export {
  TOPIC_VERTEX,
  ENTITY_VERTEX,
  COMMON_EDGE_TYPES,
  DEFAULT_ENTITY_TYPES,
  ENTITY_TYPES,
} from './lib/types.js';

export type {
  SchemaDefinition,
  VertexTypeDef,
  EdgeTypeDef,
  IndexDef,
  VertexField,
  RetryPolicy,
  SignalResult,
  SignalContext,
  SignalAbilities,
  EmbeddingSignalConfig,
  RecallRequest,
  StoreRequest,
  BatchItem,
  JobStatus,
  EntityType,
  ExtractionResult,
  GraphVertex,
  GraphEdge,
  ArcadeQueryResult,
  ArcadeCommandResult,
} from './lib/types.js';

export type { GraphConfig, Transport } from './lib/config.js';
export type { EmbedResult, EmbeddingConfig } from './lib/embedder.js';
export type {
  ChatChoice,
  ChatCompletionResponse,
  ChatConfig,
  ChatCompletionParams,
} from './lib/chat.js';
export type { RankedItem, ScoredItem } from './lib/rrf.js';

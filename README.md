# ability-graph
> General-purpose graph storage and retrieval engine with N-signal hybrid search, schema registry, batch pipeline, and background processing.

Overview
--------
ability-graph (graph-ability) is a Kadi ability that provides a general-purpose graph storage and retrieval engine. Features include:
- N-signal hybrid recall (semantic + keyword + structural signals)
- Schema registry for vertex/edge types and indexes
- Batch ingestion pipeline with batched embedding and parallel extraction
- Background job processing (status, cancel, repair)
- Automatic entity extraction, embedding, and schema validation on store
- Deployable as an in-process native library, remote library via broker, or CLI (kadi run)

The package entrypoint is dist/index.js. Credentials are loaded from the "model-manager" vault via secret-ability at startup (delivered via broker). Configuration resolution follows: vault → config.toml → built-in defaults. The agent connects to a broker (resolved from BROKER_URL env or agent.json brokers) and registers a set of tools that other agents can invoke.

Quick Start
-----------
1. Install dependencies
npm install

2. Install Kadi CLI tools required by the container/build
kadi install

(If you need specific helper packages in your environment, the build uses:)
kadi install kadi-install
kadi install kadi-run
kadi install kadi-secret

3. Ensure secrets are available (local broker mode)
kadi secret receive --vault model-manager

4. Start the ability (connects to broker and serves tools)
kadi run start

Notes:
- You can override the broker URL with the environment variable BROKER_URL (e.g. export BROKER_URL=ws://localhost:8080/kadi).
- The agent.json includes scripts and a start command that maps to node dist/index.js broker when run in a container or when invoked via npm scripts.

Tools
-----
| Tool | Description |
|---|---|
| graph-schema-register | Register a schema definition (vertex types, edge types, indexes) with the graph engine. |
| graph-schema-list | List all registered graph schemas and their definitions. |
| graph-store | Store a vertex in the graph with automatic entity extraction, embedding, and schema validation. |
| graph-recall | Search the graph using N-signal hybrid recall. Supports semantic, keyword, and structural signals. |
| graph-batch-store | Bulk store multiple items with batched embedding and parallel extraction. |
| graph-context | Recall vertices then expand via graph traversal for richer context. |
| graph-relate | Create a typed edge between two vertices. Uses IF NOT EXISTS to avoid duplicates. |
| graph-delete | Delete a vertex by RID. Optionally cascade-delete orphaned Topic/Entity nodes. |
| graph-job-status | Check the status and progress of a background job. |
| graph-job-cancel | Cancel a running background job. |
| graph-query | Execute a read-only SQL query against the graph database. Returns raw result rows. |
| graph-command | Execute a write SQL command against the graph database. Use for CREATE, UPDATE, DELETE operations. |
| graph-chat | Send a chat completion request via the model manager. Supports system and user messages. |
| graph-find | Find vertices by type and optional filter conditions. Returns matching vertices. |
| graph-count | Count vertices of a given type with optional filter conditions. Returns the count. |
| graph-repair-embeddings | Find vertices with missing embedding vectors and re-embed them. |
| graph-index | Index content by chunking, embedding, and storing each chunk as a vertex. |
| graph-index-file | Read a file from disk and index its content via graph-index. |

Configuration
-------------
Primary configuration sources and files
- agent.json — package metadata and runtime/build/deploy configuration. Key fields used:
  - name, version, entrypoint (dist/index.js)
  - abilities: declares dependency on secret-ability
  - brokers: configured broker URLs (local and remote)
  - scripts.setup and scripts.start for local/container start flows
  - build.default (image, from, platform, run, cmd)
  - deploy.local (target, engine, services.agent.command, secrets)

- Vault (model-manager) — credentials and model/service keys are retrieved via secret-ability at startup. The package expects the "model-manager" vault to include the required secrets delivered via broker in deploy configurations.

- config.toml — runtime configuration (broker sections, graph settings such as database, embedding/extraction/chat models, transports, etc.). See config.toml in the repository for defaults.

Environment variables
- BROKER_URL — overrides the broker URL resolved from agent.json. If unset, agent.json brokers are used; fallback to ws://localhost:8080/kadi.

Secrets required in deploy.local (as declared in agent.json.deploy.local.secrets.required)
- MODEL_MANAGER_BASE_URL
- MODEL_MANAGER_API_KEY

Config loader
- loadGraphConfigWithVault(client) (implemented in src/lib/config.ts, compiled to dist/lib/config.js) loads runtime GraphConfig via the secret-ability vault, then falls back to config.toml and built-in defaults. No .env files are used.

Relevant file paths
- agent.json — agent metadata and runtime instructions
- src/index.ts — top-level bootstrap and tool registration
- src/lib/config.ts — graph configuration loader (compiled to dist/lib/config.js)
- src/tools/*.ts — individual tool registration implementations (compiled to dist/tools/*.js)
- dist/index.js — built artifact entrypoint used at runtime

Architecture
------------
High-level data flow and components:
- Bootstrap
  - At startup, src/index.ts resolves the broker URL (BROKER_URL env or agent.json), constructs a KadiClient, and invokes loadGraphConfigWithVault(client) to fetch credentials from the vault via secret-ability.
  - After configuration and credentials are available, the agent connects to the broker and registers all tools.

- KadiClient
  - The KadiClient (from @kadi.build/core) manages the WebSocket connection to a broker and exposes the ability to register tools and invoke remote tools/services.
  - The agent registers each tool using registerXTool(...) functions in src/tools/*.ts.

- Tool layer
  - Tools are small vertically-scoped handlers that expose graph operations (store, recall, schema management, job control, queries, etc.). Each tool may itself call remote services on the broker (for example embedding creation, model manager chat) to perform heavy-lifting (DB queries, model invocations, embedding creation).
  - Tools interact with:
    - Schema registry (schema-register / schema-list)
    - Ingestion pipeline (store, batch-store, index) which performs entity extraction, chunking, and embedding
    - Recall engine (graph-recall, graph-context) which uses hybrid signals
    - Background jobs (job-status, job-cancel, repair-embeddings)

- Storage and embeddings
  - The graph engine stores vertices and edges (types defined by schema registry). Embeddings are produced by model services (via broker) and stored alongside vertices for semantic retrieval.
  - The batch pipeline coordinates batched embedding calls and parallel extraction tasks.

- Background processing
  - Long-running tasks (re-embedding, batch ingest) are scheduled as background jobs with status and cancel controls exposed by graph-job-status and graph-job-cancel.

Deployment modes
- Native library: loadNative('graph-ability') — consumes tools in-process.
- Remote library: invokeRemote('graph-store', ...) via broker — tools executed via a brokered agent.
- CLI mode: kadi run — connects to broker and serves tools to other agents. The Docker deploy configuration in agent.json runs: kadi secret receive --vault model-manager && kadi run start

Development
-----------
Get the code and build
1. Install dependencies and build artifacts (uses scripts defined in agent.json)
npm run setup

2. Start locally for development (assumes broker available or set BROKER_URL)
export BROKER_URL=ws://localhost:8080/kadi
kadi secret receive --vault model-manager
kadi run start

Notes on editing and structure
- Source: TypeScript in src/ ; entry bootstrap is src/index.ts
- Tool implementations: src/tools/*.ts (compiled to dist/tools/*.js)
- Config loader: src/lib
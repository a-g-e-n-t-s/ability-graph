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

The package entrypoint is dist/index.js. Credentials are loaded from the "models" vault via secret-ability at startup. Configuration resolution follows: vault → config.yml → built-in defaults. The agent connects to a broker (default wss://broker.kadi.build/kadi) and registers a set of tools that other agents can invoke.

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
kadi secret receive --vault models

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

Configuration
-------------
Primary configuration sources and files
- agent.json — package metadata and runtime/build/deploy configuration. Key fields used:
  - name, version, entrypoint (dist/index.js)
  - abilities: declares dependency on secret-ability
  - brokers: default broker URLs (wss://broker.kadi.build/kadi, ws://localhost:8080/kadi)
  - scripts.setup and scripts.start for local/container start flows
  - build.default (image, from, platform, run, cmd)
  - deploy.local (target, engine, services.agent.command, secrets)

- Vault (models) — credentials and model/service keys are retrieved via secret-ability at startup. The package expects the "models" vault to include the required secrets delivered via broker in deploy configurations.

Environment variables
- BROKER_URL — overrides the broker URL resolved from agent.json. If unset, agent.json brokers.default is used; fallback to ws://localhost:8080/kadi.

Secrets required in deploy.local (as declared in agent.json.deploy.local.secrets.required)
- MEMORY_API_KEY
- MEMORY_API_URL

Config loader
- loadGraphConfigWithVault(client) (implemented in src/lib/config.js) loads runtime GraphConfig via the secret-ability vault, then falls back to config.yml and built-in defaults. No .env files are used.

Relevant file paths
- agent.json — agent metadata and runtime instructions
- src/index.ts — top-level bootstrap and tool registration
- src/lib/config.js — graph configuration loader
- src/tools/*.js — individual tool registration implementations (schema-register.js, schema-list.js, store.js, recall.js, etc.)
- dist/index.js — built artifact entrypoint used at runtime

Architecture
------------
High-level data flow and components:
- Bootstrap
  - At startup, src/index.ts resolves the broker URL (BROKER_URL env or agent.json), constructs a KadiClient, and invokes loadGraphConfigWithVault(client) to fetch credentials from the "models" vault via secret-ability.
  - After configuration and credentials are available, the agent connects to the broker and registers all tools.

- KadiClient
  - The KadiClient (from @kadi.build/core) manages the WebSocket connection to a broker and exposes the ability to register tools and invoke remote tools/services.
  - The agent registers each tool using registerXTool(...) functions in src/tools/*.js.

- Tool layer
  - Tools are small vertically-scoped handlers that expose graph operations (store, recall, schema management, job control, queries, etc.). Each tool may itself call remote services on the broker (for example arcade-command, arcade-query, create-embedding, chat-completion) to perform heavy-lifting (DB queries, model invocations, embedding creation).
  - Tools interact with:
    - Schema registry (schema-register / schema-list)
    - Ingestion pipeline (store, batch-store) which performs entity extraction and embedding
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
- CLI mode: kadi run — connects to broker and serves tools to other agents. The Docker deploy configuration in agent.json runs: kadi secret receive --vault models && kadi run start

Development
-----------
Get the code and build
1. Install dependencies and build artifacts (uses scripts defined in agent.json)
npm run setup

2. Start locally for development (assumes broker available or set BROKER_URL)
export BROKER_URL=ws://localhost:8080/kadi
kadi secret receive --vault models
kadi run start

Notes on editing and structure
- Source: TypeScript in src/ ; entry bootstrap is src/index.ts
- Tool implementations: src/tools/*.ts (compiled to dist/tools/*.js)
- Config loader: src/lib/config.ts (compiled to dist/lib/config.js)
- Entrypoint at runtime: dist/index.js

Testing and linting
- Unit tests (dev dependency): vitest. Run tests with:
npx vitest

Container / image build
- agent.json.build.default describes the image build process. The build step runs:
  - npm ci
  - npm run build
  - kadi install kadi-install
  - kadi install kadi-run
  - kadi install kadi-secret
  - kadi install
- Runtime command in container uses kadi run start.

Troubleshooting
- If tools are not available to other agents, verify the KadiClient connected to the correct broker (check BROKER_URL or agent.json brokers).
- If model/embedding calls fail, confirm the "models" vault secrets (MEMORY_API_KEY, MEMORY_API_URL) are present and delivered via broker.
- For local development, run a local Kadi broker at ws://localhost:8080/kadi and use kadi secret receive --vault models to populate secrets.

License and contribution
- See agent.json for package metadata. Follow your organization’s contribution guidelines for code and pull requests.
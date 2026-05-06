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
- Deployable as a native library, remote broker ability, or CLI (kadi run)

The package entrypoint is dist/index.js. Credentials are loaded via secret-ability from the configured vault (the repository deploy config uses the "model-manager" vault). Configuration resolution follows: vault → config.toml → built-in defaults. The agent resolves the broker URL from the BROKER_URL environment variable (if set) or from agent.json brokers, connects to the broker, and registers a set of tools that other agents can invoke.

Quick Start
-----------
1. Install dependencies
npm install

2. Install Kadi CLI tools required by the container/build (the build and image expect these)
kadi install kadi-install
kadi install kadi-run
kadi install kadi-secret
kadi install

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
| graph-schema-list | List registered schemas and versions. |
| graph-store | Store a vertex with automatic entity extraction, embedding, and schema validation. |
| graph-recall | Recall vertices using N-signal hybrid search (semantic + keyword + structural). |
| graph-batch-store | Bulk store multiple items with batched embedding and parallel extraction. |
| graph-context | Recall vertices then expand via graph traversal to build richer context. |
| graph-relate | Create relations/edges between vertices. |
| graph-delete | Delete a vertex by RID. Optionally cascade-delete orphaned Topic/Entity nodes. |
| graph-job-status | Query background job status (ingest, embedding, other jobs). |
| graph-job-cancel | Cancel a running background job. |
| graph-query | Execute read queries against the graph database. |
| graph-command | Execute a write SQL command against the graph database (CREATE, UPDATE, DELETE, migrations). |
| graph-chat | Send a chat completion request via the model manager (supports system and user messages). |
| graph-find | Find vertices by type with optional filter conditions; returns matching vertices. |
| graph-count | Count vertices of a given type with optional filters; returns the count. |
| graph-repair-embeddings | Repair or recompute embeddings for vertices with missing or stale embeddings. |
| graph-index | Index content by chunking, embedding, and storing each chunk as a vertex. |
| graph-index-file | Read a file from disk and index its content via graph-index. |

Notes and Implementation Details
-------------------------------
- Entrypoint: dist/index.js
- The agent resolves the broker URL by checking BROKER_URL, then agent.json brokers (prefers remote → default → local), and falls back to ws://localhost:8080/kadi.
- The build image and container configuration (agent.json) install required kadi CLI helpers and run kadi run start in the container.
- Configuration example is in config.toml at the repo root (graph database name, embedding/extraction/chat models, transports, and broker definitions).
- The agent registers all tools at startup after loading credentials from the configured vault via secret-ability.

If you need more details about a specific tool or configuration entry, open the corresponding file under src/tools/ (for example src/tools/store.ts, src/tools/index.ts) or refer to config.toml for runtime defaults.
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

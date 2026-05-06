/**
 * Explorer HTTP server.
 *
 * Uses Node's built-in `http` module (zero external dependencies).
 * Serves the SPA at `GET /` and JSON API endpoints for graph exploration.
 *
 * The HTML file is read once at startup and cached in memory.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { ExplorerConfig } from './config.js';
import type { ExplorerContext } from './api.js';
import {
  handleDatabases,
  handleSchema,
  handleStats,
  handleQuery,
  handleCommand,
  handleTraverse,
  handleNeighbors,
  handleSearch,
  handleRegisteredSchemas,
  handleTemplates,
  handleEmbed,
  handleSimilar,
  handleProjection,
  handleRefreshProjection,
  handleBrokerAgents,
  handleTypeProperties,
} from './api.js';
import type { SignalAbilities } from '../lib/types.js';
import type { GraphConfig } from '../lib/config.js';
import type { KadiClient } from '@kadi.build/core';

// ---------------------------------------------------------------------------
// Module-level __dirname for ESM
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse JSON body from an incoming request.
 */
function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

/**
 * Send an HTML response.
 */
function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the Graph Explorer HTTP server.
 *
 * @param explorerConfig - Explorer-specific config (port, host, enabled).
 * @param abilities      - SignalAbilities for invoking remote tools.
 * @param graphConfig    - Resolved GraphConfig (database, models, secrets).
 * @param client         - KadiClient instance.
 * @returns The HTTP server instance (for testing — call `.close()` to stop).
 */
export function startExplorerServer(
  explorerConfig: ExplorerConfig,
  abilities: SignalAbilities,
  graphConfig: GraphConfig,
  client: KadiClient,
): Server {
  // Read the HTML file once at startup
  let cachedHtml: string;
  try {
    cachedHtml = readFileSync(join(__dirname, 'explorer.html'), 'utf8');
  } catch {
    // In development (ts source), the HTML may be in the src directory
    try {
      cachedHtml = readFileSync(
        join(__dirname, '..', '..', 'src', 'explorer', 'explorer.html'),
        'utf8',
      );
    } catch {
      cachedHtml = '<html><body><h1>Graph Explorer</h1><p>explorer.html not found</p></body></html>';
    }
  }

  const ctx: ExplorerContext = { abilities, graphConfig, client };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase() ?? 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    try {
      // GET / → serve cached HTML
      if (method === 'GET' && pathname === '/') {
        sendHtml(res, cachedHtml);
        return;
      }

      // GET /api/databases
      if (method === 'GET' && pathname === '/api/databases') {
        const result = await handleDatabases(ctx);
        sendJson(res, 200, result);
        return;
      }

      // GET /api/schema/:db
      const schemaMatch = pathname.match(/^\/api\/schema\/([^/]+)$/);
      if (method === 'GET' && schemaMatch) {
        const db = decodeURIComponent(schemaMatch[1]);
        const result = await handleSchema(ctx, db);
        sendJson(res, 200, result);
        return;
      }

      // GET /api/stats/:db
      const statsMatch = pathname.match(/^\/api\/stats\/([^/]+)$/);
      if (method === 'GET' && statsMatch) {
        const db = decodeURIComponent(statsMatch[1]);
        const result = await handleStats(ctx, db);
        sendJson(res, 200, result);
        return;
      }

      // GET /api/schemas
      if (method === 'GET' && pathname === '/api/schemas') {
        const result = await handleRegisteredSchemas(ctx);
        sendJson(res, 200, result);
        return;
      }

      // GET /api/templates or /api/templates/:schema
      if (method === 'GET' && pathname === '/api/templates') {
        const result = handleTemplates(ctx);
        sendJson(res, 200, result);
        return;
      }
      const templatesMatch = pathname.match(/^\/api\/templates\/([^/]+)$/);
      if (method === 'GET' && templatesMatch) {
        const schema = decodeURIComponent(templatesMatch[1]);
        const result = handleTemplates(ctx, schema);
        sendJson(res, 200, result);
        return;
      }

      // POST /api/query
      if (method === 'POST' && pathname === '/api/query') {
        const body = await parseJsonBody(req);
        const result = await handleQuery(ctx, body as {
          database: string;
          query: string;
          language?: string;
        });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/command
      if (method === 'POST' && pathname === '/api/command') {
        const body = await parseJsonBody(req);
        const result = await handleCommand(ctx, body as {
          database: string;
          command: string;
          language?: string;
        });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/traverse
      if (method === 'POST' && pathname === '/api/traverse') {
        const body = await parseJsonBody(req);
        const result = await handleTraverse(ctx, body as {
          database: string;
          startRid: string;
          depth: number;
          filters?: Record<string, unknown>;
        });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/neighbors
      if (method === 'POST' && pathname === '/api/neighbors') {
        const body = await parseJsonBody(req);
        const result = await handleNeighbors(ctx, body as {
          database: string;
          rid: string;
          edgeTypes?: string[];
          direction?: 'both' | 'in' | 'out';
        });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/search
      if (method === 'POST' && pathname === '/api/search') {
        const body = await parseJsonBody(req);
        const result = await handleSearch(ctx, body as {
          database: string;
          query: string;
          vertexType: string;
          mode?: string;
          signals?: string[];
          limit?: number;
        });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/embed
      if (method === 'POST' && pathname === '/api/embed') {
        const body = await parseJsonBody(req);
        const result = await handleEmbed(ctx, body as { text: string });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/type-properties
      if (method === 'POST' && pathname === '/api/type-properties') {
        const body = await parseJsonBody(req);
        const result = await handleTypeProperties(ctx, body as { database: string; types: string[] });
        sendJson(res, 200, result);
        return;
      }

      // POST /api/similar
      if (method === 'POST' && pathname === '/api/similar') {
        const body = await parseJsonBody(req);
        const result = await handleSimilar(ctx, body as {
          database: string;
          vertexType: string;
          text?: string;
          embedding?: number[];
          limit?: number;
        });
        sendJson(res, 200, result);
        return;
      }

      // GET/POST /api/projection/:db/:type
      const projectionMatch = pathname.match(/^\/api\/projection\/([^/]+)\/([^/]+)$/);
      if (projectionMatch) {
        const db = decodeURIComponent(projectionMatch[1]);
        const vertexType = decodeURIComponent(projectionMatch[2]);
        if (method === 'GET') {
          // Extract optional filter from query string
          const filterParam = url.searchParams.get('filter') || undefined;
          const result = await handleProjection(ctx, db, vertexType, filterParam);
          sendJson(res, 200, result);
          return;
        }
        // POST /api/projection/:db/:type — refresh (filter in body)
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          const filter = (body as Record<string, unknown>)?.filter as string | undefined;
          const result = await handleRefreshProjection(ctx, db, vertexType, filter);
          sendJson(res, 200, result);
          return;
        }
      }

      // GET /api/broker/agents
      if (method === 'GET' && pathname === '/api/broker/agents') {
        const result = await handleBrokerAgents(ctx);
        sendJson(res, 200, result);
        return;
      }

      // 404
      sendJson(res, 404, { success: false, error: 'Not found' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[graph-explorer] Request error:', message);
      sendJson(res, 500, { success: false, error: message });
    }
  });

  server.listen(explorerConfig.port, explorerConfig.host, () => {
    console.log(
      `[graph-explorer] Server listening on http://${explorerConfig.host}:${explorerConfig.port}`,
    );
  });

  return server;
}

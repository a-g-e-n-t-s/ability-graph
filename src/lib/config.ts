/**
 * Configuration loader for graph-ability.
 *
 * Resolution order (highest wins):
 *   1. Environment variables  (GRAPH_DATABASE, MEMORY_API_KEY, ...)
 *   2. Vault "models"         (MEMORY_API_KEY, MEMORY_API_URL — encrypted in secrets.toml)
 *   3. `config.toml` file     (walk-up from CWD — [graph] or [memory] section)
 *   4. Built-in defaults
 *
 * Credentials (API keys, URLs containing tokens) NEVER appear in config.toml.
 * They are loaded from the vault at startup via loadNative('secret-ability').
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

// ── Lightweight TOML parser (same pattern as agents-library/src/utils/config.ts) ──

function parseTomlValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => parseTomlValue(s.trim()));
  }
  return raw;
}

function parseSimpleToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[([a-zA-Z0-9._-]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    const fullKey = currentSection ? `${currentSection}.${key}` : key;
    result[fullKey] = parseTomlValue(rawValue);
  }

  return result;
}

/** Track whether config has already been logged to avoid log spam. */
let configLogged = false;

export type Transport = 'broker' | 'api';

export interface GraphConfig {
  database: string;
  embeddingModel: string;
  extractionModel: string;
  chatModel: string;
  defaultAgent: string;
  apiKey?: string;
  apiUrl?: string;
  embeddingTransport: Transport;
  chatTransport: Transport;
}

// ── Vault key names ───────────────────────────────────────────────────

/** Vault name for model-manager credentials. */
export const VAULT_NAME = 'model-manager';

/** Keys read from the vault. */
export const VAULT_KEYS = ['MODEL_MANAGER_BASE_URL', 'MODEL_MANAGER_API_KEY'] as const;

// ── Walk-up config.toml discovery ──────────────────────────────────────

/**
 * Walk up from CWD looking for config.toml.
 */
function findConfigFile(filename = 'config.toml'): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the `graph` section from the nearest `config.yml`.
 * Falls back to `memory` section for backward compatibility.
 */
function loadConfigSection(): Record<string, unknown> {
  const configPath = findConfigFile();
  if (!configPath) {
    if (!configLogged) {
      configLogged = true;
      console.warn(
        '[graph-ability] No config.toml found in directory tree — using env vars / vault only',
      );
    }
    return {};
  }

  if (!configLogged) {
    configLogged = true;
    console.log(`[graph-ability] config.toml loaded from ${configPath}`);
  }

  const content = readFileSync(configPath, 'utf8');
  const flat = parseSimpleToml(content);

  // Extract graph.* keys, fall back to memory.* for backward compatibility
  const section: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith('graph.')) {
      section[key.slice('graph.'.length)] = value;
    } else if (key.startsWith('memory.')) {
      const memKey = key.slice('memory.'.length);
      if (!(memKey in section)) {
        section[memKey] = value;
      }
    }
  }
  return section;
}

// ── Vault loading ─────────────────────────────────────────────────────

/**
 * Load credentials from the "model-manager" vault via secret-ability.
 *
 * @param client - KadiClient instance (for loadNative)
 * @returns Map of normalized key → decrypted value.
 */
export async function loadFromVault(
  client: any,
): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};

  try {
    const secrets = await client.loadNative('secret-ability');

    for (const key of VAULT_KEYS) {
      try {
        const result = await secrets.invoke('get', {
          vault: VAULT_NAME,
          key,
        });
        if (result?.value) {
          credentials[key] = result.value;
        }
      } catch {
        // Key not present — skip
      }
    }

    // Normalize to internal key names
    if (credentials['MODEL_MANAGER_BASE_URL']) {
      credentials['MEMORY_API_URL'] = credentials['MODEL_MANAGER_BASE_URL'];
    }
    if (credentials['MODEL_MANAGER_API_KEY']) {
      credentials['MEMORY_API_KEY'] = credentials['MODEL_MANAGER_API_KEY'];
    }

    await secrets.disconnect();
    const found = Object.keys(credentials).filter(k => VAULT_KEYS.includes(k as any)).length;
    console.log(
      `[graph-ability] Vault "${VAULT_NAME}" loaded — ${found}/${VAULT_KEYS.length} keys found`,
    );
  } catch (err: any) {
    console.warn(
      '[graph-ability] secret-ability not available — using env vars / config only',
    );
    console.warn('[graph-ability] loadNative error:', err?.message ?? err);
  }

  return credentials;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build the fully-resolved config (synchronous, no vault).
 */
export function loadGraphConfig(): GraphConfig {
  return buildConfig({});
}

/**
 * Build the fully-resolved config with vault credentials.
 *
 * @param client - KadiClient instance (for loadNative('secret-ability'))
 */
export async function loadGraphConfigWithVault(
  client: any,
): Promise<GraphConfig> {
  const vaultSecrets = await loadFromVault(client);
  return buildConfig(vaultSecrets);
}

/**
 * Internal config builder. Merges env vars, vault, config.toml, and defaults.
 */
function buildConfig(vault: Record<string, string>): GraphConfig {
  const file = loadConfigSection();

  return {
    database:
      process.env.GRAPH_DATABASE ??
      process.env.MEMORY_DATABASE ??
      (file.database as string) ??
      'agents_memory',
    embeddingModel:
      process.env.GRAPH_EMBEDDING_MODEL ??
      process.env.MEMORY_EMBEDDING_MODEL ??
      (file.embedding_model as string) ??
      'text-embedding-3-small',
    extractionModel:
      process.env.GRAPH_EXTRACTION_MODEL ??
      process.env.MEMORY_EXTRACTION_MODEL ??
      (file.extraction_model as string) ??
      'gpt-5-nano',
    chatModel:
      process.env.GRAPH_CHAT_MODEL ??
      process.env.MEMORY_SUMMARIZATION_MODEL ??
      (file.chat_model as string) ??
      (file.summarization_model as string) ??
      'gpt-5-mini',
    defaultAgent:
      process.env.GRAPH_DEFAULT_AGENT ??
      process.env.MEMORY_DEFAULT_AGENT ??
      (file.default_agent as string) ??
      'default',
    apiKey:
      process.env.MEMORY_API_KEY ??
      vault['MEMORY_API_KEY'] ??
      undefined,
    apiUrl:
      process.env.MEMORY_API_URL ??
      vault['MEMORY_API_URL'] ??
      undefined,
    embeddingTransport:
      (process.env.GRAPH_EMBEDDING_TRANSPORT ??
        process.env.MEMORY_EMBEDDING_TRANSPORT ??
        (file.embedding_transport as string) ??
        'api') as Transport,
    chatTransport:
      (process.env.GRAPH_CHAT_TRANSPORT ??
        process.env.MEMORY_CHAT_TRANSPORT ??
        (file.chat_transport as string) ??
        'api') as Transport,
  };
}

/**
 * Reset the config logged flag (for testing).
 */
export function _resetConfigState(): void {
  configLogged = false;
}

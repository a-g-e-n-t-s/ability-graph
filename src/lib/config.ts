/**
 * Configuration loader for graph-ability.
 *
 * Resolution order (highest wins):
 *   1. Environment variables  (GRAPH_DATABASE, MEMORY_API_KEY, ...)
 *   2. Vault "models"         (MEMORY_API_KEY, MEMORY_API_URL — encrypted in secrets.toml)
 *   3. `config.yml` file      (walk-up from CWD — non-secret settings only)
 *   4. Built-in defaults
 *
 * Credentials (API keys, URLs containing tokens) NEVER appear in config.yml.
 * They are loaded from the vault at startup via loadNative('secret-ability').
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { load } from 'js-yaml';

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

/** Vault name where model-manager credentials are stored. */
export const VAULT_NAME = 'models';

/** Keys read from the "models" vault. */
export const VAULT_KEYS = ['MEMORY_API_KEY', 'MEMORY_API_URL'] as const;

// ── Walk-up config.yml discovery ──────────────────────────────────────

/**
 * Walk up from CWD looking for config.yml.
 */
function findConfigFile(filename = 'config.yml'): string | null {
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
        '[graph-ability] No config.yml found in directory tree — using env vars / vault only',
      );
    }
    return {};
  }

  if (!configLogged) {
    configLogged = true;
    console.log(`[graph-ability] config.yml loaded from ${configPath}`);
  }
  const parsed = load(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  // Prefer `graph` section, fall back to `memory` section
  return (parsed?.graph as Record<string, unknown>) ??
         (parsed?.memory as Record<string, unknown>) ??
         {};
}

// ── Vault loading ─────────────────────────────────────────────────────

/**
 * Load credentials from the "models" vault via secret-ability.
 *
 * @param client - KadiClient instance (for loadNative)
 * @returns Map of vault key → decrypted value.
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
        // Key not present in vault — skip silently
      }
    }

    await secrets.disconnect();
    console.log(
      `[graph-ability] Vault "${VAULT_NAME}" loaded — ${Object.keys(credentials).length}/${VAULT_KEYS.length} keys found`,
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
 * Internal config builder. Merges env vars, vault, config.yml, and defaults.
 */
function buildConfig(vault: Record<string, string>): GraphConfig {
  const file = loadConfigSection();

  return {
    database:
      process.env.GRAPH_DATABASE ??
      process.env.MEMORY_DATABASE ??
      (file.database as string) ??
      'kadi_memory',
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

/**
 * Shared test helpers for graph-ability integration tests.
 *
 * Provides a preconfigured KadiClient, SignalAbilities wrapper,
 * config loading, and cleanup utilities.
 *
 * All integration tests require:
 *   - KADI broker running (wss://broker.kadi.build/kadi or BROKER_URL env)
 *   - arcadedb-ability connected to broker
 *   - model-manager connected to broker
 *   - ArcadeDB container running
 *   - Valid API keys in secrets.toml "models" vault
 */

import { KadiClient } from '@kadi.build/core';
import { loadGraphConfigWithVault, type GraphConfig } from '../../src/lib/config.js';
import { schemaRegistry } from '../../src/lib/schema-registry.js';
import type { SignalAbilities, ArcadeCommandResult } from '../../src/lib/types.js';
import { invokeWithRetry } from '../../src/lib/retry.js';

export const BROKER_URL = process.env.BROKER_URL ?? 'wss://broker.kadi.build/kadi';
export const TEST_PREFIX = `gtest_${Date.now()}`;
export const TEST_DATABASE = process.env.TEST_DATABASE ?? 'kadi_memory';

export interface TestContext {
  client: KadiClient;
  config: GraphConfig;
  abilities: SignalAbilities;
  database: string;
}

/**
 * Create and connect a KadiClient for integration tests.
 */
export async function createTestContext(testName: string): Promise<TestContext> {
  const client = new KadiClient({
    name: `graph-ability-${testName}`,
    version: '0.0.1',
    brokers: { default: { url: BROKER_URL } },
  });

  const config = await loadGraphConfigWithVault(client);

  if (!config.apiKey) {
    throw new Error(
      'MEMORY_API_KEY not found — ensure secrets.toml has the key in the "models" vault, ' +
      'or set the MEMORY_API_KEY env var.',
    );
  }
  if (!config.apiUrl) {
    throw new Error(
      'MEMORY_API_URL not found — ensure secrets.toml has the key in the "models" vault, ' +
      'or set the MEMORY_API_URL env var.',
    );
  }

  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  const database = TEST_DATABASE;

  await client.connect();

  console.log(`[${testName}] Connected to broker: ${BROKER_URL}`);
  console.log(`[${testName}] Database: ${database}`);
  console.log(`[${testName}] API URL: ${config.apiUrl}`);

  return { client, config, abilities, database };
}

/**
 * Clean up test vertices of a given type by deleting all that match a content prefix.
 */
export async function cleanupTestVertices(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  contentPrefix: string,
): Promise<number> {
  let deleted = 0;
  try {
    const deleteResult = await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      {
        database,
        command: `DELETE VERTEX ${vertexType} WHERE content LIKE '${contentPrefix}%'`,
      },
    );
    if (deleteResult.success && deleteResult.result) {
      deleted = (deleteResult.result[0]?.count as number) ?? 0;
    }
  } catch {
    // Ignore cleanup errors — type may not exist
  }
  return deleted;
}

/**
 * Clean up test topics by name prefix.
 */
export async function cleanupTestTopics(
  abilities: SignalAbilities,
  database: string,
  namePrefix: string,
): Promise<void> {
  try {
    await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      {
        database,
        command: `DELETE VERTEX Topic WHERE name LIKE '${namePrefix}%'`,
      },
    );
  } catch {
    // Ignore
  }
}

/**
 * Clean up test entities by name prefix.
 */
export async function cleanupTestEntities(
  abilities: SignalAbilities,
  database: string,
  namePrefix: string,
): Promise<void> {
  try {
    await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      {
        database,
        command: `DELETE VERTEX Entity WHERE name LIKE '${namePrefix}%'`,
      },
    );
  } catch {
    // Ignore
  }
}

/**
 * Reset the schema registry for clean test state.
 */
export function resetSchemaRegistry(): void {
  schemaRegistry.reset();
}

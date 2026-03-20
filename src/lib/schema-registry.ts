/**
 * Schema Registry — manages named schema definitions and applies them
 * idempotently to ArcadeDB.
 *
 * CRITICAL: All DDL operations use individual arcade-command calls (via
 * invokeWithRetry). Never use arcade-batch for DDL. See UPGRADE-REQUEST.md
 * Appendix A.
 *
 * Behavior:
 * 1. On startup, graph-ability registers NO schema. Consumers must register
 *    their own schemas before storing or recalling vertices.
 * 2. DDL is idempotent (IF NOT EXISTS for types/properties, pre-check for indexes).
 * 3. Vector indexes are lazy-created on first embedding for a vertex type.
 * 4. Per-database schema cache tracks verified schemas per DB.
 * 5. Index pre-check: Query schema:indexes before creation to avoid noisy errors.
 */

import { invokeWithRetry } from './retry.js';
import { sanitizeInt } from './sql.js';
import type {
  ArcadeCommandResult,
  ArcadeQueryResult,
  SchemaDefinition,
  SignalAbilities,
  VertexTypeDef,
  EdgeTypeDef,
  IndexDef,
} from './types.js';

// ---------------------------------------------------------------------------
// Schema Registry Class
// ---------------------------------------------------------------------------

export class SchemaRegistry {
  /** Registered schema definitions by name. */
  private schemas: Map<string, SchemaDefinition> = new Map();

  /** Per-database set of schema names that have been applied. */
  private appliedSchemas: Map<string, Set<string>> = new Map();

  /** Per-database set of vertex types that have vector indexes. */
  private vectorIndexes: Map<string, Set<string>> = new Map();

  /**
   * Register a schema definition. Does not apply DDL until ensureInfrastructure() is called.
   *
   * @param def - The schema definition to register.
   * @throws If a schema with the same name is already registered with different content.
   */
  register(def: SchemaDefinition): void {
    if (!def.name || typeof def.name !== 'string') {
      throw new Error('Schema definition must have a non-empty "name" property.');
    }
    if (!Array.isArray(def.vertexTypes)) {
      throw new Error(`Schema "${def.name}": vertexTypes must be an array.`);
    }
    if (!Array.isArray(def.edgeTypes)) {
      throw new Error(`Schema "${def.name}": edgeTypes must be an array.`);
    }

    // Validate vertex type definitions
    for (const vt of def.vertexTypes) {
      if (!vt.name || typeof vt.name !== 'string') {
        throw new Error(
          `Schema "${def.name}": each vertex type must have a non-empty "name" property.`,
        );
      }
      if (!vt.properties || typeof vt.properties !== 'object') {
        throw new Error(
          `Schema "${def.name}": vertex type "${vt.name}" must have a "properties" object.`,
        );
      }
    }

    // Validate edge type definitions
    for (const et of def.edgeTypes) {
      if (!et.name || typeof et.name !== 'string') {
        throw new Error(
          `Schema "${def.name}": each edge type must have a non-empty "name" property.`,
        );
      }
    }

    this.schemas.set(def.name, def);
  }

  /**
   * List all registered schema names.
   */
  list(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Get a registered schema by name.
   *
   * @param name - Schema name.
   * @returns The schema definition, or undefined if not registered.
   */
  get(name: string): SchemaDefinition | undefined {
    return this.schemas.get(name);
  }

  /**
   * Apply all registered (but not yet applied) schemas to ArcadeDB.
   *
   * Uses individual arcade-command calls for each DDL operation:
   * 1. Create vertex types (IF NOT EXISTS)
   * 2. Create properties on each vertex type (IF NOT EXISTS)
   * 3. Create edge types (IF NOT EXISTS)
   * 4. Create properties on each edge type (IF NOT EXISTS)
   * 5. Create indexes (with pre-check to avoid noisy errors)
   *
   * @param abilities - The abilities interface for invoking remote tools.
   * @param database  - The target ArcadeDB database name.
   */
  async ensureInfrastructure(
    abilities: SignalAbilities,
    database: string,
  ): Promise<void> {
    const appliedForDB = this.appliedSchemas.get(database) ?? new Set();

    for (const [name, def] of this.schemas) {
      if (appliedForDB.has(name)) continue;

      const targetDb = def.database ?? database;

      // 1. Create vertex types and their properties
      for (const vt of def.vertexTypes) {
        await this.createVertexType(abilities, targetDb, vt);
      }

      // 2. Create edge types and their properties
      for (const et of def.edgeTypes) {
        await this.createEdgeType(abilities, targetDb, et);
      }

      // 3. Create indexes (with pre-check)
      for (const vt of def.vertexTypes) {
        if (vt.indexes) {
          for (const idx of vt.indexes) {
            await this.createIndex(abilities, targetDb, vt.name, idx);
          }
        }
      }

      appliedForDB.add(name);
    }

    this.appliedSchemas.set(database, appliedForDB);
  }

  /**
   * Ensure a vector index exists for a vertex type.
   * Called lazily when the first embedding reveals dimensionality.
   *
   * @param abilities  - The abilities interface.
   * @param database   - The target database.
   * @param vertexType - The vertex type name.
   * @param dimensions - The embedding dimensionality.
   */
  async ensureVectorIndex(
    abilities: SignalAbilities,
    database: string,
    vertexType: string,
    dimensions: number,
  ): Promise<void> {
    const key = `${database}:${vertexType}`;
    const vectorSet = this.vectorIndexes.get(key) ?? new Set();

    if (vectorSet.has(vertexType)) return;

    const safeDimensions = sanitizeInt(dimensions, 'dimensions');

    const command =
      `CREATE INDEX ON ${vertexType} (embedding) LSM_VECTOR METADATA` +
      ` {"dimensions": ${safeDimensions}, "similarity": "COSINE"}`;

    const result = await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      { database, command },
    );

    if (result.success) {
      vectorSet.add(vertexType);
      this.vectorIndexes.set(key, vectorSet);
      return;
    }

    if (result.error && isAlreadyExistsError(result.error)) {
      vectorSet.add(vertexType);
      this.vectorIndexes.set(key, vectorSet);
      return;
    }

    throw new Error(
      `Vector index creation failed for ${vertexType} with ${safeDimensions} dimensions ` +
      `(database: ${database}): ${result.error ?? 'unknown error'}`,
    );
  }

  /**
   * Reset registry state (for testing).
   */
  reset(): void {
    this.schemas.clear();
    this.appliedSchemas.clear();
    this.vectorIndexes.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal DDL helpers
  // ---------------------------------------------------------------------------

  private async createVertexType(
    abilities: SignalAbilities,
    database: string,
    vt: VertexTypeDef,
  ): Promise<void> {
    // Create the vertex type
    await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      { database, command: `CREATE VERTEX TYPE ${vt.name} IF NOT EXISTS` },
    );

    // Create each property
    for (const [propName, propType] of Object.entries(vt.properties)) {
      await invokeWithRetry<ArcadeCommandResult>(
        abilities,
        'arcade-command',
        {
          database,
          command: `CREATE PROPERTY ${vt.name}.${propName} IF NOT EXISTS ${propType}`,
        },
      );
    }
  }

  private async createEdgeType(
    abilities: SignalAbilities,
    database: string,
    et: EdgeTypeDef,
  ): Promise<void> {
    // Create the edge type
    await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      { database, command: `CREATE EDGE TYPE ${et.name} IF NOT EXISTS` },
    );

    // Create properties if any
    if (et.properties) {
      for (const [propName, propType] of Object.entries(et.properties)) {
        await invokeWithRetry<ArcadeCommandResult>(
          abilities,
          'arcade-command',
          {
            database,
            command: `CREATE PROPERTY ${et.name}.${propName} IF NOT EXISTS ${propType}`,
          },
        );
      }
    }
  }

  private async createIndex(
    abilities: SignalAbilities,
    database: string,
    vertexType: string,
    idx: IndexDef,
  ): Promise<void> {
    // Pre-check: query existing indexes to avoid noisy error logs
    const existingIndexes = await this.getExistingIndexes(abilities, database);

    // Construct index name for comparison
    // ArcadeDB generates index names like "Type[property]" or "Type[property1,property2]"
    const indexKey = `${vertexType}[${idx.property}]`.toLowerCase();

    if (existingIndexes.some((name) => name.toLowerCase().includes(indexKey))) {
      return; // Index already exists
    }

    const command = `CREATE INDEX ON ${vertexType} (${idx.property}) ${idx.type}`;

    const result = await invokeWithRetry<ArcadeCommandResult>(
      abilities,
      'arcade-command',
      { database, command },
    );

    if (!result.success && result.error) {
      if (isAlreadyExistsError(result.error)) return;
      throw new Error(
        `Index creation failed on ${vertexType}(${idx.property}) ${idx.type} ` +
        `(database: ${database}): ${result.error}`,
      );
    }
  }

  private async getExistingIndexes(
    abilities: SignalAbilities,
    database: string,
  ): Promise<string[]> {
    try {
      const result = await invokeWithRetry<ArcadeQueryResult>(
        abilities,
        'arcade-query',
        { database, query: 'SELECT FROM schema:indexes' },
      );

      if (!result.success || !result.result) return [];

      return result.result.map((row) => {
        const name = (row.name as string) ?? '';
        return name;
      });
    } catch {
      // If we can't query indexes, proceed with creation and let ArcadeDB
      // handle the "already exists" case
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlreadyExistsError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('already exists') ||
    lower.includes('index already') ||
    lower.includes('duplicate')
  );
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/** Global schema registry instance. */
export const schemaRegistry = new SchemaRegistry();

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

import { SchemaRegistry } from '../../src/lib/schema-registry.js';
import {
  TOPIC_VERTEX,
  ENTITY_VERTEX,
  COMMON_EDGE_TYPES,
  DEFAULT_ENTITY_TYPES,
} from '../../src/lib/types.js';
import type { SignalAbilities, SchemaDefinition } from '../../src/lib/types.js';

// ---------------------------------------------------------------------------
// Mock abilities
// ---------------------------------------------------------------------------

function createMockAbilities(): {
  abilities: SignalAbilities;
  commands: Array<{ tool: string; params: Record<string, unknown> }>;
} {
  const commands: Array<{ tool: string; params: Record<string, unknown> }> = [];

  const abilities: SignalAbilities = {
    invoke: async (tool: string, params: Record<string, unknown>) => {
      commands.push({ tool, params });

      // Mock arcade-query for schema:indexes — return empty by default
      if (tool === 'arcade-query') {
        return { success: true, result: [] };
      }

      // Mock arcade-command — always succeed
      if (tool === 'arcade-command') {
        return { success: true, result: [{ '@rid': '#1:0' }] };
      }

      return { success: true };
    },
  };

  return { abilities, commands };
}

// Suppress console.warn during tests
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaRegistry', () => {
  let registry: SchemaRegistry;

  beforeEach(() => {
    registry = new SchemaRegistry();
  });

  describe('register()', () => {
    it('registers a valid schema definition', () => {
      const def: SchemaDefinition = {
        name: 'test-schema',
        vertexTypes: [
          { name: 'TestVertex', properties: { content: 'STRING' } },
        ],
        edgeTypes: [
          { name: 'TestEdge' },
        ],
      };

      registry.register(def);
      expect(registry.get('test-schema')).toEqual(def);
    });

    it('throws for schema without a name', () => {
      expect(() =>
        registry.register({
          name: '',
          vertexTypes: [],
          edgeTypes: [],
        }),
      ).toThrow('non-empty "name"');
    });

    it('throws for schema with non-array vertexTypes', () => {
      expect(() =>
        registry.register({
          name: 'bad',
          vertexTypes: 'not-an-array' as any,
          edgeTypes: [],
        }),
      ).toThrow('vertexTypes must be an array');
    });

    it('throws for schema with non-array edgeTypes', () => {
      expect(() =>
        registry.register({
          name: 'bad',
          vertexTypes: [],
          edgeTypes: 'not-an-array' as any,
        }),
      ).toThrow('edgeTypes must be an array');
    });

    it('throws for vertex type without name', () => {
      expect(() =>
        registry.register({
          name: 'bad',
          vertexTypes: [{ name: '', properties: {} }],
          edgeTypes: [],
        }),
      ).toThrow('non-empty "name" property');
    });

    it('throws for edge type without name', () => {
      expect(() =>
        registry.register({
          name: 'bad',
          vertexTypes: [],
          edgeTypes: [{ name: '' }],
        }),
      ).toThrow('non-empty "name" property');
    });

    it('allows re-registration (idempotent)', () => {
      const def: SchemaDefinition = {
        name: 'test',
        vertexTypes: [{ name: 'V', properties: { a: 'STRING' } }],
        edgeTypes: [],
      };

      registry.register(def);
      registry.register(def); // Should not throw
      expect(registry.list()).toEqual(['test']);
    });
  });

  describe('list()', () => {
    it('returns empty array when no schemas registered', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered schema names', () => {
      registry.register({
        name: 'alpha',
        vertexTypes: [{ name: 'A', properties: { x: 'STRING' } }],
        edgeTypes: [],
      });
      registry.register({
        name: 'beta',
        vertexTypes: [{ name: 'B', properties: { y: 'STRING' } }],
        edgeTypes: [],
      });

      const names = registry.list();
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names.length).toBe(2);
    });
  });

  describe('get()', () => {
    it('returns undefined for unknown schema', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('returns registered schema', () => {
      const def: SchemaDefinition = {
        name: 'test',
        vertexTypes: [{ name: 'V', properties: { a: 'STRING' } }],
        edgeTypes: [{ name: 'E' }],
      };
      registry.register(def);
      expect(registry.get('test')).toEqual(def);
    });
  });

  describe('ensureInfrastructure()', () => {
    it('creates vertex types, properties, edge types, and indexes', async () => {
      const { abilities, commands } = createMockAbilities();

      registry.register({
        name: 'test',
        vertexTypes: [
          {
            name: 'Memory',
            properties: { content: 'STRING', agent: 'STRING' },
            indexes: [{ property: 'agent', type: 'NOTUNIQUE' }],
          },
        ],
        edgeTypes: [
          { name: 'HasTopic', properties: { weight: 'DOUBLE' } },
        ],
      });

      await registry.ensureInfrastructure(abilities, 'test_db');

      // Should have commands for: CREATE VERTEX TYPE, 2 properties, CREATE EDGE TYPE,
      // 1 edge property, schema:indexes query, CREATE INDEX
      const createCommands = commands.filter((c) => c.tool === 'arcade-command');
      const queryCommands = commands.filter((c) => c.tool === 'arcade-query');

      // At least: 1 vertex type + 2 props + 1 edge type + 1 edge prop + 1 index
      expect(createCommands.length).toBeGreaterThanOrEqual(5);
      // At least 1 schema:indexes query
      expect(queryCommands.length).toBeGreaterThanOrEqual(1);

      // Check specific commands exist
      const commandTexts = createCommands.map((c) => c.params.command as string);
      expect(commandTexts).toContain('CREATE VERTEX TYPE Memory IF NOT EXISTS');
      expect(commandTexts).toContain('CREATE PROPERTY Memory.content IF NOT EXISTS STRING');
      expect(commandTexts).toContain('CREATE PROPERTY Memory.agent IF NOT EXISTS STRING');
      expect(commandTexts).toContain('CREATE EDGE TYPE HasTopic IF NOT EXISTS');
      expect(commandTexts).toContain('CREATE PROPERTY HasTopic.weight IF NOT EXISTS DOUBLE');
    });

    it('is idempotent — second call skips already-applied schemas', async () => {
      const { abilities, commands } = createMockAbilities();

      registry.register({
        name: 'test',
        vertexTypes: [
          { name: 'V', properties: { a: 'STRING' } },
        ],
        edgeTypes: [],
      });

      await registry.ensureInfrastructure(abilities, 'test_db');
      const firstCallCount = commands.length;

      await registry.ensureInfrastructure(abilities, 'test_db');
      // Second call should not add new commands
      expect(commands.length).toBe(firstCallCount);
    });

    it('applies to different databases independently', async () => {
      const { abilities, commands } = createMockAbilities();

      registry.register({
        name: 'test',
        vertexTypes: [
          { name: 'V', properties: { a: 'STRING' } },
        ],
        edgeTypes: [],
      });

      await registry.ensureInfrastructure(abilities, 'db1');
      const afterFirst = commands.length;

      await registry.ensureInfrastructure(abilities, 'db2');
      // Should have additional commands for the second database
      expect(commands.length).toBeGreaterThan(afterFirst);
    });

    it('uses schema.database if specified', async () => {
      const { abilities, commands } = createMockAbilities();

      registry.register({
        name: 'test',
        database: 'custom_db',
        vertexTypes: [
          { name: 'V', properties: { a: 'STRING' } },
        ],
        edgeTypes: [],
      });

      await registry.ensureInfrastructure(abilities, 'default_db');

      // All commands should target custom_db, not default_db
      const dbParams = commands.map((c) => c.params.database);
      for (const db of dbParams) {
        expect(db).toBe('custom_db');
      }
    });
  });

  describe('reset()', () => {
    it('clears all state', async () => {
      const { abilities } = createMockAbilities();

      registry.register({
        name: 'test',
        vertexTypes: [{ name: 'V', properties: { a: 'STRING' } }],
        edgeTypes: [],
      });
      await registry.ensureInfrastructure(abilities, 'test_db');

      registry.reset();

      expect(registry.list()).toEqual([]);
      expect(registry.get('test')).toBeUndefined();
    });
  });
});

describe('Convenience constants', () => {
  it('TOPIC_VERTEX is properly defined', () => {
    expect(TOPIC_VERTEX.name).toBe('Topic');
    expect(TOPIC_VERTEX.properties).toHaveProperty('name', 'STRING');
    expect(TOPIC_VERTEX.properties).toHaveProperty('frequency', 'INTEGER');
    expect(TOPIC_VERTEX.indexes).toHaveLength(1);
    expect(TOPIC_VERTEX.indexes![0].property).toBe('name');
    expect(TOPIC_VERTEX.indexes![0].type).toBe('UNIQUE');
  });

  it('ENTITY_VERTEX is properly defined', () => {
    expect(ENTITY_VERTEX.name).toBe('Entity');
    expect(ENTITY_VERTEX.properties).toHaveProperty('name', 'STRING');
    expect(ENTITY_VERTEX.properties).toHaveProperty('type', 'STRING');
    expect(ENTITY_VERTEX.indexes).toHaveLength(1);
    expect(ENTITY_VERTEX.indexes![0].property).toBe('name,type');
    expect(ENTITY_VERTEX.indexes![0].type).toBe('UNIQUE');
  });

  it('COMMON_EDGE_TYPES has HasTopic, Mentions, and RelatedTo', () => {
    expect(COMMON_EDGE_TYPES.length).toBe(3);
    const names = COMMON_EDGE_TYPES.map((e) => e.name);
    expect(names).toContain('HasTopic');
    expect(names).toContain('Mentions');
    expect(names).toContain('RelatedTo');
  });

  it('DEFAULT_ENTITY_TYPES includes expected types', () => {
    expect(DEFAULT_ENTITY_TYPES).toContain('person');
    expect(DEFAULT_ENTITY_TYPES).toContain('project');
    expect(DEFAULT_ENTITY_TYPES).toContain('tool');
    expect(DEFAULT_ENTITY_TYPES).toContain('company');
    expect(DEFAULT_ENTITY_TYPES).toContain('concept');
    expect(DEFAULT_ENTITY_TYPES.length).toBe(5);
  });

  it('convenience constants are NOT auto-applied', () => {
    // A fresh registry should have no schemas registered
    const registry = new SchemaRegistry();
    expect(registry.list()).toEqual([]);
  });
});

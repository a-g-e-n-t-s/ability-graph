/**
 * SQL utilities for constructing safe ArcadeDB queries.
 *
 * ArcadeDB uses standard SQL string literal escaping: single quotes are
 * doubled ('').  Backslash is NOT an escape character in ArcadeDB SQL,
 * but we strip it defensively to prevent any future interpretation.
 *
 * All user-supplied values that appear inside SQL string literals MUST pass
 * through {@link escapeSQL} before interpolation.
 */

import type { ArcadeCommandResult, ArcadeQueryResult } from './types.js';

// Re-export for convenience
export type { ArcadeCommandResult, ArcadeQueryResult };

/**
 * Escape a string value for interpolation inside a SQL single-quoted literal.
 *
 * ArcadeDB follows the SQL standard: the only character that needs escaping
 * inside a single-quoted string is the single quote itself, which is doubled.
 * Backslashes are passed through literally (not interpreted as escape chars),
 * but we strip NUL bytes defensively since they can truncate strings in some
 * database engines.
 *
 * This function MUST only be used for values placed inside single quotes:
 *   `WHERE name = '${escapeSQL(name)}'`
 *
 * Numeric values interpolated outside quotes (LIMIT, OFFSET, dimensions)
 * should use {@link sanitizeInt} instead.
 *
 * @param value - Raw string to escape.
 * @returns Escaped string safe for SQL single-quoted interpolation.
 */
export function escapeSQL(value: string): string {
  return value
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Validate and coerce a value to a safe positive integer for use in SQL
 * clauses that expect a number (LIMIT, OFFSET, array dimensions).
 *
 * Throws if the value is not a finite non-negative integer.  This prevents
 * injection through numeric parameters that are interpolated outside quotes.
 *
 * @param value - Value to validate.
 * @param label - Human-readable label for error messages (e.g. "limit").
 * @returns The validated integer.
 */
export function sanitizeInt(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: expected a non-negative integer, got ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Filter helpers (centralized for all signal files)
// ---------------------------------------------------------------------------

/**
 * Build SQL WHERE conditions from a filters object.
 *
 * Supports string, number, boolean, and array values.
 * Arrays produce `key IN [...]` clauses.
 */
export function buildFilterConditions(filters: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      parts.push(`${key} = '${escapeSQL(value)}'`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key} = ${value}`);
    } else if (Array.isArray(value)) {
      const escaped = value.map((v) =>
        typeof v === 'string' ? `'${escapeSQL(v)}'` : String(v),
      );
      parts.push(`${key} IN [${escaped.join(', ')}]`);
    }
  }

  return parts.join(' AND ');
}

/**
 * Filter out ArcadeDB system properties and signal-internal keys from a row.
 */
export function filterSystemProps(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('@') && key !== 'score') {
      result[key] = value;
    }
  }
  return result;
}

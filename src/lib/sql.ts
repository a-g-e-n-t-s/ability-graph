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

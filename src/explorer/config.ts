/**
 * Explorer configuration.
 *
 * Reads explorer settings from environment variables or config.toml.
 * No vault secrets needed — the explorer reuses the already-resolved GraphConfig.
 */

export interface ExplorerConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export function loadExplorerConfig(): ExplorerConfig {
  const enabled = process.env.EXPLORER_ENABLED !== undefined
    ? process.env.EXPLORER_ENABLED === 'true'
    : true;

  let port = 9090;
  if (process.env.EXPLORER_PORT !== undefined) {
    const parsed = parseInt(process.env.EXPLORER_PORT, 10);
    if (!Number.isNaN(parsed)) port = parsed;
  }

  const host = process.env.EXPLORER_HOST ?? '0.0.0.0';

  return { enabled, port, host };
}

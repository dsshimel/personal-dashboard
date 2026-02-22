/**
 * @fileoverview Feature flags module for the dashboard.
 *
 * Flags are defined in a code registry (FLAG_REGISTRY). The database only
 * persists enabled/disabled state. New flags added to the registry
 * automatically appear as disabled until toggled on.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A feature flag definition from the registry. */
interface FlagDefinition {
  key: string;
  label: string;
  description: string;
}

/** A feature flag with its current enabled state. */
export interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

/** Row shape from the feature_flags table. */
interface FlagRow {
  key: string;
  enabled: number;
}

/** Registry of all available feature flags. */
export const FLAG_REGISTRY: FlagDefinition[] = [
  {
    key: 'social-auth',
    label: 'Social Auth',
    description: 'Require Google sign-in to access the dashboard',
  },
  {
    key: 'shell-terminal',
    label: 'Shell Terminal',
    description: 'Enable xterm.js shell terminal (requires AUTHORIZED_EMAIL)',
  },
];

/**
 * Initializes the feature_flags table in the database.
 *
 * @param db - The SQLite database instance.
 */
export function initFeatureFlagsDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS feature_flags (
      key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/**
 * Lists all feature flags from the registry merged with their DB state.
 * Flags not yet in the DB default to disabled.
 */
export function listFeatureFlags(): FeatureFlag[] {
  const db = getDb();
  const rows = db.prepare('SELECT key, enabled FROM feature_flags').all() as FlagRow[];
  const enabledMap = new Map(rows.map(r => [r.key, r.enabled === 1]));

  return FLAG_REGISTRY.map(flag => ({
    key: flag.key,
    label: flag.label,
    description: flag.description,
    enabled: enabledMap.get(flag.key) ?? false,
  }));
}

/**
 * Toggles a feature flag's enabled state.
 *
 * @param key - The flag key (must exist in FLAG_REGISTRY).
 * @param enabled - Whether the flag should be enabled.
 * @returns The updated feature flag.
 * @throws If the key is not in the registry.
 */
export function toggleFeatureFlag(key: string, enabled: boolean): FeatureFlag {
  const definition = FLAG_REGISTRY.find(f => f.key === key);
  if (!definition) {
    throw new Error(`Unknown feature flag: ${key}`);
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO feature_flags (key, enabled) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled
  `).run(key, enabled ? 1 : 0);

  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    enabled,
  };
}

/**
 * Checks whether a feature flag is currently enabled.
 *
 * @param key - The flag key.
 * @returns True if the flag exists in the registry and is enabled.
 */
export function isFlagEnabled(key: string): boolean {
  const definition = FLAG_REGISTRY.find(f => f.key === key);
  if (!definition) return false;

  const db = getDb();
  const row = db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').get(key) as FlagRow | null;
  return row ? row.enabled === 1 : false;
}

/**
 * @fileoverview Shared SQLite database initialization for the personal dashboard.
 *
 * Opens a single database at ~/.personal-dashboard/dashboard.db, enables
 * WAL mode and foreign keys, and initializes all table schemas.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/** The shared database instance. */
let db: Database | null = null;

/** Default directory where dashboard config is stored. */
const DEFAULT_CONFIG_DIR = join(homedir(), '.personal-dashboard');

/** Optional override for testing. */
let configDirOverride: string | null = null;

/** Returns the current config directory path. */
export function getConfigDir(): string {
  return configDirOverride || DEFAULT_CONFIG_DIR;
}

/** Overrides the config directory (for testing). Pass null to reset. */
export function setConfigDir(dir: string | null): void {
  configDirOverride = dir;
}

/**
 * Returns the shared database instance.
 * Throws if initDb() has not been called.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Initializes the shared SQLite database.
 *
 * @param dbPath - Optional path override (for testing). Defaults to ~/.personal-dashboard/dashboard.db.
 *                 Pass ":memory:" for in-memory test databases.
 * @returns The initialized Database instance.
 */
export function initDb(dbPath?: string): Database {
  const resolvedPath = dbPath || join(getConfigDir(), 'dashboard.db');

  // Ensure the directory exists (unless in-memory)
  if (resolvedPath !== ':memory:') {
    try {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    } catch {
      // Directory already exists
    }
  }

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.run('PRAGMA journal_mode = WAL');

  // Enable foreign key enforcement
  db.run('PRAGMA foreign_keys = ON');

  return db;
}

/**
 * Closes the database connection.
 * Safe to call even if not initialized.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

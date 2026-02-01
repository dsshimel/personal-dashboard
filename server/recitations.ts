/**
 * @fileoverview Recitations module for the dashboard.
 *
 * Provides CRUD operations for recitation items. Each recitation has a title,
 * optional content text, and a creation timestamp. Recitations are included
 * verbatim in the daily briefing email.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A recitation item. */
export interface Recitation {
  id: string;
  title: string;
  content: string | null;
  createdAt: string;
}

/** Row shape from the recitations table. */
interface RecitationRow {
  id: string;
  title: string;
  content: string | null;
  created_at: string;
}

/**
 * Initializes the recitations table in the database.
 *
 * @param db - The SQLite database instance.
 */
export function initRecitationsDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS recitations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL
    )
  `);
}

/** Converts a RecitationRow to a Recitation. */
function rowToRecitation(row: RecitationRow): Recitation {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  };
}

/**
 * Lists all recitations sorted by creation date (newest first).
 */
export function listRecitations(): Recitation[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM recitations ORDER BY created_at DESC'
  ).all() as RecitationRow[];

  return rows.map(rowToRecitation);
}

/**
 * Gets a single recitation by ID.
 *
 * @param id - The recitation ID.
 * @returns The recitation, or null if not found.
 */
export function getRecitation(id: string): Recitation | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM recitations WHERE id = ?').get(id) as RecitationRow | null;
  return row ? rowToRecitation(row) : null;
}

/**
 * Creates a new recitation.
 *
 * @param data - Recitation fields (title required, content optional).
 * @returns The created recitation.
 */
export function createRecitation(data: { title: string; content?: string }): Recitation {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO recitations (id, title, content, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, data.title, data.content ?? null, now);

  return {
    id,
    title: data.title,
    content: data.content ?? null,
    createdAt: now,
  };
}

/**
 * Updates a recitation's title and/or content.
 *
 * @param id - The recitation ID.
 * @param data - Fields to update.
 * @returns The updated recitation.
 * @throws If the recitation is not found.
 */
export function updateRecitation(id: string, data: { title?: string; content?: string | null }): Recitation {
  const db = getDb();
  const existing = getRecitation(id);
  if (!existing) {
    throw new Error(`Recitation not found: ${id}`);
  }

  const title = data.title !== undefined ? data.title : existing.title;
  const content = data.content !== undefined ? data.content : existing.content;

  db.prepare('UPDATE recitations SET title = ?, content = ? WHERE id = ?').run(title, content, id);

  return { ...existing, title, content };
}

/**
 * Deletes a recitation.
 *
 * @param id - The recitation ID.
 * @throws If the recitation is not found.
 */
export function deleteRecitation(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM recitations WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Recitation not found: ${id}`);
  }

  db.prepare('DELETE FROM recitations WHERE id = ?').run(id);
}

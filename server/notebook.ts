/**
 * @fileoverview Notebook module for the dashboard.
 *
 * Provides CRUD operations for personal notes with title, body, and timestamps.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A notebook note. */
export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** Row shape from the notebook_notes table. */
interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * Initializes the notebook table in the database.
 *
 * @param db - The SQLite database instance.
 */
export function initNotebookDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notebook_notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/** Converts a NoteRow to a Note. */
function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Note CRUD

/** Lists all notes ordered by updated_at descending. */
export function listNotes(): Note[] {
  const db = getDb();
  const rows = db.query<NoteRow, []>(
    'SELECT * FROM notebook_notes ORDER BY updated_at DESC'
  ).all();
  return rows.map(rowToNote);
}

/** Gets a single note by id. Throws if not found. */
export function getNote(id: string): Note {
  const db = getDb();
  const row = db.query<NoteRow, [string]>(
    'SELECT * FROM notebook_notes WHERE id = ?'
  ).get(id);
  if (!row) throw new Error(`Note not found: ${id}`);
  return rowToNote(row);
}

/** Creates a new note. */
export function createNote(data: { title: string; body?: string }): Note {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO notebook_notes (id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, data.title, data.body ?? '', now, now]
  );
  return getNote(id);
}

/** Updates an existing note's title and/or body. Throws if not found. */
export function updateNote(id: string, data: { title?: string; body?: string }): Note {
  const db = getDb();
  const existing = getNote(id);
  const now = new Date().toISOString();
  db.run(
    'UPDATE notebook_notes SET title = ?, body = ?, updated_at = ? WHERE id = ?',
    [data.title ?? existing.title, data.body ?? existing.body, now, id]
  );
  return getNote(id);
}

/** Deletes a note by id. Throws if not found. */
export function deleteNote(id: string): void {
  const db = getDb();
  getNote(id); // throws if not found
  db.run('DELETE FROM notebook_notes WHERE id = ?', [id]);
}

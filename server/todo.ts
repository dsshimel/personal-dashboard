/**
 * @fileoverview Todo list module for the dashboard.
 *
 * Provides CRUD operations for todo items. Todos are sorted by creation
 * date (newest first) and have a description and timestamp.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A todo item. */
export interface Todo {
  id: string;
  description: string;
  createdAt: string;
}

/** Row shape from the todos table. */
interface TodoRow {
  id: string;
  description: string;
  created_at: string;
}

/**
 * Initializes the todos table in the database.
 *
 * @param db - The SQLite database instance.
 */
export function initTodoDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

/** Generates a UUID v4 string. */
function uuid(): string {
  return crypto.randomUUID();
}

/** Converts a TodoRow to a Todo. */
function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    description: row.description,
    createdAt: row.created_at,
  };
}

/**
 * Lists all todos sorted by creation date (newest first).
 */
export function listTodos(): Todo[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM todos ORDER BY created_at DESC'
  ).all() as TodoRow[];

  return rows.map(rowToTodo);
}

/**
 * Gets a single todo by ID.
 *
 * @param id - The todo ID.
 * @returns The todo, or null if not found.
 */
export function getTodo(id: string): Todo | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | null;
  return row ? rowToTodo(row) : null;
}

/**
 * Creates a new todo.
 *
 * @param data - Todo fields (description required).
 * @returns The created todo.
 */
export function createTodo(data: { description: string }): Todo {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO todos (id, description, created_at)
    VALUES (?, ?, ?)
  `).run(id, data.description, now);

  return {
    id,
    description: data.description,
    createdAt: now,
  };
}

/**
 * Deletes a todo.
 *
 * @param id - The todo ID.
 * @throws If the todo is not found.
 */
export function deleteTodo(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM todos WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Todo not found: ${id}`);
  }

  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
}

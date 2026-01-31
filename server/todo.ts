/**
 * @fileoverview Todo list module for the dashboard.
 *
 * Provides CRUD operations for todo items. Todos are sorted by creation
 * date (newest first) and have a description, timestamp, and done status.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A todo item. */
export interface Todo {
  id: string;
  description: string;
  createdAt: string;
  done: boolean;
}

/** Row shape from the todos table. */
interface TodoRow {
  id: string;
  description: string;
  created_at: string;
  done: number;
}

/**
 * Initializes the todos table in the database.
 * Adds the `done` column if it doesn't exist (migration for existing DBs).
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

  // Migration: add done column if it doesn't exist
  const columns = db.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
  const hasDone = columns.some(c => c.name === 'done');
  if (!hasDone) {
    db.run('ALTER TABLE todos ADD COLUMN done INTEGER NOT NULL DEFAULT 0');
  }
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
    done: row.done === 1,
  };
}

/**
 * Lists all todos sorted by done status (pending first), then creation date (newest first).
 */
export function listTodos(): Todo[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM todos ORDER BY done ASC, created_at DESC'
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
    INSERT INTO todos (id, description, created_at, done)
    VALUES (?, ?, ?, 0)
  `).run(id, data.description, now);

  return {
    id,
    description: data.description,
    createdAt: now,
    done: false,
  };
}

/**
 * Updates a todo's done status.
 *
 * @param id - The todo ID.
 * @param data - Fields to update.
 * @returns The updated todo.
 * @throws If the todo is not found.
 */
export function updateTodo(id: string, data: { done: boolean }): Todo {
  const db = getDb();
  const existing = getTodo(id);
  if (!existing) {
    throw new Error(`Todo not found: ${id}`);
  }

  db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(data.done ? 1 : 0, id);

  return { ...existing, done: data.done };
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

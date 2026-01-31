/**
 * @fileoverview Unit tests for the Todo module.
 *
 * Tests todo CRUD operations, sorting, and error handling.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  initTodoDb,
  listTodos,
  getTodo,
  createTodo,
  deleteTodo,
} from '../../server/todo';
import { initDb, closeDb, setConfigDir } from '../../server/db';

/** Temporary directory for test database files. */
let testDir: string;

/** Set up a temp database before each test. */
beforeEach(async () => {
  testDir = join(tmpdir(), `todo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initTodoDb(db);
});

/** Close the database and clean up after each test. */
afterEach(async () => {
  closeDb();
  setConfigDir(null);
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('Todo Module', () => {
  describe('createTodo', () => {
    test('creates a todo with description', () => {
      const todo = createTodo({ description: 'Buy groceries' });

      expect(todo.id).toBeTruthy();
      expect(todo.description).toBe('Buy groceries');
      expect(todo.createdAt).toBeTruthy();
    });

    test('generates unique IDs', () => {
      const a = createTodo({ description: 'Task A' });
      const b = createTodo({ description: 'Task B' });

      expect(a.id).not.toBe(b.id);
    });
  });

  describe('getTodo', () => {
    test('returns a todo by ID', () => {
      const created = createTodo({ description: 'Test todo' });
      const found = getTodo(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.description).toBe('Test todo');
    });

    test('returns null for nonexistent ID', () => {
      const found = getTodo('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('listTodos', () => {
    test('returns empty array when no todos exist', () => {
      const todos = listTodos();
      expect(todos).toEqual([]);
    });

    test('returns all todos', () => {
      createTodo({ description: 'First' });
      createTodo({ description: 'Second' });
      createTodo({ description: 'Third' });

      const todos = listTodos();
      expect(todos.length).toBe(3);
    });

    test('sorts by date descending (newest first)', () => {
      // Insert with explicit timestamps to guarantee ordering
      const { getDb } = require('../../server/db');
      const db = getDb();
      db.prepare('INSERT INTO todos (id, description, created_at) VALUES (?, ?, ?)').run('a', 'First', '2024-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO todos (id, description, created_at) VALUES (?, ?, ?)').run('b', 'Second', '2024-06-01T00:00:00.000Z');
      db.prepare('INSERT INTO todos (id, description, created_at) VALUES (?, ?, ?)').run('c', 'Third', '2024-12-01T00:00:00.000Z');

      const todos = listTodos();
      // Newest first
      expect(todos[0].id).toBe('c');
      expect(todos[1].id).toBe('b');
      expect(todos[2].id).toBe('a');
    });
  });

  describe('deleteTodo', () => {
    test('deletes an existing todo', () => {
      const todo = createTodo({ description: 'To delete' });
      deleteTodo(todo.id);

      const found = getTodo(todo.id);
      expect(found).toBeNull();
    });

    test('throws for nonexistent ID', () => {
      expect(() => deleteTodo('nonexistent')).toThrow('Todo not found: nonexistent');
    });

    test('does not affect other todos', () => {
      const a = createTodo({ description: 'Keep' });
      const b = createTodo({ description: 'Delete' });

      deleteTodo(b.id);

      const todos = listTodos();
      expect(todos.length).toBe(1);
      expect(todos[0].id).toBe(a.id);
    });
  });
});

/**
 * @fileoverview Unit tests for the daily email module.
 *
 * Tests briefing prompt persistence (get/set) and settings table initialization.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  initDailyEmailDb,
  getBriefingPrompt,
  setBriefingPrompt,
  getLatestBriefing,
  listBriefings,
} from '../../server/daily-email';
import { initDb, closeDb, setConfigDir } from '../../server/db';

/** Temporary directory for test database files. */
let testDir: string;

/** Set up a temp database before each test. */
beforeEach(async () => {
  testDir = join(tmpdir(), `daily-email-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initDailyEmailDb(db);
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

describe('Daily Email Module', () => {
  describe('getBriefingPrompt', () => {
    test('returns default prompt when none is saved', () => {
      const prompt = getBriefingPrompt();
      expect(prompt).toBeTruthy();
      expect(prompt).toContain('productivity assistant');
    });

    test('returns saved prompt after setBriefingPrompt', () => {
      setBriefingPrompt('Custom prompt for testing');
      const prompt = getBriefingPrompt();
      expect(prompt).toBe('Custom prompt for testing');
    });
  });

  describe('setBriefingPrompt', () => {
    test('persists a new prompt', () => {
      setBriefingPrompt('First prompt');
      expect(getBriefingPrompt()).toBe('First prompt');
    });

    test('overwrites an existing prompt', () => {
      setBriefingPrompt('First prompt');
      setBriefingPrompt('Updated prompt');
      expect(getBriefingPrompt()).toBe('Updated prompt');
    });

    test('handles empty string', () => {
      setBriefingPrompt('');
      // Empty string is still a valid value — getBriefingPrompt returns it
      // (the default only applies when no row exists)
      expect(getBriefingPrompt()).toBe('');
    });

    test('handles long prompts', () => {
      const longPrompt = 'A'.repeat(10000);
      setBriefingPrompt(longPrompt);
      expect(getBriefingPrompt()).toBe(longPrompt);
    });

    test('handles special characters', () => {
      const specialPrompt = 'Prompt with "quotes", <tags>, & symbols\nnewlines\ttabs';
      setBriefingPrompt(specialPrompt);
      expect(getBriefingPrompt()).toBe(specialPrompt);
    });
  });

  describe('initDailyEmailDb', () => {
    test('creates settings table without error', () => {
      // Table already created in beforeEach; calling again should be idempotent
      const db = require('../../server/db').getDb();
      initDailyEmailDb(db);

      // Verify we can still read/write
      setBriefingPrompt('test');
      expect(getBriefingPrompt()).toBe('test');
    });

    test('creates daily_briefings table', () => {
      const db = require('../../server/db').getDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_briefings'").all();
      expect(tables.length).toBe(1);
    });
  });

  describe('getLatestBriefing', () => {
    test('returns null when no briefings exist', () => {
      expect(getLatestBriefing()).toBeNull();
    });

    test('returns the most recent briefing', () => {
      const db = require('../../server/db').getDb();
      db.prepare(`
        INSERT INTO daily_briefings (id, html, prompt, todo_count, has_weather, has_recitations, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('b1', '<p>Old</p>', 'prompt1', 3, 0, 0, '2025-01-01T08:00:00Z');
      db.prepare(`
        INSERT INTO daily_briefings (id, html, prompt, todo_count, has_weather, has_recitations, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('b2', '<p>New</p>', 'prompt2', 5, 1, 1, '2025-01-02T08:00:00Z');

      const latest = getLatestBriefing();
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe('b2');
      expect(latest!.html).toBe('<p>New</p>');
      expect(latest!.prompt).toBe('prompt2');
      expect(latest!.todoCount).toBe(5);
      expect(latest!.hasWeather).toBe(true);
      expect(latest!.hasRecitations).toBe(true);
      expect(latest!.createdAt).toBe('2025-01-02T08:00:00Z');
    });
  });

  describe('listBriefings', () => {
    test('returns empty array when no briefings exist', () => {
      expect(listBriefings()).toEqual([]);
    });

    test('returns briefings in reverse chronological order', () => {
      const db = require('../../server/db').getDb();
      for (let i = 1; i <= 5; i++) {
        db.prepare(`
          INSERT INTO daily_briefings (id, html, prompt, todo_count, has_weather, has_recitations, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`b${i}`, `<p>Briefing ${i}</p>`, 'prompt', i, 0, 0, `2025-01-0${i}T08:00:00Z`);
      }

      const briefings = listBriefings();
      expect(briefings.length).toBe(5);
      expect(briefings[0].id).toBe('b5');
      expect(briefings[4].id).toBe('b1');
    });

    test('respects the limit parameter', () => {
      const db = require('../../server/db').getDb();
      for (let i = 1; i <= 10; i++) {
        db.prepare(`
          INSERT INTO daily_briefings (id, html, prompt, todo_count, has_weather, has_recitations, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`b${i}`, `<p>${i}</p>`, 'prompt', 0, 0, 0, `2025-01-${String(i).padStart(2, '0')}T08:00:00Z`);
      }

      const briefings = listBriefings(3);
      expect(briefings.length).toBe(3);
      expect(briefings[0].id).toBe('b10');
    });

    test('correctly converts boolean fields', () => {
      const db = require('../../server/db').getDb();
      db.prepare(`
        INSERT INTO daily_briefings (id, html, prompt, todo_count, has_weather, has_recitations, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('b1', '<p>test</p>', 'prompt', 2, 1, 0, '2025-01-01T08:00:00Z');

      const briefings = listBriefings();
      expect(briefings[0].hasWeather).toBe(true);
      expect(briefings[0].hasRecitations).toBe(false);
      expect(briefings[0].todoCount).toBe(2);
    });
  });
});

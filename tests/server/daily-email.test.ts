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
  });
});

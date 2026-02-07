/**
 * @fileoverview Unit tests for the Feature Flags module.
 *
 * Tests listing, toggling, unknown key rejection, and isFlagEnabled.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  initFeatureFlagsDb,
  listFeatureFlags,
  toggleFeatureFlag,
  isFlagEnabled,
  FLAG_REGISTRY,
} from '../../server/feature-flags';
import { initDb, closeDb, setConfigDir } from '../../server/db';

/** Temporary directory for test database files. */
let testDir: string;

/** Set up a temp database before each test. */
beforeEach(async () => {
  testDir = join(tmpdir(), `feature-flags-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initFeatureFlagsDb(db);
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

describe('Feature Flags Module', () => {
  describe('listFeatureFlags', () => {
    test('returns all registry flags with default disabled', () => {
      const flags = listFeatureFlags();

      expect(flags.length).toBe(FLAG_REGISTRY.length);
      for (const flag of flags) {
        expect(flag.enabled).toBe(false);
        const def = FLAG_REGISTRY.find(f => f.key === flag.key);
        expect(def).toBeTruthy();
        expect(flag.label).toBe(def!.label);
        expect(flag.description).toBe(def!.description);
      }
    });

    test('reflects toggled state', () => {
      toggleFeatureFlag('social-auth', true);
      const flags = listFeatureFlags();
      const socialAuth = flags.find(f => f.key === 'social-auth');

      expect(socialAuth).toBeTruthy();
      expect(socialAuth!.enabled).toBe(true);
    });
  });

  describe('toggleFeatureFlag', () => {
    test('enables a flag', () => {
      const result = toggleFeatureFlag('social-auth', true);

      expect(result.key).toBe('social-auth');
      expect(result.enabled).toBe(true);
      expect(result.label).toBe('Social Auth');
    });

    test('disables a flag', () => {
      toggleFeatureFlag('social-auth', true);
      const result = toggleFeatureFlag('social-auth', false);

      expect(result.enabled).toBe(false);
    });

    test('rejects unknown flag keys', () => {
      expect(() => toggleFeatureFlag('nonexistent-flag', true)).toThrow(
        'Unknown feature flag: nonexistent-flag'
      );
    });
  });

  describe('isFlagEnabled', () => {
    test('returns false for a flag not yet toggled', () => {
      expect(isFlagEnabled('social-auth')).toBe(false);
    });

    test('returns true after enabling a flag', () => {
      toggleFeatureFlag('social-auth', true);
      expect(isFlagEnabled('social-auth')).toBe(true);
    });

    test('returns false after disabling a flag', () => {
      toggleFeatureFlag('social-auth', true);
      toggleFeatureFlag('social-auth', false);
      expect(isFlagEnabled('social-auth')).toBe(false);
    });

    test('returns false for unknown keys', () => {
      expect(isFlagEnabled('nonexistent-flag')).toBe(false);
    });
  });
});

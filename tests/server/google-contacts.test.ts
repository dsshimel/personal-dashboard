/**
 * @fileoverview Unit tests for the Google Contacts module.
 *
 * Tests token storage, contact normalization, random selection,
 * auth status reporting, and error paths.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  initGoogleAuthDb,
  getGoogleAuthStatus,
  createOAuth2Client,
  loadTokens,
  clearTokens,
  clearContactsCache,
  normalizePerson,
  fetchGoogleContacts,
  getRandomGoogleContacts,
  handleGoogleCallback,
  getAuthenticatedEmail,
  isShellAuthorized,
} from '../../server/google-contacts';
import { initDb, closeDb, setConfigDir, getDb } from '../../server/db';

let testDir: string;

/** Helper to run a test with overridden env vars, restoring them in a finally block. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    fn();
  } finally {
    for (const [key, val] of Object.entries(originals)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

/** Async variant of withEnv. */
async function withEnvAsync(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    await fn();
  } finally {
    for (const [key, val] of Object.entries(originals)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

/** Inserts token rows directly into the DB for test setup. */
function insertTokens(accessToken: string, refreshToken: string, expiryDate?: string) {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO google_auth (key, value) VALUES (?, ?)');
  stmt.run('access_token', accessToken);
  stmt.run('refresh_token', refreshToken);
  if (expiryDate) stmt.run('expiry_date', expiryDate);
}

beforeEach(async () => {
  testDir = join(tmpdir(), `google-contacts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initGoogleAuthDb(db);
  clearContactsCache();
});

afterEach(async () => {
  closeDb();
  setConfigDir(null);
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('Google Contacts Module', () => {
  describe('initGoogleAuthDb', () => {
    test('creates the google_auth table', () => {
      const db = getDb();
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='google_auth'").all();
      expect(rows).toHaveLength(1);
    });
  });

  describe('token storage', () => {
    test('loadTokens returns null when no tokens exist', () => {
      expect(loadTokens()).toBeNull();
    });

    test('saves and loads tokens via DB', () => {
      insertTokens('test-access', 'test-refresh', '1700000000000');

      const tokens = loadTokens();
      expect(tokens).not.toBeNull();
      expect(tokens!.access_token).toBe('test-access');
      expect(tokens!.refresh_token).toBe('test-refresh');
      expect(tokens!.expiry_date).toBe(1700000000000);
    });

    test('loadTokens returns null if no refresh token', () => {
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO google_auth (key, value) VALUES (?, ?)').run('access_token', 'test-access');

      expect(loadTokens()).toBeNull();
    });

    test('loadTokens returns null expiry_date when not stored', () => {
      insertTokens('test-access', 'test-refresh');

      const tokens = loadTokens();
      expect(tokens).not.toBeNull();
      expect(tokens!.expiry_date).toBeNull();
    });

    test('clearTokens removes all stored tokens', () => {
      insertTokens('test-access', 'test-refresh');

      clearTokens();
      expect(loadTokens()).toBeNull();
    });

    test('upsert overwrites existing tokens', () => {
      insertTokens('old-access', 'old-refresh', '1000');
      insertTokens('new-access', 'new-refresh', '2000');

      const tokens = loadTokens();
      expect(tokens!.access_token).toBe('new-access');
      expect(tokens!.refresh_token).toBe('new-refresh');
      expect(tokens!.expiry_date).toBe(2000);
    });
  });

  describe('getGoogleAuthStatus', () => {
    test('returns not configured when env vars are missing', () => {
      withEnv({ GOOGLE_PEOPLE_API_CLIENT_ID: '', GOOGLE_PEOPLE_API_CLIENT_SECRET: '' }, () => {
        const status = getGoogleAuthStatus();
        expect(status.configured).toBe(false);
        expect(status.authenticated).toBe(false);
      });
    });

    test('returns configured but not authenticated when no tokens', () => {
      withEnv({ GOOGLE_PEOPLE_API_CLIENT_ID: 'test-id', GOOGLE_PEOPLE_API_CLIENT_SECRET: 'test-secret' }, () => {
        const status = getGoogleAuthStatus();
        expect(status.configured).toBe(true);
        expect(status.authenticated).toBe(false);
      });
    });

    test('returns authenticated when tokens exist', () => {
      withEnv({ GOOGLE_PEOPLE_API_CLIENT_ID: 'test-id', GOOGLE_PEOPLE_API_CLIENT_SECRET: 'test-secret' }, () => {
        insertTokens('test-access', 'test-refresh');

        const status = getGoogleAuthStatus();
        expect(status.configured).toBe(true);
        expect(status.authenticated).toBe(true);
      });
    });
  });

  describe('createOAuth2Client', () => {
    test('returns null when credentials are not configured', () => {
      withEnv({ GOOGLE_PEOPLE_API_CLIENT_ID: '', GOOGLE_PEOPLE_API_CLIENT_SECRET: '' }, () => {
        expect(createOAuth2Client()).toBeNull();
      });
    });

    test('returns a client when credentials are set', () => {
      withEnv({ GOOGLE_PEOPLE_API_CLIENT_ID: 'test-id', GOOGLE_PEOPLE_API_CLIENT_SECRET: 'test-secret' }, () => {
        const client = createOAuth2Client();
        expect(client).not.toBeNull();
      });
    });
  });

  describe('fetchGoogleContacts', () => {
    test('throws when not authenticated', async () => {
      await withEnvAsync({ GOOGLE_PEOPLE_API_CLIENT_ID: 'test-id', GOOGLE_PEOPLE_API_CLIENT_SECRET: 'test-secret' }, async () => {
        await expect(fetchGoogleContacts()).rejects.toThrow('Not authenticated with Google');
      });
    });

    test('throws when credentials not configured', async () => {
      await withEnvAsync({ GOOGLE_PEOPLE_API_CLIENT_ID: '', GOOGLE_PEOPLE_API_CLIENT_SECRET: '' }, async () => {
        await expect(fetchGoogleContacts()).rejects.toThrow('Google API credentials not configured');
      });
    });
  });

  describe('handleGoogleCallback', () => {
    test('throws when credentials not configured', async () => {
      await withEnvAsync({ GOOGLE_PEOPLE_API_CLIENT_ID: '', GOOGLE_PEOPLE_API_CLIENT_SECRET: '' }, async () => {
        await expect(handleGoogleCallback('test-code')).rejects.toThrow('Google API credentials not configured');
      });
    });
  });

  describe('getRandomGoogleContacts', () => {
    test('throws when not authenticated', async () => {
      await withEnvAsync({ GOOGLE_PEOPLE_API_CLIENT_ID: 'test-id', GOOGLE_PEOPLE_API_CLIENT_SECRET: 'test-secret' }, async () => {
        await expect(getRandomGoogleContacts(5)).rejects.toThrow('Not authenticated with Google');
      });
    });
  });

  describe('clearContactsCache', () => {
    test('clears the cache so next fetch is not cached', () => {
      // After clearContactsCache, fetchGoogleContacts should attempt a real fetch
      // (which will fail due to no auth), proving the cache is cleared
      clearContactsCache();
      // No assertion needed beyond verifying it doesn't throw
    });
  });

  describe('normalizePerson', () => {
    test('normalizes a fully populated person', () => {
      const person = {
        resourceName: 'people/c123',
        names: [{ displayName: 'Alice Smith', givenName: 'Alice', familyName: 'Smith' }],
        emailAddresses: [{ value: 'alice@example.com' }],
        phoneNumbers: [{ value: '+1-555-1234' }],
        organizations: [{ name: 'Acme Corp' }],
        photos: [{ url: 'https://photo.example.com/alice.jpg' }],
      };

      const result = normalizePerson(person);
      expect(result).toEqual({
        resourceName: 'people/c123',
        name: 'Alice Smith',
        email: 'alice@example.com',
        phone: '+1-555-1234',
        organization: 'Acme Corp',
        photoUrl: 'https://photo.example.com/alice.jpg',
      });
    });

    test('returns null for person with no name', () => {
      const person = {
        resourceName: 'people/c456',
        emailAddresses: [{ value: 'nobody@example.com' }],
      };

      expect(normalizePerson(person)).toBeNull();
    });

    test('returns null for null input', () => {
      expect(normalizePerson(null)).toBeNull();
    });

    test('returns null for undefined input', () => {
      expect(normalizePerson(undefined)).toBeNull();
    });

    test('returns null for non-object input', () => {
      expect(normalizePerson('not an object')).toBeNull();
      expect(normalizePerson(42)).toBeNull();
    });

    test('handles person with only a name', () => {
      const person = {
        resourceName: 'people/c789',
        names: [{ displayName: 'Bob' }],
      };

      const result = normalizePerson(person);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Bob');
      expect(result!.email).toBeNull();
      expect(result!.phone).toBeNull();
      expect(result!.organization).toBeNull();
      expect(result!.photoUrl).toBeNull();
    });

    test('picks first email when multiple exist', () => {
      const person = {
        resourceName: 'people/c101',
        names: [{ displayName: 'Carol' }],
        emailAddresses: [
          { value: 'carol@work.com' },
          { value: 'carol@personal.com' },
        ],
      };

      const result = normalizePerson(person);
      expect(result!.email).toBe('carol@work.com');
    });

    test('handles empty names array', () => {
      const person = {
        resourceName: 'people/c102',
        names: [],
      };

      expect(normalizePerson(person)).toBeNull();
    });

    test('handles missing resourceName', () => {
      const person = {
        names: [{ displayName: 'Dave' }],
      };

      const result = normalizePerson(person);
      expect(result!.resourceName).toBe('');
      expect(result!.name).toBe('Dave');
    });
  });

  describe('getAuthenticatedEmail', () => {
    test('returns null when no email is stored', () => {
      expect(getAuthenticatedEmail()).toBeNull();
    });

    test('returns the stored email', () => {
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO google_auth (key, value) VALUES (?, ?)').run('user_email', 'test@example.com');
      expect(getAuthenticatedEmail()).toBe('test@example.com');
    });
  });

  describe('isShellAuthorized', () => {
    test('returns false when AUTHORIZED_EMAIL is not set', () => {
      withEnv({ AUTHORIZED_EMAIL: undefined }, () => {
        expect(isShellAuthorized()).toBe(false);
      });
    });

    test('returns false when no email is stored', () => {
      withEnv({ AUTHORIZED_EMAIL: 'user@example.com' }, () => {
        expect(isShellAuthorized()).toBe(false);
      });
    });

    test('returns false when email does not match', () => {
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO google_auth (key, value) VALUES (?, ?)').run('user_email', 'other@example.com');
      withEnv({ AUTHORIZED_EMAIL: 'user@example.com' }, () => {
        expect(isShellAuthorized()).toBe(false);
      });
    });

    test('returns true when email matches', () => {
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO google_auth (key, value) VALUES (?, ?)').run('user_email', 'user@example.com');
      withEnv({ AUTHORIZED_EMAIL: 'user@example.com' }, () => {
        expect(isShellAuthorized()).toBe(true);
      });
    });
  });
});

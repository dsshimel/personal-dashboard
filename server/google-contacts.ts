/**
 * @fileoverview Google Contacts integration via People API.
 *
 * Handles OAuth2 authorization, token storage, and contact fetching.
 * Tokens are persisted in SQLite so the user only needs to authorize once.
 */

import { Database } from 'bun:sqlite';
import { google } from 'googleapis';
import { getDb } from './db.js';

/** A normalized Google Contact. */
export interface GoogleContact {
  resourceName: string;
  name: string;
  email: string | null;
  phone: string | null;
  organization: string | null;
  photoUrl: string | null;
}

/** Stored OAuth2 token set. */
interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number | null;
}

/** In-memory cache for the full contacts list. */
let cachedContacts: GoogleContact[] | null = null;
let cacheExpiry = 0;
/** In-flight fetch promise to prevent concurrent API calls. */
let inFlightFetch: Promise<GoogleContact[]> | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PAGES = 20; // Guard against unbounded pagination (20 × 1000 = 20k contacts)

/**
 * Initializes the google_auth table for token storage.
 */
export function initGoogleAuthDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS google_auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Returns whether Google API credentials are configured and whether the user is authenticated.
 */
export function getGoogleAuthStatus(): { configured: boolean; authenticated: boolean } {
  const configured = !!(process.env.GOOGLE_PEOPLE_API_CLIENT_ID && process.env.GOOGLE_PEOPLE_API_CLIENT_SECRET);
  const authenticated = configured && isAuthenticated();
  return { configured, authenticated };
}

/**
 * Creates an OAuth2 client configured with the Google credentials from env.
 * Returns null if credentials are not set.
 */
export function createOAuth2Client(redirectUri?: string) {
  const clientId = process.env.GOOGLE_PEOPLE_API_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_PEOPLE_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri || 'http://localhost:4001/auth/google/callback',
  );
}

/**
 * Generates the Google OAuth2 consent URL.
 */
export function getGoogleAuthUrl(redirectUri?: string): string | null {
  const client = createOAuth2Client(redirectUri);
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/contacts.readonly'],
  });
}

/**
 * Exchanges an authorization code for tokens and stores them.
 */
export async function handleGoogleCallback(code: string, redirectUri?: string): Promise<void> {
  const client = createOAuth2Client(redirectUri);
  if (!client) throw new Error('Google API credentials not configured');

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('No refresh token received. Try revoking access at https://myaccount.google.com/permissions and reconnecting.');
  }
  if (!tokens.access_token) {
    throw new Error('No access token received from Google.');
  }
  saveTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: typeof tokens.expiry_date === 'number' ? tokens.expiry_date : null,
  });
}

/**
 * Fetches all Google Contacts via the People API.
 * Results are cached in memory for 5 minutes.
 * Concurrent callers share a single in-flight request.
 */
export async function fetchGoogleContacts(redirectUri?: string): Promise<GoogleContact[]> {
  if (cachedContacts && Date.now() < cacheExpiry) {
    return cachedContacts;
  }

  // Return the in-flight promise if another caller is already fetching
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = doFetchGoogleContacts(redirectUri).finally(() => {
    inFlightFetch = null;
  });

  return inFlightFetch;
}

async function doFetchGoogleContacts(redirectUri?: string): Promise<GoogleContact[]> {
  const client = createOAuth2Client(redirectUri);
  if (!client) throw new Error('Google API credentials not configured');

  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated with Google');

  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? undefined,
  });

  // Persist refreshed tokens when the library auto-refreshes
  client.on('tokens', (newTokens) => {
    try {
      const current = loadTokens();
      if (current) {
        saveTokens({
          access_token: newTokens.access_token || current.access_token,
          refresh_token: newTokens.refresh_token || current.refresh_token,
          expiry_date: typeof newTokens.expiry_date === 'number' ? newTokens.expiry_date : current.expiry_date,
        });
      }
    } catch (err) {
      console.error('Failed to persist refreshed tokens:', err);
    }
  });

  const people = google.people({ version: 'v1', auth: client });
  const allContacts: GoogleContact[] = [];
  let nextPageToken: string | undefined;
  let pageCount = 0;

  try {
    do {
      const res = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 1000,
        personFields: 'names,emailAddresses,phoneNumbers,organizations,photos',
        sortOrder: 'FIRST_NAME_ASCENDING',
        pageToken: nextPageToken,
      });

      const connections = res.data.connections || [];
      for (const person of connections) {
        const contact = normalizePerson(person);
        if (contact) allContacts.push(contact);
      }

      nextPageToken = res.data.nextPageToken || undefined;
      pageCount++;
    } while (nextPageToken && pageCount < MAX_PAGES);

    if (pageCount >= MAX_PAGES && nextPageToken) {
      console.warn(`Google Contacts: stopped after ${MAX_PAGES} pages (${allContacts.length} contacts). Some contacts may be missing.`);
    }
  } catch (err: any) {
    if (err?.code === 401 || err?.response?.status === 401) {
      clearTokens();
      throw new Error('Google authentication expired. Please reconnect.');
    }
    throw err;
  }

  cachedContacts = allContacts;
  cacheExpiry = Date.now() + CACHE_TTL_MS;

  return allContacts;
}

/**
 * Returns n random contacts from the full list.
 */
export async function getRandomGoogleContacts(n = 5, redirectUri?: string): Promise<GoogleContact[]> {
  const all = await fetchGoogleContacts(redirectUri);
  if (all.length <= n) return all;

  // Fisher-Yates shuffle on a copy, take first n
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/**
 * Clears stored tokens and the contacts cache.
 */
export function clearTokens(): void {
  const db = getDb();
  db.run('DELETE FROM google_auth');
  cachedContacts = null;
  cacheExpiry = 0;
  inFlightFetch = null;
}

/** Clears only the in-memory contacts cache (useful for testing). */
export function clearContactsCache(): void {
  cachedContacts = null;
  cacheExpiry = 0;
  inFlightFetch = null;
}

// --- Internal helpers ---

function isAuthenticated(): boolean {
  const tokens = loadTokens();
  return !!(tokens && tokens.refresh_token);
}

function saveTokens(tokens: StoredTokens): void {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO google_auth (key, value) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('access_token', tokens.access_token);
    stmt.run('refresh_token', tokens.refresh_token);
    stmt.run('expiry_date', tokens.expiry_date != null ? String(tokens.expiry_date) : '');
  })();
}

export function loadTokens(): StoredTokens | null {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM google_auth').all() as { key: string; value: string }[];
  if (rows.length === 0) return null;

  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!map.refresh_token) return null;

  return {
    access_token: map.access_token || '',
    refresh_token: map.refresh_token,
    expiry_date: map.expiry_date ? Number(map.expiry_date) : null,
  };
}

/**
 * Normalizes a Google People API person resource into a flat GoogleContact.
 * Returns null for contacts with no name (stubs, deleted contacts, etc.).
 */
export function normalizePerson(person: unknown): GoogleContact | null {
  if (!person || typeof person !== 'object') return null;

  const p = person as Record<string, any>;
  const name = p.names?.[0]?.displayName;
  if (!name) return null;

  return {
    resourceName: p.resourceName || '',
    name,
    email: p.emailAddresses?.[0]?.value || null,
    phone: p.phoneNumbers?.[0]?.value || null,
    organization: p.organizations?.[0]?.name || null,
    photoUrl: p.photos?.[0]?.url || null,
  };
}

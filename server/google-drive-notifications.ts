/**
 * @fileoverview Google Drive document change notifications.
 *
 * Monitors Google Docs and Sheets for changes by polling the Drive API
 * for modifiedTime metadata. Checks once per day and creates notifications
 * when watched documents are modified.
 */

import { Database } from 'bun:sqlite';
import { google } from 'googleapis';
import { getDb } from './db.js';
import { createOAuth2Client, loadTokens, saveTokens } from './google-contacts.js';

/** A watched Google document. */
export interface WatchedDocument {
  id: string;
  googleId: string;
  name: string;
  url: string;
  docType: 'doc' | 'sheet';
  lastModified: string | null;
  addedAt: string;
}

/** A change notification for a watched document. */
export interface DocNotification {
  id: string;
  watchedDocumentId: string;
  documentName: string;
  docType: 'doc' | 'sheet';
  url: string;
  modifiedAt: string;
  detectedAt: string;
  read: boolean;
}

interface WatchedDocRow {
  id: string;
  google_id: string;
  name: string;
  url: string;
  doc_type: string;
  last_modified: string | null;
  added_at: string;
}

interface NotificationRow {
  id: string;
  watched_document_id: string;
  document_name: string;
  doc_type: string;
  url: string;
  modified_at: string;
  detected_at: string;
  read: number;
}

/** Interval handle for the scheduler. */
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/** Guard against concurrent checkForChanges calls. */
let checkInProgress = false;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Initializes the notification tables in the database.
 */
export function initNotificationsDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS watched_documents (
      id TEXT PRIMARY KEY,
      google_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      last_modified TEXT,
      added_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS doc_notifications (
      id TEXT PRIMARY KEY,
      watched_document_id TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (watched_document_id) REFERENCES watched_documents(id) ON DELETE CASCADE
    )
  `);

  // Track when we last checked for changes
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Parses a Google Docs or Sheets URL to extract the document ID and type.
 *
 * @returns `{googleId, docType}` or null if the URL is not recognized.
 */
export function parseGoogleDocUrl(url: string): { googleId: string; docType: 'doc' | 'sheet' } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'docs.google.com') return null;

    const parts = parsed.pathname.split('/');
    // Expected: /document/d/{ID}/... or /spreadsheets/d/{ID}/...
    const dIndex = parts.indexOf('d');
    if (dIndex === -1 || dIndex + 1 >= parts.length) return null;

    const googleId = parts[dIndex + 1];
    if (!googleId) return null;

    if (parts.includes('document')) {
      return { googleId, docType: 'doc' };
    } else if (parts.includes('spreadsheets')) {
      return { googleId, docType: 'sheet' };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Creates an authenticated Drive API client.
 */
function getDriveClient() {
  const client = createOAuth2Client();
  if (!client) throw new Error('Google API credentials not configured');

  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated with Google');

  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? undefined,
  });

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

  return google.drive({ version: 'v3', auth: client });
}

/**
 * Adds a document to the watch list.
 * Fetches the document name and current modifiedTime from the Drive API.
 */
export async function addWatchedDocument(url: string): Promise<WatchedDocument> {
  const parsed = parseGoogleDocUrl(url);
  if (!parsed) {
    throw new Error('Invalid Google Docs/Sheets URL. Expected a URL like https://docs.google.com/document/d/... or https://docs.google.com/spreadsheets/d/...');
  }

  const db = getDb();

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM watched_documents WHERE google_id = ?').get(parsed.googleId);
  if (existing) {
    throw new Error('This document is already being watched');
  }

  const drive = getDriveClient();
  const res = await drive.files.get({
    fileId: parsed.googleId,
    fields: 'name,modifiedTime',
  });

  const name = res.data.name || 'Untitled';
  const lastModified = res.data.modifiedTime || null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO watched_documents (id, google_id, name, url, doc_type, last_modified, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, parsed.googleId, name, url, parsed.docType, lastModified, now);

  return {
    id,
    googleId: parsed.googleId,
    name,
    url,
    docType: parsed.docType,
    lastModified,
    addedAt: now,
  };
}

/**
 * Removes a document from the watch list and its associated notifications.
 */
export function removeWatchedDocument(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM watched_documents WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Watched document not found: ${id}`);
  }

  // Foreign key cascade handles notifications
  db.prepare('DELETE FROM watched_documents WHERE id = ?').run(id);
}

/** Lists all watched documents. */
export function listWatchedDocuments(): WatchedDocument[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM watched_documents ORDER BY added_at DESC').all() as WatchedDocRow[];
  return rows.map(row => ({
    id: row.id,
    googleId: row.google_id,
    name: row.name,
    url: row.url,
    docType: row.doc_type as 'doc' | 'sheet',
    lastModified: row.last_modified,
    addedAt: row.added_at,
  }));
}

/** Lists all notifications, newest first, joined with document info. */
export function listNotifications(): DocNotification[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT n.id, n.watched_document_id, w.name as document_name, w.doc_type, w.url,
           n.modified_at, n.detected_at, n.read
    FROM doc_notifications n
    JOIN watched_documents w ON n.watched_document_id = w.id
    ORDER BY n.detected_at DESC
    LIMIT 200
  `).all() as NotificationRow[];

  return rows.map(row => ({
    id: row.id,
    watchedDocumentId: row.watched_document_id,
    documentName: row.document_name,
    docType: row.doc_type as 'doc' | 'sheet',
    url: row.url,
    modifiedAt: row.modified_at,
    detectedAt: row.detected_at,
    read: row.read === 1,
  }));
}

/** Returns the count of unread notifications. */
export function getUnreadCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM doc_notifications WHERE read = 0').get() as { count: number };
  return row.count;
}

/** Marks all notifications as read. */
export function markAllRead(): void {
  const db = getDb();
  db.prepare('UPDATE doc_notifications SET read = 1 WHERE read = 0').run();
}

/**
 * Checks all watched documents for changes.
 * Creates notifications for any documents whose modifiedTime has changed.
 */
export async function checkForChanges(): Promise<number> {
  if (checkInProgress) {
    console.log('Document change check already in progress, skipping');
    return 0;
  }
  checkInProgress = true;

  try {
    return await doCheckForChanges();
  } finally {
    checkInProgress = false;
  }
}

async function doCheckForChanges(): Promise<number> {
  const db = getDb();
  const docs = listWatchedDocuments();
  if (docs.length === 0) return 0;

  let drive;
  try {
    drive = getDriveClient();
  } catch {
    console.error('Cannot check for document changes: not authenticated with Google');
    return 0;
  }

  let changesFound = 0;
  const now = new Date().toISOString();

  for (const doc of docs) {
    try {
      const res = await drive.files.get({
        fileId: doc.googleId,
        fields: 'name,modifiedTime',
      });

      const newModified = res.data.modifiedTime || null;
      const newName = res.data.name || doc.name;

      // Update the document name if it changed
      if (newName !== doc.name) {
        db.prepare('UPDATE watched_documents SET name = ? WHERE id = ?').run(newName, doc.id);
      }

      // Check if modified since last check
      if (newModified && newModified !== doc.lastModified) {
        const notifId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO doc_notifications (id, watched_document_id, modified_at, detected_at, read)
          VALUES (?, ?, ?, ?, 0)
        `).run(notifId, doc.id, newModified, now);

        db.prepare('UPDATE watched_documents SET last_modified = ? WHERE id = ?').run(newModified, doc.id);
        changesFound++;
      }
    } catch (err: any) {
      console.error(`Failed to check document "${doc.name}" (${doc.googleId}):`, err?.message || err);
    }
  }

  // Record the check time
  db.prepare('INSERT OR REPLACE INTO notification_meta (key, value) VALUES (?, ?)').run('last_check', now);

  console.log(`Document change check complete: ${changesFound} change(s) found out of ${docs.length} watched document(s)`);
  return changesFound;
}

/**
 * Starts the notification scheduler.
 * Checks on startup if the last check was >24h ago, then sets a 24h interval.
 */
export function startNotificationScheduler(): void {
  if (schedulerInterval) return;

  const db = getDb();
  const meta = db.prepare("SELECT value FROM notification_meta WHERE key = 'last_check'").get() as { value: string } | null;
  const lastCheck = meta ? new Date(meta.value).getTime() : 0;
  const elapsed = Date.now() - lastCheck;

  if (elapsed >= CHECK_INTERVAL_MS) {
    // Check immediately (async, fire-and-forget)
    checkForChanges().catch(err => console.error('Scheduled document check failed:', err));
  }

  schedulerInterval = setInterval(() => {
    checkForChanges().catch(err => console.error('Scheduled document check failed:', err));
  }, CHECK_INTERVAL_MS);
}

/** Stops the notification scheduler (for testing). */
export function stopNotificationScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

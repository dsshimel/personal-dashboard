/**
 * @fileoverview Personal CRM module for the dashboard.
 *
 * Provides CRUD operations for contacts and interaction logging.
 * Contacts are sorted by "staleness" — least recently interacted first —
 * so you can quickly see who you haven't talked to in a while.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A contact with aggregated interaction metadata. */
export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  socialHandles: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent interaction, or null if never. */
  lastInteraction: string | null;
  /** Total number of logged interactions. */
  interactionCount: number;
}

/** A single interaction log entry. */
export interface Interaction {
  id: string;
  contactId: string;
  note: string;
  /** When the interaction occurred. */
  occurredAt: string;
  /** When this log entry was created. */
  createdAt: string;
}

/** Row shape from the stale-contacts query. */
interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  social_handles: string | null;
  created_at: string;
  updated_at: string;
  last_interaction: string | null;
  interaction_count: number;
}

/** Row shape from the interactions table. */
interface InteractionRow {
  id: string;
  contact_id: string;
  note: string;
  occurred_at: string;
  created_at: string;
}

/**
 * Initializes the CRM tables in the database.
 *
 * @param db - The SQLite database instance.
 */
export function initCrmDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      social_handles TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      note TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    )
  `);
}

/** Generates a UUID v4 string. */
function uuid(): string {
  return crypto.randomUUID();
}

/** Converts a ContactRow to a Contact. */
function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    socialHandles: row.social_handles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastInteraction: row.last_interaction,
    interactionCount: row.interaction_count,
  };
}

/** Converts an InteractionRow to an Interaction. */
function rowToInteraction(row: InteractionRow): Interaction {
  return {
    id: row.id,
    contactId: row.contact_id,
    note: row.note,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Lists all contacts sorted by staleness (least recently interacted first).
 * Contacts with no interactions appear at the top.
 */
export function listContacts(): Contact[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.*,
      MAX(i.occurred_at) as last_interaction,
      COUNT(i.id) as interaction_count
    FROM contacts c
    LEFT JOIN interactions i ON i.contact_id = c.id
    GROUP BY c.id
    ORDER BY last_interaction ASC NULLS FIRST
  `).all() as ContactRow[];

  return rows.map(rowToContact);
}

/**
 * Gets a single contact by ID.
 *
 * @param id - The contact ID.
 * @returns The contact, or null if not found.
 */
export function getContact(id: string): Contact | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT c.*,
      MAX(i.occurred_at) as last_interaction,
      COUNT(i.id) as interaction_count
    FROM contacts c
    LEFT JOIN interactions i ON i.contact_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(id) as ContactRow | null;

  return row ? rowToContact(row) : null;
}

/**
 * Creates a new contact.
 *
 * @param data - Contact fields (name required, others optional).
 * @returns The created contact.
 */
export function createContact(data: {
  name: string;
  email?: string | null;
  phone?: string | null;
  socialHandles?: string | null;
}): Contact {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO contacts (id, name, email, phone, social_handles, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name, data.email || null, data.phone || null, data.socialHandles || null, now, now);

  return {
    id,
    name: data.name,
    email: data.email || null,
    phone: data.phone || null,
    socialHandles: data.socialHandles || null,
    createdAt: now,
    updatedAt: now,
    lastInteraction: null,
    interactionCount: 0,
  };
}

/**
 * Updates an existing contact.
 *
 * @param id - The contact ID.
 * @param data - Fields to update.
 * @returns The updated contact.
 * @throws If the contact is not found.
 */
export function updateContact(id: string, data: {
  name?: string;
  email?: string | null;
  phone?: string | null;
  socialHandles?: string | null;
}): Contact {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Contact not found: ${id}`);
  }

  const now = new Date().toISOString();
  const fields: string[] = ['updated_at = ?'];
  const values: (string | null)[] = [now];

  if (data.name !== undefined) {
    fields.push('name = ?');
    values.push(data.name);
  }
  if (data.email !== undefined) {
    fields.push('email = ?');
    values.push(data.email);
  }
  if (data.phone !== undefined) {
    fields.push('phone = ?');
    values.push(data.phone);
  }
  if (data.socialHandles !== undefined) {
    fields.push('social_handles = ?');
    values.push(data.socialHandles);
  }

  values.push(id);
  db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  const contact = getContact(id);
  if (!contact) throw new Error(`Contact not found after update: ${id}`);
  return contact;
}

/**
 * Deletes a contact and all their interactions (via cascade).
 *
 * @param id - The contact ID.
 * @throws If the contact is not found.
 */
export function deleteContact(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Contact not found: ${id}`);
  }

  db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
}

/**
 * Lists interactions for a contact, newest first.
 *
 * @param contactId - The contact ID.
 * @returns Array of interactions.
 */
export function listInteractions(contactId: string): Interaction[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM interactions WHERE contact_id = ? ORDER BY occurred_at DESC'
  ).all(contactId) as InteractionRow[];

  return rows.map(rowToInteraction);
}

/**
 * Logs a new interaction with a contact.
 *
 * @param contactId - The contact ID.
 * @param data - Interaction details.
 * @returns The created interaction.
 * @throws If the contact is not found.
 */
export function createInteraction(contactId: string, data: {
  note: string;
  occurredAt?: string;
}): Interaction {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
  if (!existing) {
    throw new Error(`Contact not found: ${contactId}`);
  }

  const id = uuid();
  const now = new Date().toISOString();
  const occurredAt = data.occurredAt || now;

  db.prepare(`
    INSERT INTO interactions (id, contact_id, note, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, contactId, data.note, occurredAt, now);

  return {
    id,
    contactId,
    note: data.note,
    occurredAt,
    createdAt: now,
  };
}

/**
 * Deletes a single interaction.
 *
 * @param id - The interaction ID.
 * @throws If the interaction is not found.
 */
export function deleteInteraction(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM interactions WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Interaction not found: ${id}`);
  }

  db.prepare('DELETE FROM interactions WHERE id = ?').run(id);
}

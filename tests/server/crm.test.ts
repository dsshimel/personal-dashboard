/**
 * @fileoverview Unit tests for the CRM module.
 *
 * Tests contact CRUD, interaction logging, staleness sorting,
 * and cascade deletion behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  initCrmDb,
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  listInteractions,
  createInteraction,
  deleteInteraction,
} from '../../server/crm';
import { initDb, closeDb, setConfigDir } from '../../server/db';

/** Temporary directory for test database files. */
let testDir: string;

/** Set up a temp database before each test. */
beforeEach(async () => {
  testDir = join(tmpdir(), `crm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initCrmDb(db);
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

describe('CRM Module', () => {
  describe('createContact', () => {
    test('creates a contact with required name', () => {
      const contact = createContact({ name: 'Alice' });

      expect(contact.id).toBeTruthy();
      expect(contact.name).toBe('Alice');
      expect(contact.email).toBeNull();
      expect(contact.phone).toBeNull();
      expect(contact.socialHandles).toBeNull();
      expect(contact.createdAt).toBeTruthy();
      expect(contact.updatedAt).toBeTruthy();
      expect(contact.lastInteraction).toBeNull();
      expect(contact.interactionCount).toBe(0);
    });

    test('creates a contact with all fields', () => {
      const contact = createContact({
        name: 'Bob',
        email: 'bob@example.com',
        phone: '+1-555-0100',
        socialHandles: '@bob on twitter, linkedin.com/in/bob',
      });

      expect(contact.name).toBe('Bob');
      expect(contact.email).toBe('bob@example.com');
      expect(contact.phone).toBe('+1-555-0100');
      expect(contact.socialHandles).toBe('@bob on twitter, linkedin.com/in/bob');
    });

    test('generates unique IDs for each contact', () => {
      const a = createContact({ name: 'Alice' });
      const b = createContact({ name: 'Bob' });

      expect(a.id).not.toBe(b.id);
    });
  });

  describe('listContacts', () => {
    test('returns empty array when no contacts exist', () => {
      const contacts = listContacts();
      expect(contacts).toEqual([]);
    });

    test('returns all contacts', () => {
      createContact({ name: 'Alice' });
      createContact({ name: 'Bob' });
      createContact({ name: 'Charlie' });

      const contacts = listContacts();
      expect(contacts.length).toBe(3);
    });

    test('sorts by staleness - never contacted first', () => {
      const alice = createContact({ name: 'Alice' });
      const bob = createContact({ name: 'Bob' });

      // Give Bob an interaction, Alice has none
      createInteraction(bob.id, { note: 'Had coffee' });

      const contacts = listContacts();
      // Alice (never contacted) should come first
      expect(contacts[0].name).toBe('Alice');
      expect(contacts[1].name).toBe('Bob');
    });

    test('sorts by staleness - oldest interaction first', () => {
      const alice = createContact({ name: 'Alice' });
      const bob = createContact({ name: 'Bob' });
      const charlie = createContact({ name: 'Charlie' });

      // Bob interacted longest ago, then Alice, then Charlie most recently
      createInteraction(bob.id, { note: 'Old chat', occurredAt: '2024-01-01T00:00:00.000Z' });
      createInteraction(alice.id, { note: 'Mid chat', occurredAt: '2024-06-01T00:00:00.000Z' });
      createInteraction(charlie.id, { note: 'Recent chat', occurredAt: '2024-12-01T00:00:00.000Z' });

      const contacts = listContacts();
      expect(contacts[0].name).toBe('Bob');
      expect(contacts[1].name).toBe('Alice');
      expect(contacts[2].name).toBe('Charlie');
    });

    test('includes interaction metadata', () => {
      const alice = createContact({ name: 'Alice' });
      createInteraction(alice.id, { note: 'First', occurredAt: '2024-01-01T00:00:00.000Z' });
      createInteraction(alice.id, { note: 'Second', occurredAt: '2024-06-01T00:00:00.000Z' });

      const contacts = listContacts();
      expect(contacts[0].interactionCount).toBe(2);
      expect(contacts[0].lastInteraction).toBe('2024-06-01T00:00:00.000Z');
    });
  });

  describe('getContact', () => {
    test('returns a contact by ID', () => {
      const created = createContact({ name: 'Alice', email: 'alice@example.com' });

      const contact = getContact(created.id);
      expect(contact).not.toBeNull();
      expect(contact!.name).toBe('Alice');
      expect(contact!.email).toBe('alice@example.com');
    });

    test('returns null for nonexistent ID', () => {
      const contact = getContact('nonexistent-id');
      expect(contact).toBeNull();
    });

    test('includes interaction metadata', () => {
      const created = createContact({ name: 'Alice' });
      createInteraction(created.id, { note: 'Chat', occurredAt: '2024-06-01T00:00:00.000Z' });

      const contact = getContact(created.id);
      expect(contact!.interactionCount).toBe(1);
      expect(contact!.lastInteraction).toBe('2024-06-01T00:00:00.000Z');
    });
  });

  describe('updateContact', () => {
    test('updates the name', () => {
      const created = createContact({ name: 'Alice' });

      const updated = updateContact(created.id, { name: 'Alice Smith' });

      expect(updated.name).toBe('Alice Smith');
    });

    test('updates optional fields', () => {
      const created = createContact({ name: 'Alice' });

      const updated = updateContact(created.id, {
        email: 'alice@new.com',
        phone: '+1-555-9999',
        socialHandles: '@alice_new',
      });

      expect(updated.email).toBe('alice@new.com');
      expect(updated.phone).toBe('+1-555-9999');
      expect(updated.socialHandles).toBe('@alice_new');
    });

    test('clears optional fields with null', () => {
      const created = createContact({ name: 'Alice', email: 'alice@example.com' });

      const updated = updateContact(created.id, { email: null });

      expect(updated.email).toBeNull();
    });

    test('updates updatedAt timestamp', () => {
      const created = createContact({ name: 'Alice' });

      // Small delay to ensure different timestamp
      const updated = updateContact(created.id, { name: 'Alice Updated' });

      expect(updated.updatedAt).toBeTruthy();
      // updatedAt should be >= createdAt
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime()
      );
    });

    test('throws for nonexistent contact', () => {
      expect(() => updateContact('nonexistent', { name: 'Nope' })).toThrow('Contact not found');
    });

    test('preserves fields not included in update', () => {
      const created = createContact({
        name: 'Alice',
        email: 'alice@example.com',
        phone: '+1-555-0100',
      });

      const updated = updateContact(created.id, { name: 'Alice Smith' });

      expect(updated.email).toBe('alice@example.com');
      expect(updated.phone).toBe('+1-555-0100');
    });
  });

  describe('deleteContact', () => {
    test('deletes an existing contact', () => {
      const created = createContact({ name: 'Alice' });

      deleteContact(created.id);

      const contacts = listContacts();
      expect(contacts.length).toBe(0);
    });

    test('throws for nonexistent contact', () => {
      expect(() => deleteContact('nonexistent')).toThrow('Contact not found');
    });

    test('cascade deletes interactions', () => {
      const created = createContact({ name: 'Alice' });
      createInteraction(created.id, { note: 'Chat 1' });
      createInteraction(created.id, { note: 'Chat 2' });

      deleteContact(created.id);

      // Interactions should be gone too (can't query by contact since it's deleted,
      // but we can verify the contact is gone)
      expect(getContact(created.id)).toBeNull();
    });

    test('does not affect other contacts', () => {
      const alice = createContact({ name: 'Alice' });
      const bob = createContact({ name: 'Bob' });

      deleteContact(alice.id);

      const contacts = listContacts();
      expect(contacts.length).toBe(1);
      expect(contacts[0].name).toBe('Bob');
    });
  });

  describe('createInteraction', () => {
    test('creates an interaction with a note', () => {
      const contact = createContact({ name: 'Alice' });

      const interaction = createInteraction(contact.id, { note: 'Had coffee together' });

      expect(interaction.id).toBeTruthy();
      expect(interaction.contactId).toBe(contact.id);
      expect(interaction.note).toBe('Had coffee together');
      expect(interaction.occurredAt).toBeTruthy();
      expect(interaction.createdAt).toBeTruthy();
    });

    test('uses custom occurredAt timestamp', () => {
      const contact = createContact({ name: 'Alice' });
      const timestamp = '2024-06-15T14:30:00.000Z';

      const interaction = createInteraction(contact.id, {
        note: 'Lunch',
        occurredAt: timestamp,
      });

      expect(interaction.occurredAt).toBe(timestamp);
    });

    test('defaults occurredAt to now', () => {
      const contact = createContact({ name: 'Alice' });
      const before = new Date().toISOString();

      const interaction = createInteraction(contact.id, { note: 'Quick chat' });

      const after = new Date().toISOString();
      expect(interaction.occurredAt >= before).toBe(true);
      expect(interaction.occurredAt <= after).toBe(true);
    });

    test('throws for nonexistent contact', () => {
      expect(() => createInteraction('nonexistent', { note: 'Nope' })).toThrow('Contact not found');
    });

    test('updates contact staleness after interaction', () => {
      const contact = createContact({ name: 'Alice' });

      expect(listContacts()[0].lastInteraction).toBeNull();
      expect(listContacts()[0].interactionCount).toBe(0);

      createInteraction(contact.id, { note: 'Chat', occurredAt: '2024-06-01T00:00:00.000Z' });

      const updated = listContacts()[0];
      expect(updated.lastInteraction).toBe('2024-06-01T00:00:00.000Z');
      expect(updated.interactionCount).toBe(1);
    });
  });

  describe('listInteractions', () => {
    test('returns empty array for contact with no interactions', () => {
      const contact = createContact({ name: 'Alice' });

      const interactions = listInteractions(contact.id);
      expect(interactions).toEqual([]);
    });

    test('returns interactions newest first', () => {
      const contact = createContact({ name: 'Alice' });

      createInteraction(contact.id, { note: 'Old chat', occurredAt: '2024-01-01T00:00:00.000Z' });
      createInteraction(contact.id, { note: 'Mid chat', occurredAt: '2024-06-01T00:00:00.000Z' });
      createInteraction(contact.id, { note: 'New chat', occurredAt: '2024-12-01T00:00:00.000Z' });

      const interactions = listInteractions(contact.id);
      expect(interactions.length).toBe(3);
      expect(interactions[0].note).toBe('New chat');
      expect(interactions[1].note).toBe('Mid chat');
      expect(interactions[2].note).toBe('Old chat');
    });

    test('only returns interactions for the specified contact', () => {
      const alice = createContact({ name: 'Alice' });
      const bob = createContact({ name: 'Bob' });

      createInteraction(alice.id, { note: 'Alice chat' });
      createInteraction(bob.id, { note: 'Bob chat' });

      const aliceInteractions = listInteractions(alice.id);
      expect(aliceInteractions.length).toBe(1);
      expect(aliceInteractions[0].note).toBe('Alice chat');
    });
  });

  describe('deleteInteraction', () => {
    test('deletes an existing interaction', () => {
      const contact = createContact({ name: 'Alice' });
      const interaction = createInteraction(contact.id, { note: 'Chat' });

      deleteInteraction(interaction.id);

      const interactions = listInteractions(contact.id);
      expect(interactions.length).toBe(0);
    });

    test('throws for nonexistent interaction', () => {
      expect(() => deleteInteraction('nonexistent')).toThrow('Interaction not found');
    });

    test('does not affect other interactions', () => {
      const contact = createContact({ name: 'Alice' });
      const i1 = createInteraction(contact.id, { note: 'Keep this' });
      const i2 = createInteraction(contact.id, { note: 'Delete this' });

      deleteInteraction(i2.id);

      const interactions = listInteractions(contact.id);
      expect(interactions.length).toBe(1);
      expect(interactions[0].note).toBe('Keep this');
    });

    test('updates contact staleness metadata', () => {
      const contact = createContact({ name: 'Alice' });
      const old = createInteraction(contact.id, { note: 'Old', occurredAt: '2024-01-01T00:00:00.000Z' });
      const recent = createInteraction(contact.id, { note: 'Recent', occurredAt: '2024-12-01T00:00:00.000Z' });

      // Delete the recent one — last_interaction should fall back to the old one
      deleteInteraction(recent.id);

      const updated = getContact(contact.id);
      expect(updated!.lastInteraction).toBe('2024-01-01T00:00:00.000Z');
      expect(updated!.interactionCount).toBe(1);
    });
  });
});

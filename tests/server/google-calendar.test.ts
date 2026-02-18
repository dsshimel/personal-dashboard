/**
 * @fileoverview Unit tests for the Google Calendar module.
 *
 * Tests event fetching error paths, formatCalendarForPrompt with various
 * event shapes, and clearCalendarCache.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  fetchUpcomingEvents,
  formatCalendarForPrompt,
  clearCalendarCache,
  type CalendarEvent,
} from '../../server/google-calendar';
import { initGoogleAuthDb } from '../../server/google-contacts';
import { initDb, closeDb, setConfigDir } from '../../server/db';

let testDir: string;

/** Helper to run a test with overridden env vars, restoring them in a finally block. */
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

beforeEach(async () => {
  testDir = join(tmpdir(), `google-calendar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initGoogleAuthDb(db);
  clearCalendarCache();
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

describe('Google Calendar Module', () => {
  describe('fetchUpcomingEvents', () => {
    test('throws when not authenticated', async () => {
      await withEnvAsync({ GOOGLE_PEOPLE_API_CLIENT_ID: 'test-id', GOOGLE_PEOPLE_API_CLIENT_SECRET: 'test-secret' }, async () => {
        await expect(fetchUpcomingEvents()).rejects.toThrow('Not authenticated with Google');
      });
    });

    test('throws when credentials not configured', async () => {
      await withEnvAsync({ GOOGLE_PEOPLE_API_CLIENT_ID: '', GOOGLE_PEOPLE_API_CLIENT_SECRET: '' }, async () => {
        await expect(fetchUpcomingEvents()).rejects.toThrow('Google API credentials not configured');
      });
    });
  });

  describe('clearCalendarCache', () => {
    test('does not throw', () => {
      clearCalendarCache();
      // No assertion needed beyond verifying it doesn't throw
    });
  });

  describe('formatCalendarForPrompt', () => {
    test('returns message for empty events list', () => {
      const result = formatCalendarForPrompt([]);
      expect(result).toBe('No upcoming calendar events.');
    });

    test('formats a timed event', () => {
      const events: CalendarEvent[] = [
        {
          id: '1',
          summary: 'Team Standup',
          description: null,
          start: '2026-02-17T09:00:00-05:00',
          end: '2026-02-17T09:30:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('Upcoming calendar events:');
      expect(result).toContain('Team Standup');
      expect(result).toContain('February 17');
      expect(result).not.toContain('[All day]');
    });

    test('formats an all-day event', () => {
      const events: CalendarEvent[] = [
        {
          id: '2',
          summary: 'Company Holiday',
          description: null,
          start: '2026-02-20',
          end: '2026-02-21',
          location: null,
          allDay: true,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('[All day] Company Holiday');
    });

    test('includes location when present', () => {
      const events: CalendarEvent[] = [
        {
          id: '3',
          summary: 'Lunch Meeting',
          description: null,
          start: '2026-02-17T12:00:00-05:00',
          end: '2026-02-17T13:00:00-05:00',
          location: 'Conference Room B',
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('Location: Conference Room B');
    });

    test('includes description when present', () => {
      const events: CalendarEvent[] = [
        {
          id: '4',
          summary: 'Sprint Planning',
          description: 'Review backlog and assign stories',
          start: '2026-02-17T14:00:00-05:00',
          end: '2026-02-17T15:00:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('Review backlog and assign stories');
    });

    test('truncates long descriptions', () => {
      const longDesc = 'A'.repeat(300);
      const events: CalendarEvent[] = [
        {
          id: '5',
          summary: 'Long Meeting',
          description: longDesc,
          start: '2026-02-17T10:00:00-05:00',
          end: '2026-02-17T11:00:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('...');
      // Should be truncated to 200 chars + "..."
      expect(result).not.toContain('A'.repeat(300));
    });

    test('groups events by day', () => {
      const events: CalendarEvent[] = [
        {
          id: '6',
          summary: 'Morning Meeting',
          description: null,
          start: '2026-02-17T09:00:00-05:00',
          end: '2026-02-17T10:00:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
        {
          id: '7',
          summary: 'Afternoon Meeting',
          description: null,
          start: '2026-02-17T14:00:00-05:00',
          end: '2026-02-17T15:00:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
        {
          id: '8',
          summary: 'Tomorrow Event',
          description: null,
          start: '2026-02-18T10:00:00-05:00',
          end: '2026-02-18T11:00:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('February 17');
      expect(result).toContain('February 18');
      expect(result).toContain('Morning Meeting');
      expect(result).toContain('Afternoon Meeting');
      expect(result).toContain('Tomorrow Event');
    });

    test('groups mixed all-day and timed events on the same day', () => {
      const events: CalendarEvent[] = [
        {
          id: '10',
          summary: 'Sprint Day',
          description: null,
          start: '2026-02-17',
          end: '2026-02-18',
          location: null,
          allDay: true,
          htmlLink: null,
        },
        {
          id: '11',
          summary: 'Standup',
          description: null,
          start: '2026-02-17T09:00:00-05:00',
          end: '2026-02-17T09:15:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('[All day] Sprint Day');
      expect(result).toContain('Standup');
      // Both should be under the same day heading (only one February 17 header)
      const feb17Matches = result.match(/February 17/g);
      expect(feb17Matches).toHaveLength(1);
    });

    test('handles event with no description, no location', () => {
      const events: CalendarEvent[] = [
        {
          id: '9',
          summary: 'Quick Sync',
          description: null,
          start: '2026-02-17T16:00:00-05:00',
          end: '2026-02-17T16:15:00-05:00',
          location: null,
          allDay: false,
          htmlLink: null,
        },
      ];
      const result = formatCalendarForPrompt(events);
      expect(result).toContain('Quick Sync');
      expect(result).not.toContain('Location:');
    });
  });
});

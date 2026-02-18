/**
 * @fileoverview Google Calendar integration via Calendar API.
 *
 * Fetches upcoming events from the user's primary calendar.
 * Reuses the OAuth2 tokens stored by the Google Contacts module.
 */

import { google } from 'googleapis';
import { createOAuth2Client, loadTokens, saveTokens, clearTokens } from './google-contacts.js';

/** A normalized Google Calendar event. */
export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string;
  end: string;
  location: string | null;
  allDay: boolean;
  htmlLink: string | null;
}

/** In-memory cache for the events list. */
let cachedEvents: CalendarEvent[] | null = null;
let cacheExpiry = 0;
/** In-flight fetch promise to prevent concurrent API calls. */
let inFlightFetch: Promise<CalendarEvent[]> | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches upcoming events from the user's primary Google Calendar.
 * Results are cached in memory for 5 minutes.
 * Concurrent callers share a single in-flight request.
 *
 * @param weeks - Number of weeks ahead to fetch (default 2).
 * @param redirectUri - OAuth2 redirect URI override.
 */
export async function fetchUpcomingEvents(weeks = 2, redirectUri?: string): Promise<CalendarEvent[]> {
  if (cachedEvents && Date.now() < cacheExpiry) {
    return cachedEvents;
  }

  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = doFetchUpcomingEvents(weeks, redirectUri).finally(() => {
    inFlightFetch = null;
  });

  return inFlightFetch;
}

async function doFetchUpcomingEvents(weeks: number, redirectUri?: string): Promise<CalendarEvent[]> {
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

  const calendar = google.calendar({ version: 'v3', auth: client });
  const now = new Date();
  const timeMax = new Date(now.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);

  try {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = res.data.items || [];
    const events: CalendarEvent[] = items.map((item) => {
      const allDay = !!item.start?.date;
      return {
        id: item.id || '',
        summary: item.summary || '(No title)',
        description: item.description || null,
        start: allDay ? item.start!.date! : item.start?.dateTime || '',
        end: allDay ? item.end!.date! : item.end?.dateTime || '',
        location: item.location || null,
        allDay,
        htmlLink: item.htmlLink || null,
      };
    }).filter(ev => !ev.summary.includes('Marianne @'));

    cachedEvents = events;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    return events;
  } catch (err: any) {
    if (err?.code === 401 || err?.response?.status === 401) {
      clearTokens();
      throw new Error('Google authentication expired. Please reconnect.');
    }
    throw err;
  }
}

/**
 * Formats calendar events as plain text for inclusion in the briefing prompt.
 * Groups events by day.
 */
export function formatCalendarForPrompt(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return 'No upcoming calendar events.';
  }

  const byDay = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    // Extract date portion: all-day events use YYYY-MM-DD, timed events use ISO datetime
    const dateKey = event.allDay
      ? event.start
      : event.start.split('T')[0];
    if (!byDay.has(dateKey)) {
      byDay.set(dateKey, []);
    }
    byDay.get(dateKey)!.push(event);
  }

  const lines: string[] = ['Upcoming calendar events:'];

  for (const [dateKey, dayEvents] of byDay) {
    const date = new Date(dateKey + 'T00:00:00');
    const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    lines.push('');
    lines.push(`${label}:`);

    for (const ev of dayEvents) {
      if (ev.allDay) {
        lines.push(`  [All day] ${ev.summary}`);
      } else {
        const startTime = new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const endTime = new Date(ev.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        lines.push(`  ${startTime} – ${endTime}: ${ev.summary}`);
      }
      if (ev.location) {
        lines.push(`    Location: ${ev.location}`);
      }
      if (ev.description) {
        // Truncate long descriptions
        const desc = ev.description.length > 200
          ? ev.description.substring(0, 200) + '...'
          : ev.description;
        lines.push(`    ${desc}`);
      }
    }
  }

  return lines.join('\n');
}

/** Clears the in-memory calendar cache (useful for testing). */
export function clearCalendarCache(): void {
  cachedEvents = null;
  cacheExpiry = 0;
  inFlightFetch = null;
}

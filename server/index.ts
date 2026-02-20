/**
 * @fileoverview Main Express server with WebSocket support for Claude Code communication.
 *
 * Provides REST API endpoints for session management and WebSocket connections
 * for real-time command execution and response streaming. Includes message
 * buffering for client reconnection support.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClaudeCodeManager } from './claude-code.js';
import { loadProjects, addProject, removeProject, updateProjectConversation, listProjectConversations, addConversationToProject, removeConversationFromProject, initProjectsDb } from './projects.js';
import { initCrmDb, listContacts, createContact, updateContact, deleteContact, listInteractions, createInteraction, deleteInteraction } from './crm.js';
import { initTodoDb, listTodos, createTodo, updateTodo, deleteTodo } from './todo.js';
import { initDailyEmailDb, startDailyEmailScheduler, getBriefingPrompt, setBriefingPrompt, sendDailyDigest, generateBriefingPreview, getLatestBriefing, listBriefings } from './daily-email.js';
import { initRecitationsDb, listRecitations, createRecitation, updateRecitation, deleteRecitation } from './recitations.js';
import { initResearchDb, listTopics, createTopic, updateTopic, deleteTopic, listArticles, deleteArticle, generateResearchArticles } from './research.js';
import { initFeatureFlagsDb, listFeatureFlags, toggleFeatureFlag } from './feature-flags.js';
import { initGoogleAuthDb, getGoogleAuthStatus, getGoogleAuthUrl, handleGoogleCallback, clearTokens as clearGoogleTokens, fetchGoogleContacts, getRandomGoogleContacts } from './google-contacts.js';
import { fetchUpcomingEvents, clearCalendarCache } from './google-calendar.js';
import { getWeatherLocation, setWeatherLocation, geocodeLocation, fetchConfiguredWeather } from './weather.js';
import { initDb } from './db.js';
import { logToFile, initLogger } from './file-logger.js';
import { metricsMiddleware, metricsHandler, clientMetricsHandler, wsConnectionsActive, wsMessagesTotal, claudeCommandDuration, claudeCommandsTotal, claudeSessionsActive } from './telemetry.js';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

initLogger('main');

// Initialize the shared SQLite database
const db = initDb();
initProjectsDb(db);
initCrmDb(db);
initTodoDb(db);
initDailyEmailDb(db);
initRecitationsDb(db);
initResearchDb(db);
initFeatureFlagsDb(db);
initGoogleAuthDb(db);

startDailyEmailScheduler();

const PORT = process.env.PORT || 4001;
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();

/** Maximum messages to buffer per session for reconnection support. */
const MESSAGE_BUFFER_SIZE = 1000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

/** Maps tabId to their ClaudeCodeManager instances (supports multiple tabs per connection). */
const tabManagers = new Map<string, ClaudeCodeManager>();

/** Maps tabId to their current session ID. */
const tabSessions = new Map<string, string>();

/** Maps WebSocket connections to their set of active tab IDs. */
const connectionTabs = new Map<WebSocket, Set<string>>();

/** Maps session IDs to their ClaudeCodeManager instances for reconnection support. */
const sessionManagers = new Map<string, ClaudeCodeManager>();

/** All connected clients for broadcasting server logs. */
const allClients = new Set<WebSocket>();

/** Message stored in buffer for reconnection support. */
interface BufferedMessage {
  /** Sequential ID for ordering and sync. */
  id: number;
  /** Message type (output, error, status, complete). */
  type: string;
  /** Message content. */
  content: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** Buffered messages per session ID for reconnection. */
const sessionMessages = new Map<string, BufferedMessage[]>();

/** Global counter for message IDs. */
let globalMessageId = 0;

/** Returns the next sequential message ID. */
function getNextMessageId(): number {
  return ++globalMessageId;
}

/**
 * Buffers a message for a session, maintaining a rolling window of MESSAGE_BUFFER_SIZE.
 *
 * @param sessionId - The session to buffer the message for.
 * @param type - Message type.
 * @param content - Message content.
 * @returns The buffered message with assigned ID.
 */
function bufferMessage(sessionId: string, type: string, content: string): BufferedMessage {
  const message: BufferedMessage = {
    id: getNextMessageId(),
    type,
    content,
    timestamp: new Date().toISOString()
  };

  if (!sessionMessages.has(sessionId)) {
    sessionMessages.set(sessionId, []);
  }

  const messages = sessionMessages.get(sessionId)!;
  messages.push(message);

  // Keep only the last MESSAGE_BUFFER_SIZE messages
  if (messages.length > MESSAGE_BUFFER_SIZE) {
    messages.shift();
  }

  return message;
}

/**
 * Retrieves buffered messages since a given ID for reconnection sync.
 *
 * @param sessionId - The session to get messages for.
 * @param sinceId - Return messages with ID greater than this.
 * @returns Array of buffered messages.
 */
function getMessagesSince(sessionId: string, sinceId: number): BufferedMessage[] {
  const messages = sessionMessages.get(sessionId);
  if (!messages) return [];

  return messages.filter(m => m.id > sinceId);
}

/**
 * Broadcasts a log message to all connected WebSocket clients.
 *
 * @param level - Log severity level.
 * @param message - Log message content.
 */
function broadcastLog(level: 'info' | 'warn' | 'error', message: string) {
  logToFile(level, message);

  const logMessage = JSON.stringify({
    type: 'log',
    level,
    content: message,
    timestamp: new Date().toISOString()
  });

  for (const client of allClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(logMessage);
    }
  }
}

// Intercept console methods to broadcast logs to connected clients
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args: unknown[]) => {
  originalConsoleLog(...args);
  broadcastLog('info', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
};

console.warn = (...args: unknown[]) => {
  originalConsoleWarn(...args);
  broadcastLog('warn', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
};

console.error = (...args: unknown[]) => {
  originalConsoleError(...args);
  broadcastLog('error', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
};

// Enable CORS and JSON body parsing
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-request-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// Metrics middleware — records HTTP request duration and count
app.use(metricsMiddleware);

// Prometheus scrape endpoint
app.get('/metrics', metricsHandler);

// Client-pushed metrics endpoint (Web Vitals, WS latency, etc.)
app.post('/metrics/client', clientMetricsHandler);

// Restart the Grafana Docker container
app.post('/grafana/restart', async (_req, res) => {
  console.log('Grafana restart requested...');
  try {
    const proc = Bun.spawn(['docker', 'restart', 'dashboard-grafana'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log('Grafana container restarted successfully');
      res.json({ status: 'ok' });
    } else {
      const stderr = await new Response(proc.stderr).text();
      console.error('Failed to restart Grafana:', stderr);
      res.status(500).json({ error: stderr.trim() || 'Failed to restart Grafana' });
    }
  } catch (error) {
    console.error('Failed to restart Grafana:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to restart Grafana' });
  }
});

// Git pull to update the codebase
app.post('/git/pull', async (_req, res) => {
  console.log('Git pull requested...');
  try {
    const proc = Bun.spawn(['git', 'pull'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) {
      console.log('Git pull succeeded:', stdout.trim());
      res.json({ status: 'ok', output: stdout.trim() });
    } else {
      console.error('Git pull failed:', stderr);
      res.status(500).json({ error: stderr.trim() || 'Git pull failed' });
    }
  } catch (error) {
    console.error('Git pull failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Git pull failed' });
  }
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', connections: connectionTabs.size, tabs: tabManagers.size });
});

// Heartbeat endpoint for restart watcher monitoring
app.get('/heartbeat', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Restart the server (signals the watcher process to restart)
app.post('/restart', async (_req, res) => {
  console.log('Restart requested - signaling watcher process...');

  // Notify all WebSocket clients that we're restarting
  const restartMessage = JSON.stringify({ type: 'status', content: 'restarting' });
  for (const client of allClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(restartMessage);
    }
  }

  // Respond to the HTTP request
  res.json({ status: 'restarting' });

  // Create the signal file that the watcher process is monitoring
  const signalFile = join(WORKING_DIR, '.restart-signal');
  await writeFile(signalFile, new Date().toISOString());

  console.log('Restart signal sent to watcher');
});

// List all projects
app.get('/projects', async (_req, res) => {
  try {
    const projects = await loadProjects();
    res.json(projects);
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Add a new project
app.post('/projects', async (req, res) => {
  try {
    const { directory } = req.body;
    if (!directory || typeof directory !== 'string') {
      res.status(400).json({ error: 'directory is required' });
      return;
    }
    const project = await addProject(directory);
    console.log(`Project added: ${project.name} (${project.directory})`);
    res.json(project);
  } catch (error) {
    console.error('Error adding project:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to add project' });
  }
});

// Remove a project
app.delete('/projects/:id', async (req, res) => {
  try {
    await removeProject(req.params.id);
    console.log(`Project removed: ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error removing project:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to remove project' });
  }
});

// List conversations for a project
app.get('/projects/:id/conversations', async (req, res) => {
  try {
    const projects = await loadProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const conversations = await listProjectConversations(project.directory);
    res.json(conversations);
  } catch (error) {
    console.error('Error listing project conversations:', error);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Add a conversation to a project
app.post('/projects/:id/conversations', async (req, res) => {
  try {
    const { conversationId } = req.body;
    if (!conversationId || typeof conversationId !== 'string') {
      res.status(400).json({ error: 'conversationId is required' });
      return;
    }
    await addConversationToProject(req.params.id, conversationId);
    console.log(`Conversation ${conversationId} added to project ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error adding conversation to project:', error);
    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to add conversation' });
  }
});

// Remove a conversation from a project
app.delete('/projects/:id/conversations/:conversationId', async (req, res) => {
  try {
    await removeConversationFromProject(req.params.id, req.params.conversationId);
    console.log(`Conversation ${req.params.conversationId} removed from project ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error removing conversation from project:', error);
    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to remove conversation' });
  }
});

// --- CRM Endpoints ---

// List all contacts (sorted by staleness)
app.get('/crm/contacts', (_req, res) => {
  try {
    const contacts = listContacts();
    res.json(contacts);
  } catch (error) {
    console.error('Error listing contacts:', error);
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

// Create a new contact
app.post('/crm/contacts', (req, res) => {
  try {
    const { name, email, phone, socialHandles } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const contact = createContact({ name, email, phone, socialHandles });
    console.log(`Contact created: ${contact.name}`);
    res.json(contact);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create contact' });
  }
});

// Update a contact
app.put('/crm/contacts/:id', (req, res) => {
  try {
    const { name, email, phone, socialHandles } = req.body;
    const contact = updateContact(req.params.id, { name, email, phone, socialHandles });
    console.log(`Contact updated: ${contact.name}`);
    res.json(contact);
  } catch (error) {
    console.error('Error updating contact:', error);
    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to update contact' });
  }
});

// Delete a contact
app.delete('/crm/contacts/:id', (req, res) => {
  try {
    deleteContact(req.params.id);
    console.log(`Contact deleted: ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to delete contact' });
  }
});

// List interactions for a contact
app.get('/crm/contacts/:id/interactions', (req, res) => {
  try {
    const interactions = listInteractions(req.params.id);
    res.json(interactions);
  } catch (error) {
    console.error('Error listing interactions:', error);
    res.status(500).json({ error: 'Failed to list interactions' });
  }
});

// Log a new interaction
app.post('/crm/contacts/:id/interactions', (req, res) => {
  try {
    const { note, occurredAt } = req.body;
    if (!note || typeof note !== 'string') {
      res.status(400).json({ error: 'note is required' });
      return;
    }
    const interaction = createInteraction(req.params.id, { note, occurredAt });
    console.log(`Interaction logged for contact ${req.params.id}`);
    res.json(interaction);
  } catch (error) {
    console.error('Error creating interaction:', error);
    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to create interaction' });
  }
});

// Delete an interaction
app.delete('/crm/interactions/:id', (req, res) => {
  try {
    deleteInteraction(req.params.id);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting interaction:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to delete interaction' });
  }
});

// --- Google Contacts Endpoints ---

const OAUTH_REDIRECT_URI = 'http://localhost:4001/auth/google/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:6969';

// Check if Google API is configured and authenticated
app.get('/google/auth/status', (_req, res) => {
  res.json(getGoogleAuthStatus());
});

// Get the Google OAuth consent URL
app.get('/google/auth/url', (_req, res) => {
  const url = getGoogleAuthUrl(OAUTH_REDIRECT_URI);
  if (!url) {
    res.status(400).json({ error: 'Google API credentials not configured' });
    return;
  }
  res.json({ url });
});

// OAuth callback — exchanges code for tokens, redirects to frontend
app.get('/auth/google/callback', async (req, res) => {
  const code = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
  if (!code || typeof code !== 'string') {
    res.status(400).send('Missing authorization code');
    return;
  }
  try {
    await handleGoogleCallback(code, OAUTH_REDIRECT_URI);
    res.redirect(`${FRONTEND_URL}/?google_auth=success`);
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    res.redirect(`${FRONTEND_URL}/?google_auth=error`);
  }
});

// Disconnect Google account
app.post('/google/auth/disconnect', (_req, res) => {
  clearGoogleTokens();
  console.log('Google account disconnected');
  res.json({ status: 'ok' });
});

// List all Google Contacts
app.get('/google/contacts', async (_req, res) => {
  try {
    const contacts = await fetchGoogleContacts(OAUTH_REDIRECT_URI);
    res.json(contacts);
  } catch (error: any) {
    if (error.message?.includes('Not authenticated') || error.message?.includes('authentication expired')) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error fetching Google contacts:', error);
    res.status(500).json({ error: 'Failed to fetch Google contacts' });
  }
});

// Get 5 random Google Contacts
app.get('/google/contacts/random', async (_req, res) => {
  try {
    const contacts = await getRandomGoogleContacts(5, OAUTH_REDIRECT_URI);
    res.json(contacts);
  } catch (error: any) {
    if (error.message?.includes('Not authenticated') || error.message?.includes('authentication expired')) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error fetching random Google contacts:', error);
    res.status(500).json({ error: 'Failed to fetch random Google contacts' });
  }
});

// List upcoming Google Calendar events
app.get('/google/calendar/events', async (req, res) => {
  try {
    if (req.query.refresh === 'true') clearCalendarCache();
    const events = await fetchUpcomingEvents(4, OAUTH_REDIRECT_URI);
    res.json(events);
  } catch (error: any) {
    if (error.message?.includes('Not authenticated') || error.message?.includes('authentication expired')) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error fetching Google Calendar events:', error);
    res.status(500).json({ error: 'Failed to fetch Google Calendar events' });
  }
});

// --- Todo Endpoints ---

app.get('/todos', (req, res) => {
  try {
    const doneParam = req.query.done;
    const done = doneParam === 'true' ? true : doneParam === 'false' ? false : undefined;
    const todos = listTodos(done);
    res.json(todos);
  } catch (error) {
    console.error('Error listing todos:', error);
    res.status(500).json({ error: 'Failed to list todos' });
  }
});

app.post('/todos', (req, res) => {
  try {
    const { description } = req.body;
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    const todo = createTodo({ description });
    console.log(`Todo created: ${todo.description.substring(0, 50)}`);
    res.json(todo);
  } catch (error) {
    console.error('Error creating todo:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create todo' });
  }
});

app.put('/todos/:id', (req, res) => {
  try {
    const { done, description } = req.body;
    if (done === undefined && description === undefined) {
      res.status(400).json({ error: 'done (boolean) or description (string) is required' });
      return;
    }
    const data: { done?: boolean; description?: string } = {};
    if (typeof done === 'boolean') data.done = done;
    if (typeof description === 'string' && description.trim()) data.description = description.trim();
    const todo = updateTodo(req.params.id, data);
    if (done !== undefined) console.log(`Todo ${done ? 'completed' : 'reopened'}: ${todo.description.substring(0, 50)}`);
    if (description !== undefined) console.log(`Todo renamed: ${todo.description.substring(0, 50)}`);
    res.json(todo);
  } catch (error) {
    console.error('Error updating todo:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to update todo' });
  }
});

app.delete('/todos/:id', (req, res) => {
  try {
    deleteTodo(req.params.id);
    console.log(`Todo deleted: ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting todo:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to delete todo' });
  }
});

// --- Daily Briefing Endpoints ---

app.get('/briefing/prompt', (_req, res) => {
  try {
    const prompt = getBriefingPrompt();
    res.json({ prompt });
  } catch (error) {
    console.error('Error getting briefing prompt:', error);
    res.status(500).json({ error: 'Failed to get briefing prompt' });
  }
});

app.put('/briefing/prompt', (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    setBriefingPrompt(prompt);
    console.log('Briefing prompt updated');
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error updating briefing prompt:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to update briefing prompt' });
  }
});

app.post('/briefing/send-test', async (_req, res) => {
  try {
    await sendDailyDigest();
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error sending test briefing:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to send test briefing' });
  }
});

app.get('/briefing/latest', (_req, res) => {
  try {
    const briefing = getLatestBriefing();
    if (!briefing) {
      res.status(404).json({ error: 'No briefings generated yet' });
      return;
    }
    res.json(briefing);
  } catch (error) {
    console.error('Error getting latest briefing:', error);
    res.status(500).json({ error: 'Failed to get latest briefing' });
  }
});

app.get('/briefing/history', (_req, res) => {
  try {
    const briefings = listBriefings();
    res.json(briefings);
  } catch (error) {
    console.error('Error listing briefings:', error);
    res.status(500).json({ error: 'Failed to list briefings' });
  }
});

app.post('/briefing/generate', async (_req, res) => {
  try {
    const briefing = await generateBriefingPreview((step: string) => {
      const msg = JSON.stringify({
        type: 'briefing-progress',
        content: step,
        timestamp: new Date().toISOString(),
      });
      for (const client of allClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    });
    res.json(briefing);
  } catch (error) {
    console.error('Error generating briefing preview:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate briefing preview' });
  }
});

// --- Weather Endpoints ---

app.get('/weather', async (_req, res) => {
  try {
    const weather = await fetchConfiguredWeather();
    if (!weather) {
      res.status(404).json({ error: 'No weather location configured. POST /weather/location to set one.' });
      return;
    }
    res.json(weather);
  } catch (error) {
    console.error('Error fetching weather:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch weather' });
  }
});

app.get('/weather/location', (_req, res) => {
  try {
    const location = getWeatherLocation();
    if (!location) {
      res.status(404).json({ error: 'No weather location configured' });
      return;
    }
    res.json(location);
  } catch (error) {
    console.error('Error getting weather location:', error);
    res.status(500).json({ error: 'Failed to get weather location' });
  }
});

app.post('/weather/location', async (req, res) => {
  try {
    const { name, latitude, longitude } = req.body;

    if (name && !latitude && !longitude) {
      // Geocode by name
      const location = await geocodeLocation(name);
      if (!location) {
        res.status(404).json({ error: `Could not find location: ${name}` });
        return;
      }
      setWeatherLocation(location);
      console.log(`Weather location set to ${location.name} (${location.latitude}, ${location.longitude})`);
      res.json(location);
      return;
    }

    if (typeof latitude === 'number' && typeof longitude === 'number') {
      const locationName = name || `${latitude}, ${longitude}`;
      const location = { latitude, longitude, name: locationName };
      setWeatherLocation(location);
      console.log(`Weather location set to ${locationName}`);
      res.json(location);
      return;
    }

    res.status(400).json({ error: 'Provide either {name} for geocoding or {latitude, longitude} for exact coordinates' });
  } catch (error) {
    console.error('Error setting weather location:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to set weather location' });
  }
});

// --- Recitation Endpoints ---

app.get('/recitations', (_req, res) => {
  try {
    const recitations = listRecitations();
    res.json(recitations);
  } catch (error) {
    console.error('Error listing recitations:', error);
    res.status(500).json({ error: 'Failed to list recitations' });
  }
});

app.post('/recitations', (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const recitation = createRecitation({ title, content });
    console.log(`Recitation created: ${recitation.title}`);
    res.json(recitation);
  } catch (error) {
    console.error('Error creating recitation:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create recitation' });
  }
});

app.put('/recitations/:id', (req, res) => {
  try {
    const { title, content, done } = req.body;
    const recitation = updateRecitation(req.params.id, { title, content, done });
    console.log(`Recitation updated: ${recitation.title}`);
    res.json(recitation);
  } catch (error) {
    console.error('Error updating recitation:', error);
    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to update recitation' });
  }
});

app.delete('/recitations/:id', (req, res) => {
  try {
    deleteRecitation(req.params.id);
    console.log(`Recitation deleted: ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting recitation:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to delete recitation' });
  }
});

// ---------------------------------------------------------------------------
// Research endpoints
// ---------------------------------------------------------------------------

app.get('/research/topics', (_req, res) => {
  try {
    const topics = listTopics();
    res.json(topics);
  } catch (error) {
    console.error('Error listing topics:', error);
    res.status(500).json({ error: 'Failed to list topics' });
  }
});

app.post('/research/topics', (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const topic = createTopic({ name, description });
    console.log(`Topic created: ${topic.id} (${topic.name})`);
    res.json(topic);
  } catch (error) {
    console.error('Error creating topic:', error);
    res.status(500).json({ error: 'Failed to create topic' });
  }
});

app.put('/research/topics/:id', (req, res) => {
  try {
    const { name, description } = req.body;
    const topic = updateTopic(req.params.id, { name, description });
    console.log(`Topic updated: ${topic.id} (${topic.name})`);
    res.json(topic);
  } catch (error) {
    console.error('Error updating topic:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to update topic' });
  }
});

app.delete('/research/topics/:id', (req, res) => {
  try {
    deleteTopic(req.params.id);
    console.log(`Topic deleted: ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting topic:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to delete topic' });
  }
});

app.get('/research/topics/:id/articles', (req, res) => {
  try {
    const articles = listArticles(req.params.id);
    res.json(articles);
  } catch (error) {
    console.error('Error listing articles:', error);
    res.status(500).json({ error: 'Failed to list articles' });
  }
});

app.delete('/research/articles/:id', (req, res) => {
  try {
    deleteArticle(req.params.id);
    console.log(`Article deleted: ${req.params.id}`);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting article:', error);
    res.status(404).json({ error: error instanceof Error ? error.message : 'Failed to delete article' });
  }
});

app.post('/research/generate', async (_req, res) => {
  try {
    const articles = await generateResearchArticles((step) => console.log(`[research] ${step}`));
    res.json({ status: 'ok', articlesGenerated: articles.length, articles });
  } catch (error) {
    console.error('Error generating research:', error);
    res.status(500).json({ error: 'Failed to generate research' });
  }
});

// --- Feature Flags Endpoints ---

app.get('/feature-flags', (_req, res) => {
  try {
    const flags = listFeatureFlags();
    res.json(flags);
  } catch (error) {
    console.error('Error listing feature flags:', error);
    res.status(500).json({ error: 'Failed to list feature flags' });
  }
});

app.put('/feature-flags/:key', (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    const flag = toggleFeatureFlag(req.params.key, enabled);
    console.log(`Feature flag ${flag.key} ${enabled ? 'enabled' : 'disabled'}`);
    res.json(flag);
  } catch (error) {
    console.error('Error toggling feature flag:', error);
    const statusCode = error instanceof Error && error.message.includes('Unknown') ? 404 : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to toggle feature flag' });
  }
});

// Get conversation history for a session
app.get('/sessions/:sessionId/history', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const claudeDir = join(homedir(), '.claude', 'projects');
    const projectDirs = await readdir(claudeDir, { withFileTypes: true });

    // Find the session file
    let sessionFile: string | null = null;
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const filePath = join(claudeDir, projectDir.name, `${sessionId}.jsonl`);
      try {
        await Bun.file(filePath).stat();
        sessionFile = filePath;
        break;
      } catch {
        // File doesn't exist in this project dir
      }
    }

    if (!sessionFile) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const content = await readFile(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const messages: Array<{
      type: 'input' | 'output' | 'error' | 'status';
      content: string;
      timestamp: string;
    }> = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'user' && parsed.message) {
          let text = '';
          if (typeof parsed.message.content === 'string') {
            text = parsed.message.content;
          } else if (Array.isArray(parsed.message.content)) {
            const textBlock = parsed.message.content.find(
              (c: {type: string; text?: string}) => c.type === 'text' && c.text
            );
            text = textBlock?.text || '';
          }
          if (text) {
            messages.push({
              type: 'input',
              content: text,
              timestamp: parsed.timestamp || new Date().toISOString(),
            });
          }
        } else if (parsed.type === 'assistant' && parsed.message) {
          // Extract text from assistant message content
          if (Array.isArray(parsed.message.content)) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                messages.push({
                  type: 'output',
                  content: block.text,
                  timestamp: parsed.timestamp || new Date().toISOString(),
                });
              }
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    res.json(messages);
  } catch (error) {
    console.error('Error fetching session history:', error);
    res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

// List available sessions
app.get('/sessions', async (_req, res) => {
  try {
    const claudeDir = join(homedir(), '.claude', 'projects');
    const projectDirs = await readdir(claudeDir, { withFileTypes: true });

    // Build a map from Claude directory hash to dashboard project ID
    // Claude stores projects as e.g. "C--Users-dsshi-Documents-repos-foo"
    // derived from "C:\Users\dsshi\Documents\repos\foo"
    const allProjects = await loadProjects();
    const dirHashToProjectId = new Map<string, string>();
    for (const p of allProjects) {
      const hash = p.directory.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-');
      dirHashToProjectId.set(hash, p.id);
    }

    const sessions: Array<{
      id: string;
      name: string;
      lastModified: Date;
      project: string;
      projectId: string | null;
    }> = [];

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      const projectPath = join(claudeDir, projectDir.name);
      try {
        const files = await readdir(projectPath, { withFileTypes: true });

        for (const file of files) {
          if (file.name.endsWith('.jsonl')) {
            const sessionId = file.name.replace('.jsonl', '');
            const filePath = join(projectPath, file.name);

            // Get file stats for last modified time
            const stats = await Bun.file(filePath).stat();

            // Try to find session name from slug or first user message
            let name = sessionId.substring(0, 8) + '...';
            try {
              const content = await readFile(filePath, 'utf-8');
              const lines = content.split('\n');

              // Search for slug or first user message
              for (const line of lines.slice(0, 20)) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line);

                  // Use slug if available (e.g., "fancy-exploring-taco")
                  if (parsed.slug && typeof parsed.slug === 'string') {
                    // Convert slug to readable name: "fancy-exploring-taco" -> "Fancy Exploring Taco"
                    name = parsed.slug
                      .split('-')
                      .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
                      .join(' ');
                    break;
                  }

                  // Fall back to user message content
                  if (parsed.type === 'user' && parsed.message) {
                    let text = '';
                    // Handle both string and array content
                    if (typeof parsed.message.content === 'string') {
                      text = parsed.message.content;
                    } else if (Array.isArray(parsed.message.content)) {
                      const textBlock = parsed.message.content.find(
                        (c: {type: string; text?: string}) => c.type === 'text' && c.text
                      );
                      text = textBlock?.text || '';
                    }
                    if (text) {
                      name = text.replace(/\s+/g, ' ').trim().substring(0, 80);
                      break;
                    }
                  }
                } catch {
                  // Skip invalid JSON lines
                }
              }
            } catch {
              // Ignore file read errors
            }

            sessions.push({
              id: sessionId,
              name,
              lastModified: stats?.mtime || new Date(),
              project: projectDir.name,
              projectId: dirHashToProjectId.get(projectDir.name) || null,
            });
          }
        }
      } catch {
        // Ignore errors reading project directories
      }
    }

    // Sort by last modified, newest first
    sessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    res.json(sessions.slice(0, 50)); // Return top 50 sessions
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Get missed messages since a given message ID
app.get('/sessions/:sessionId/messages', (req, res) => {
  const { sessionId } = req.params;
  const sinceId = parseInt(req.query.since as string) || 0;

  const messages = getMessagesSince(sessionId, sinceId);
  res.json({
    messages,
    latestId: messages.length > 0 ? messages[messages.length - 1].id : sinceId
  });
});

/**
 * Sets up event listeners on a manager to forward output to a WebSocket.
 * Includes tabId in all outgoing messages for client-side routing.
 * Returns a cleanup function to remove the listeners.
 */
function attachManagerToWebSocket(
  manager: ClaudeCodeManager,
  ws: WebSocket,
  tabId: string,
  getSessionId: () => string | undefined
): () => void {
  const outputHandler = (data: { type: string; content: string }) => {
    const sessionId = getSessionId();
    if (sessionId) {
      const buffered = bufferMessage(sessionId, data.type, data.content);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...buffered, tabId }));
      }
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: data.type, content: data.content, tabId }));
    }
  };

  const sessionIdHandler = (sessionId: string) => {
    tabSessions.set(tabId, sessionId);
    // Store manager by session ID for reconnection
    sessionManagers.set(sessionId, manager);
    claudeSessionsActive.inc();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session', content: sessionId, tabId }));
    }
  };

  const errorHandler = (error: Error) => {
    const sessionId = getSessionId();
    if (sessionId) {
      const buffered = bufferMessage(sessionId, 'error', error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...buffered, tabId }));
      }
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', content: error.message, tabId }));
    }
  };

  manager.on('output', outputHandler);
  manager.on('sessionId', sessionIdHandler);
  manager.on('error', errorHandler);

  // Return cleanup function
  return () => {
    manager.off('output', outputHandler);
    manager.off('sessionId', sessionIdHandler);
    manager.off('error', errorHandler);
  };
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  wsConnectionsActive.inc({ server: 'main' });

  // Add to all clients set for log broadcasting
  allClients.add(ws);

  // Track per-tab managers and cleanup functions for this connection
  const localTabManagers = new Map<string, ClaudeCodeManager>();
  const localTabCleanups = new Map<string, () => void>();
  connectionTabs.set(ws, new Set());

  /** Gets or creates a manager for a given tabId and working directory. */
  function getOrCreateManager(tabId: string, workDir: string): ClaudeCodeManager {
    let manager = localTabManagers.get(tabId);
    if (manager && manager.getWorkingDirectory() === workDir) {
      return manager;
    }
    // Clean up old manager listeners if switching directories
    if (manager) {
      localTabCleanups.get(tabId)?.();
    }
    manager = new ClaudeCodeManager(workDir);
    localTabManagers.set(tabId, manager);
    tabManagers.set(tabId, manager);
    connectionTabs.get(ws)!.add(tabId);
    const cleanup = attachManagerToWebSocket(
      manager, ws, tabId,
      () => tabSessions.get(tabId)
    );
    localTabCleanups.set(tabId, cleanup);
    return manager;
  }

  // Send initial status
  ws.send(JSON.stringify({ type: 'status', content: 'connected' }));

  // Handle incoming messages
  ws.on('message', async (data) => {
    console.log('[Server] Received message:', data.toString().substring(0, 200));
    try {
      const message = JSON.parse(data.toString());
      const tabId: string = message.tabId || 'default';
      console.log('[Server] Parsed message type:', message.type, 'tabId:', tabId);
      wsMessagesTotal.inc({ server: 'main', direction: 'in', type: message.type });

      switch (message.type) {
        case 'command':
          if (message.content && typeof message.content === 'string') {
            const workDir = (message.workingDirectory && typeof message.workingDirectory === 'string')
              ? message.workingDirectory : WORKING_DIR;
            const manager = getOrCreateManager(tabId, workDir);

            // Parse images for direct pass-through to Claude via stream-json
            const images = Array.isArray(message.images) && message.images.length > 0
              ? message.images
                  .filter((img: unknown) => img && typeof (img as { data?: unknown }).data === 'string' && typeof (img as { name?: unknown }).name === 'string')
                  .map((img: { data: string; name: string; mimeType?: string }) => ({
                    data: img.data,
                    name: img.name,
                    mimeType: img.mimeType || 'image/png',
                  }))
              : undefined;

            // Track project ID for auto-updating lastConversationId
            if (message.projectId && typeof message.projectId === 'string') {
              const projectId = message.projectId;
              manager.once('sessionId', (sessionId: string) => {
                updateProjectConversation(projectId, sessionId).catch(() => {});
              });
            }

            console.log('[Server] Sending command to manager (tab:', tabId, '):', message.content.substring(0, 100), 'with', images?.length || 0, 'images');
            const endTimer = claudeCommandDuration.startTimer();
            try {
              await manager.sendCommand(message.content, images);
              endTimer();
              claudeCommandsTotal.inc({ status: 'success' });
            } catch (cmdError) {
              endTimer();
              claudeCommandsTotal.inc({ status: 'error' });
              throw cmdError;
            }
            console.log('[Server] Command completed (tab:', tabId, ')');
          }
          break;

        case 'abort': {
          const manager = localTabManagers.get(tabId);
          if (manager) manager.abort();
          break;
        }

        case 'reset': {
          const oldSessionId = tabSessions.get(tabId);
          if (oldSessionId) {
            sessionManagers.delete(oldSessionId);
          }
          tabSessions.delete(tabId);
          const manager = localTabManagers.get(tabId);
          if (manager) manager.reset();
          ws.send(JSON.stringify({ type: 'status', content: 'reset', tabId }));
          break;
        }

        case 'resume':
          if (message.sessionId && typeof message.sessionId === 'string') {
            const existingManager = sessionManagers.get(message.sessionId);

            if (existingManager && existingManager.isRunning()) {
              // Reattach to existing running manager
              console.log(`[Server] Reattaching to running manager for session ${message.sessionId} (tab: ${tabId})`);
              localTabCleanups.get(tabId)?.();
              localTabManagers.set(tabId, existingManager);
              tabManagers.set(tabId, existingManager);
              connectionTabs.get(ws)!.add(tabId);
              const cleanup = attachManagerToWebSocket(
                existingManager, ws, tabId,
                () => tabSessions.get(tabId)
              );
              localTabCleanups.set(tabId, cleanup);
            } else {
              const workDir = (message.workingDirectory && typeof message.workingDirectory === 'string')
                ? message.workingDirectory : WORKING_DIR;
              const manager = getOrCreateManager(tabId, workDir);
              manager.setSessionId(message.sessionId);
              sessionManagers.set(message.sessionId, manager);
            }

            tabSessions.set(tabId, message.sessionId);
            ws.send(JSON.stringify({ type: 'session', content: message.sessionId, tabId }));
            ws.send(JSON.stringify({
              type: 'status',
              content: existingManager?.isRunning() ? 'processing' : 'resumed',
              tabId
            }));
          }
          break;

        case 'tab-close': {
          // Clean up manager for this tab
          localTabCleanups.get(tabId)?.();
          const manager = localTabManagers.get(tabId);
          if (manager) manager.abort();
          const sid = tabSessions.get(tabId);
          if (sid) sessionManagers.delete(sid);
          tabSessions.delete(tabId);
          localTabManagers.delete(tabId);
          tabManagers.delete(tabId);
          localTabCleanups.delete(tabId);
          connectionTabs.get(ws)?.delete(tabId);
          console.log(`[Server] Tab closed: ${tabId}`);
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', content: `Unknown message type: ${message.type}`, tabId }));
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        content: error instanceof Error ? error.message : 'Failed to parse message'
      }));
    }
  });

  // Clean up on disconnect - don't abort running processes, let them complete
  ws.on('close', () => {
    console.log('Client disconnected');
    wsConnectionsActive.dec({ server: 'main' });
    allClients.delete(ws);
    // Remove event listeners for all tabs but keep managers in sessionManagers for reconnection
    for (const cleanup of localTabCleanups.values()) cleanup();
    localTabManagers.clear();
    localTabCleanups.clear();
    connectionTabs.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    wsConnectionsActive.dec({ server: 'main' });
    allClients.delete(ws);
    for (const cleanup of localTabCleanups.values()) cleanup();
    localTabManagers.clear();
    localTabCleanups.clear();
    connectionTabs.delete(ws);
  });
});

// Listen with retry — handles ghost sockets on Windows where a dead process's port
// lingers in the OS TCP table until the kernel reclaims it.
const MAX_LISTEN_RETRIES = 30;
const LISTEN_RETRY_DELAY_MS = 2_000;
let listenRetries = 0;

function startListening() {
  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (listening on all interfaces)`);
    console.log(`Working directory: ${WORKING_DIR}`);
  });
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenRetries < MAX_LISTEN_RETRIES) {
    listenRetries++;
    console.warn(`Port ${PORT} in use, retrying in ${LISTEN_RETRY_DELAY_MS / 1000}s (attempt ${listenRetries}/${MAX_LISTEN_RETRIES})...`);
    setTimeout(startListening, LISTEN_RETRY_DELAY_MS);
  } else {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
});

startListening();

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClaudeCodeManager } from './claude-code.js';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const PORT = process.env.PORT || 3001;
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Store managers per connection
const managers = new Map<WebSocket, ClaudeCodeManager>();

// Store all connected WebSocket clients for log broadcasting
const allClients = new Set<WebSocket>();

// Broadcast log to all connected clients
function broadcastLog(level: 'info' | 'warn' | 'error', message: string) {
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

// Intercept console methods to broadcast logs
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

// Enable CORS for the API endpoints
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', connections: managers.size });
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

// List available sessions
app.get('/sessions', async (_req, res) => {
  try {
    const claudeDir = join(homedir(), '.claude', 'projects');
    const projectDirs = await readdir(claudeDir, { withFileTypes: true });

    const sessions: Array<{
      id: string;
      name: string;
      lastModified: Date;
      project: string;
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

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Add to all clients set for log broadcasting
  allClients.add(ws);

  // Create a new manager for this connection
  const manager = new ClaudeCodeManager(WORKING_DIR);
  managers.set(ws, manager);

  // Send initial status
  ws.send(JSON.stringify({ type: 'status', content: 'connected' }));

  // Forward manager events to WebSocket
  manager.on('output', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });

  manager.on('sessionId', (sessionId) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session', content: sessionId }));
    }
  });

  manager.on('error', (error) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', content: error.message }));
    }
  });

  // Handle incoming messages
  ws.on('message', async (data) => {
    console.log('[Server] Received message:', data.toString().substring(0, 200));
    try {
      const message = JSON.parse(data.toString());
      console.log('[Server] Parsed message type:', message.type);

      switch (message.type) {
        case 'command':
          if (message.content && typeof message.content === 'string') {
            console.log('[Server] Sending command to manager:', message.content.substring(0, 100));
            await manager.sendCommand(message.content);
            console.log('[Server] Command completed');
          }
          break;

        case 'abort':
          manager.abort();
          break;

        case 'reset':
          manager.reset();
          ws.send(JSON.stringify({ type: 'status', content: 'reset' }));
          break;

        case 'resume':
          if (message.sessionId && typeof message.sessionId === 'string') {
            manager.setSessionId(message.sessionId);
            ws.send(JSON.stringify({ type: 'session', content: message.sessionId }));
            ws.send(JSON.stringify({ type: 'status', content: 'resumed' }));
          }
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', content: `Unknown message type: ${message.type}` }));
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
    allClients.delete(ws);
    // Don't abort the manager - let Claude process complete in background
    // The session will be saved and can be resumed
    managers.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    allClients.delete(ws);
    managers.delete(ws);
  });
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} (listening on all interfaces)`);
  console.log(`Working directory: ${WORKING_DIR}`);
});

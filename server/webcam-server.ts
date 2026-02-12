/**
 * @fileoverview WebSocket server for webcam streaming.
 *
 * Runs on a separate port from the main server to isolate webcam traffic.
 * Each client connection gets its own WebcamManager instance for independent
 * device control and streaming.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { WebcamManager } from './webcam-manager.js';
import { logToFile, initLogger } from './file-logger.js';

initLogger('webcam');

/** Broadcasts a log message to all connected webcam WebSocket clients. */
function broadcastLog(level: 'info' | 'warn' | 'error', message: string) {
  logToFile(level, message);

  const logMessage = JSON.stringify({
    type: 'webcam-log',
    level,
    content: message,
    timestamp: new Date().toISOString()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(logMessage);
    }
  }
}

const log = (msg: string) => {
  console.log(msg);
  broadcastLog('info', msg);
};

const WEBCAM_PORT = process.env.WEBCAM_PORT || 4002;

// Intercept console methods to broadcast logs to connected webcam clients
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

/** WebSocket server for webcam streaming connections. */
const wss = new WebSocketServer({ port: Number(WEBCAM_PORT), host: '0.0.0.0' });

/** Maps each WebSocket connection to its WebcamManager instance. */
const webcamManagers = new Map<WebSocket, WebcamManager>();

console.log(`Webcam server running on port ${WEBCAM_PORT}`);

wss.on('connection', (ws) => {
  console.log('[Webcam] Client connected');

  // Create a webcam manager for this connection
  const webcamManager = new WebcamManager();
  webcamManagers.set(ws, webcamManager);

  // Forward webcam events to WebSocket
  webcamManager.on('frame', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webcam-frame', deviceId: data.deviceId, data: data.data }));
    }
  });

  webcamManager.on('stream-started', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webcam-started', deviceId: data.deviceId }));
    }
  });

  webcamManager.on('stream-stopped', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webcam-stopped', deviceId: data.deviceId }));
    }
  });

  webcamManager.on('error', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webcam-error', deviceId: data.deviceId, error: data.error }));
    }
  });

  // Send initial connected status
  ws.send(JSON.stringify({ type: 'status', content: 'connected' }));

  // Handle incoming messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'webcam-list': {
          log(`[WebcamServer] Device list requested (platform: ${process.platform})`);
          const devices = await webcamManager.listDevices();
          log(`[WebcamServer] Found ${devices.length} device(s): ${devices.map(d => `${d.id} (${d.name})`).join(', ') || 'none'}`);
          ws.send(JSON.stringify({ type: 'webcam-devices', devices }));
          break;
        }

        case 'webcam-start':
          if (message.deviceId && typeof message.deviceId === 'string') {
            const mode = message.mode || 'grid';
            await webcamManager.startStream(message.deviceId, mode);
          }
          break;

        case 'webcam-stop':
          if (message.deviceId && typeof message.deviceId === 'string') {
            webcamManager.stopStream(message.deviceId);
          }
          break;

        case 'webcam-mode':
          if (message.deviceId && typeof message.deviceId === 'string' && message.mode) {
            log(`[WebcamServer] Received mode change request: ${message.deviceId} -> ${message.mode}`);
            await webcamManager.setOutputMode(message.deviceId, message.mode);
            log(`[WebcamServer] Mode change completed for: ${message.deviceId}`);
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

  // Clean up on disconnect
  ws.on('close', () => {
    console.log('[Webcam] Client disconnected');
    const wm = webcamManagers.get(ws);
    if (wm) {
      wm.stopAllStreams();
      webcamManagers.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('[Webcam] WebSocket error:', error);
    const wm = webcamManagers.get(ws);
    if (wm) {
      wm.stopAllStreams();
      webcamManagers.delete(ws);
    }
  });
});

/**
 * @fileoverview Tests for the webcam WebSocket server.
 *
 * Tests message handling, event forwarding, and connection lifecycle.
 * Uses mocked WebcamManager to avoid actual FFmpeg operations.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { MockWebSocket } from './test-utils';

/**
 * Mock WebcamManager for testing webcam server message handlers.
 */
class MockWebcamManager extends EventEmitter {
  devices = [
    { id: 'Integrated Webcam', name: 'Integrated Webcam', type: 'video' as const },
    { id: 'USB Camera', name: 'USB Camera', type: 'video' as const }
  ];
  streamStarted = false;
  streamStopped = false;
  lastStartDeviceId: string | null = null;
  lastStartResolution: string | null = null;
  lastStopDeviceId: string | null = null;
  lastResolutionDeviceId: string | null = null;
  lastResolution: string | null = null;
  lastFrameRate: number | undefined = undefined;

  async listDevices() {
    return this.devices;
  }

  async startStream(deviceId: string, resolution: string = '640x480') {
    this.streamStarted = true;
    this.lastStartDeviceId = deviceId;
    this.lastStartResolution = resolution;
    this.emit('stream-started', { deviceId });
    return true;
  }

  stopStream(deviceId: string) {
    this.streamStopped = true;
    this.lastStopDeviceId = deviceId;
    this.emit('stream-stopped', { deviceId });
    return true;
  }

  stopAllStreams() {
    this.streamStopped = true;
  }

  async setResolution(deviceId: string, resolution: string, frameRate?: number) {
    this.lastResolutionDeviceId = deviceId;
    this.lastResolution = resolution;
    this.lastFrameRate = frameRate;
    return true;
  }
}

describe('Webcam Server Message Handlers', () => {
  let webcamManager: MockWebcamManager;
  let ws: MockWebSocket;

  /**
   * Simulates the message handler logic from webcam-server.ts
   */
  async function handleMessage(message: { type: string; deviceId?: string; resolution?: string; frameRate?: number }) {
    switch (message.type) {
      case 'webcam-list': {
        const devices = await webcamManager.listDevices();
        ws.send(JSON.stringify({ type: 'webcam-devices', devices }));
        break;
      }

      case 'webcam-start':
        if (message.deviceId && typeof message.deviceId === 'string') {
          const resolution = message.resolution || '640x480';
          await webcamManager.startStream(message.deviceId, resolution);
        }
        break;

      case 'webcam-stop':
        if (message.deviceId && typeof message.deviceId === 'string') {
          webcamManager.stopStream(message.deviceId);
        }
        break;

      case 'webcam-resolution':
        if (message.deviceId && typeof message.deviceId === 'string' && message.resolution) {
          const frameRate = typeof message.frameRate === 'number' ? message.frameRate : undefined;
          await webcamManager.setResolution(message.deviceId, message.resolution, frameRate);
        }
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', content: `Unknown message type: ${message.type}` }));
    }
  }

  beforeEach(() => {
    webcamManager = new MockWebcamManager();
    ws = new MockWebSocket();
  });

  describe('webcam-list message', () => {
    test('returns list of devices', async () => {
      await handleMessage({ type: 'webcam-list' });

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('webcam-devices');
      expect(response.devices.length).toBe(2);
      expect(response.devices[0].id).toBe('Integrated Webcam');
    });

    test('returns empty array when no devices', async () => {
      webcamManager.devices = [];

      await handleMessage({ type: 'webcam-list' });

      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.devices).toEqual([]);
    });
  });

  describe('webcam-start message', () => {
    test('starts stream with device ID', async () => {
      await handleMessage({ type: 'webcam-start', deviceId: 'Integrated Webcam' });

      expect(webcamManager.streamStarted).toBe(true);
      expect(webcamManager.lastStartDeviceId).toBe('Integrated Webcam');
    });

    test('uses default resolution when not specified', async () => {
      await handleMessage({ type: 'webcam-start', deviceId: 'Integrated Webcam' });

      expect(webcamManager.lastStartResolution).toBe('640x480');
    });

    test('uses custom resolution when specified', async () => {
      await handleMessage({ type: 'webcam-start', deviceId: 'Integrated Webcam', resolution: '1920x1080' });

      expect(webcamManager.lastStartResolution).toBe('1920x1080');
    });

    test('ignores missing deviceId', async () => {
      await handleMessage({ type: 'webcam-start' });

      expect(webcamManager.streamStarted).toBe(false);
    });

    test('ignores non-string deviceId', async () => {
      await handleMessage({ type: 'webcam-start', deviceId: 123 as unknown as string });

      expect(webcamManager.streamStarted).toBe(false);
    });
  });

  describe('webcam-stop message', () => {
    test('stops stream with device ID', async () => {
      await handleMessage({ type: 'webcam-stop', deviceId: 'Integrated Webcam' });

      expect(webcamManager.streamStopped).toBe(true);
      expect(webcamManager.lastStopDeviceId).toBe('Integrated Webcam');
    });

    test('ignores missing deviceId', async () => {
      await handleMessage({ type: 'webcam-stop' });

      expect(webcamManager.streamStopped).toBe(false);
    });

    test('ignores non-string deviceId', async () => {
      await handleMessage({ type: 'webcam-stop', deviceId: 456 as unknown as string });

      expect(webcamManager.streamStopped).toBe(false);
    });
  });

  describe('webcam-resolution message', () => {
    test('changes resolution for device', async () => {
      await handleMessage({
        type: 'webcam-resolution',
        deviceId: 'Integrated Webcam',
        resolution: '1280x720'
      });

      expect(webcamManager.lastResolutionDeviceId).toBe('Integrated Webcam');
      expect(webcamManager.lastResolution).toBe('1280x720');
    });

    test('passes frame rate when specified', async () => {
      await handleMessage({
        type: 'webcam-resolution',
        deviceId: 'Integrated Webcam',
        resolution: '1920x1080',
        frameRate: 30
      });

      expect(webcamManager.lastFrameRate).toBe(30);
    });

    test('passes undefined frame rate when not specified', async () => {
      await handleMessage({
        type: 'webcam-resolution',
        deviceId: 'Integrated Webcam',
        resolution: '1280x720'
      });

      expect(webcamManager.lastFrameRate).toBeUndefined();
    });

    test('ignores missing deviceId', async () => {
      await handleMessage({ type: 'webcam-resolution', resolution: '1280x720' });

      expect(webcamManager.lastResolutionDeviceId).toBeNull();
    });

    test('ignores missing resolution', async () => {
      await handleMessage({ type: 'webcam-resolution', deviceId: 'Integrated Webcam' });

      expect(webcamManager.lastResolution).toBeNull();
    });

    test('ignores non-number frame rate', async () => {
      await handleMessage({
        type: 'webcam-resolution',
        deviceId: 'Integrated Webcam',
        resolution: '1280x720',
        frameRate: 'thirty' as unknown as number
      });

      expect(webcamManager.lastFrameRate).toBeUndefined();
    });
  });

  describe('unknown message type', () => {
    test('sends error response', async () => {
      await handleMessage({ type: 'unknown-webcam-command' });

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('error');
      expect(response.content).toContain('Unknown message type');
    });
  });
});

describe('Webcam Server Event Forwarding', () => {
  let webcamManager: MockWebcamManager;
  let ws: MockWebSocket;

  /**
   * Sets up event forwarding like webcam-server.ts does
   */
  function setupEventForwarding() {
    webcamManager.on('frame', (data) => {
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webcam-frame', deviceId: data.deviceId, data: data.data }));
      }
    });

    webcamManager.on('stream-started', (data) => {
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webcam-started', deviceId: data.deviceId }));
      }
    });

    webcamManager.on('stream-stopped', (data) => {
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webcam-stopped', deviceId: data.deviceId }));
      }
    });

    webcamManager.on('error', (data) => {
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webcam-error', deviceId: data.deviceId, error: data.error }));
      }
    });
  }

  beforeEach(() => {
    webcamManager = new MockWebcamManager();
    ws = new MockWebSocket();
    setupEventForwarding();
  });

  describe('frame event', () => {
    test('forwards frame to WebSocket', () => {
      webcamManager.emit('frame', { deviceId: 'test-device', data: 'base64data' });

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('webcam-frame');
      expect(response.deviceId).toBe('test-device');
      expect(response.data).toBe('base64data');
    });

    test('does not send to closed WebSocket', () => {
      ws.readyState = MockWebSocket.CLOSED;

      webcamManager.emit('frame', { deviceId: 'test-device', data: 'base64data' });

      expect(ws.sentMessages.length).toBe(0);
    });
  });

  describe('stream-started event', () => {
    test('forwards stream-started to WebSocket', () => {
      webcamManager.emit('stream-started', { deviceId: 'test-device' });

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('webcam-started');
      expect(response.deviceId).toBe('test-device');
    });
  });

  describe('stream-stopped event', () => {
    test('forwards stream-stopped to WebSocket', () => {
      webcamManager.emit('stream-stopped', { deviceId: 'test-device' });

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('webcam-stopped');
      expect(response.deviceId).toBe('test-device');
    });
  });

  describe('error event', () => {
    test('forwards error to WebSocket', () => {
      webcamManager.emit('error', { deviceId: 'test-device', error: 'Device disconnected' });

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('webcam-error');
      expect(response.deviceId).toBe('test-device');
      expect(response.error).toBe('Device disconnected');
    });
  });
});

describe('Webcam Server Connection Lifecycle', () => {
  let webcamManager: MockWebcamManager;
  let ws: MockWebSocket;
  let webcamManagers: Map<MockWebSocket, MockWebcamManager>;

  beforeEach(() => {
    webcamManager = new MockWebcamManager();
    ws = new MockWebSocket();
    webcamManagers = new Map();
    webcamManagers.set(ws, webcamManager);
  });

  describe('connection', () => {
    test('sends connected status on connection', () => {
      // Simulate connection handler
      ws.send(JSON.stringify({ type: 'status', content: 'connected' }));

      expect(ws.sentMessages.length).toBe(1);
      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('status');
      expect(response.content).toBe('connected');
    });

    test('creates manager for connection', () => {
      expect(webcamManagers.has(ws)).toBe(true);
      expect(webcamManagers.get(ws)).toBe(webcamManager);
    });
  });

  describe('disconnect', () => {
    test('stops all streams on disconnect', () => {
      // Simulate close handler
      const wm = webcamManagers.get(ws);
      if (wm) {
        wm.stopAllStreams();
        webcamManagers.delete(ws);
      }

      expect(webcamManager.streamStopped).toBe(true);
      expect(webcamManagers.has(ws)).toBe(false);
    });
  });

  describe('error', () => {
    test('stops all streams on error', () => {
      // Simulate error handler
      const wm = webcamManagers.get(ws);
      if (wm) {
        wm.stopAllStreams();
        webcamManagers.delete(ws);
      }

      expect(webcamManager.streamStopped).toBe(true);
      expect(webcamManagers.has(ws)).toBe(false);
    });
  });
});

describe('Webcam Server Error Handling', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = new MockWebSocket();
  });

  test('sends error for invalid JSON', () => {
    // Simulate error handling for parse failure
    try {
      JSON.parse('invalid json {{{');
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        content: error instanceof Error ? error.message : 'Failed to parse message'
      }));
    }

    expect(ws.sentMessages.length).toBe(1);
    const response = JSON.parse(ws.sentMessages[0]);
    expect(response.type).toBe('error');
  });

  test('sends generic error message when error is not Error instance', () => {
    try {
      throw 'string error';
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        content: error instanceof Error ? error.message : 'Failed to parse message'
      }));
    }

    const response = JSON.parse(ws.sentMessages[0]);
    expect(response.content).toBe('Failed to parse message');
  });
});

/**
 * @fileoverview Unit tests for WebcamManager.
 *
 * Tests device listing, stream management, JPEG parsing, and event emission.
 * Uses mocked Bun.spawn to avoid actual FFmpeg process spawning.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { WebcamManager } from '../../server/webcam-manager';
import { createMockJpegFrame, captureEvents, encodeString } from './test-utils';

// Store original Bun.spawn
const originalBunSpawn = Bun.spawn;

describe('WebcamManager', () => {
  let manager: WebcamManager;

  beforeEach(() => {
    manager = new WebcamManager();
  });

  afterEach(() => {
    // Restore original Bun.spawn
    (globalThis as { Bun: typeof Bun }).Bun.spawn = originalBunSpawn;
    manager.stopAllStreams();
  });

  describe('Constructor', () => {
    test('creates manager with default frame rate and quality', () => {
      const m = new WebcamManager();
      // Access private properties for testing
      expect((m as unknown as { frameRate: number }).frameRate).toBe(15);
      expect((m as unknown as { quality: number }).quality).toBe(5);
    });

    test('creates manager with custom frame rate and quality', () => {
      const m = new WebcamManager(30, 10);
      expect((m as unknown as { frameRate: number }).frameRate).toBe(30);
      expect((m as unknown as { quality: number }).quality).toBe(10);
    });
  });

  describe('isStreaming', () => {
    test('returns false when no stream is active', () => {
      expect(manager.isStreaming('test-device')).toBe(false);
    });

    test('returns true when stream is active', () => {
      // Manually add to activeStreams with full mock object
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: mock(() => {}) },
        deviceId: 'test-device',
        resolution: '640x480',
        frameRate: 15
      });

      expect(manager.isStreaming('test-device')).toBe(true);
    });
  });

  describe('getActiveStreams', () => {
    test('returns empty array when no streams', () => {
      expect(manager.getActiveStreams()).toEqual([]);
    });

    test('returns array of active device IDs', () => {
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('device-1', {
        process: { kill: mock(() => {}) },
        deviceId: 'device-1',
        resolution: '640x480',
        frameRate: 15
      });
      activeStreams.set('device-2', {
        process: { kill: mock(() => {}) },
        deviceId: 'device-2',
        resolution: '640x480',
        frameRate: 15
      });

      const result = manager.getActiveStreams();
      expect(result).toContain('device-1');
      expect(result).toContain('device-2');
      expect(result.length).toBe(2);
    });
  });

  describe('stopStream', () => {
    test('returns false when no active stream exists', () => {
      const result = manager.stopStream('non-existent-device');
      expect(result).toBe(false);
    });

    test('kills process and removes from activeStreams', () => {
      const killMock = mock(() => {});
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: killMock },
        deviceId: 'test-device',
        resolution: '640x480',
        frameRate: 15
      });

      const { events } = captureEvents(manager, 'stream-stopped');

      const result = manager.stopStream('test-device');

      expect(result).toBe(true);
      expect(killMock).toHaveBeenCalled();
      expect(activeStreams.has('test-device')).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ deviceId: 'test-device', code: 0 });
    });
  });

  describe('stopAllStreams', () => {
    test('stops all active streams', () => {
      const killMock1 = mock(() => {});
      const killMock2 = mock(() => {});
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;

      activeStreams.set('device-1', {
        process: { kill: killMock1 },
        deviceId: 'device-1',
        resolution: '640x480',
        frameRate: 15
      });
      activeStreams.set('device-2', {
        process: { kill: killMock2 },
        deviceId: 'device-2',
        resolution: '1280x720',
        frameRate: 30
      });

      manager.stopAllStreams();

      expect(killMock1).toHaveBeenCalled();
      expect(killMock2).toHaveBeenCalled();
      expect(activeStreams.size).toBe(0);
    });
  });

  describe('parseJpegDimensions', () => {
    let parseJpegDimensions: (data: Uint8Array) => { width: number; height: number } | null;

    beforeEach(() => {
      parseJpegDimensions = (manager as unknown as {
        parseJpegDimensions: (data: Uint8Array) => { width: number; height: number } | null
      }).parseJpegDimensions.bind(manager);
    });

    test('parses dimensions from SOF0 marker', () => {
      const frame = createMockJpegFrame({ width: 1920, height: 1080 });
      const result = parseJpegDimensions(frame);

      expect(result).not.toBeNull();
      expect(result?.width).toBe(1920);
      expect(result?.height).toBe(1080);
    });

    test('parses dimensions from SOF2 marker (progressive JPEG)', () => {
      // Create frame with SOF2 marker (0xFFC2) instead of SOF0
      const frame = new Uint8Array([
        0xFF, 0xD8, // SOI
        0xFF, 0xC2, // SOF2 (progressive)
        0x00, 0x0B, // Length
        0x08,       // Precision
        0x02, 0xD0, // Height = 720
        0x05, 0x00, // Width = 1280
        0x01, 0x00, 0x00,
        0xFF, 0xD9  // EOI
      ]);

      const result = parseJpegDimensions(frame);

      expect(result).not.toBeNull();
      expect(result?.width).toBe(1280);
      expect(result?.height).toBe(720);
    });

    test('returns null for data without SOF marker', () => {
      const invalidData = new Uint8Array([0xFF, 0xD8, 0x00, 0x00, 0xFF, 0xD9]);
      const result = parseJpegDimensions(invalidData);

      expect(result).toBeNull();
    });

    test('returns null for empty data', () => {
      const result = parseJpegDimensions(new Uint8Array([]));
      expect(result).toBeNull();
    });

    test('returns null for data too short to contain dimensions', () => {
      const result = parseJpegDimensions(new Uint8Array([0xFF, 0xC0, 0x00]));
      expect(result).toBeNull();
    });
  });

  describe('listDevices', () => {
    test('parses video devices from FFmpeg output', async () => {
      // Mock Bun.spawn to return fake FFmpeg device list output
      const mockStderr = `
[dshow @ 00000123] DirectShow video devices
[dshow @ 00000123]  "Integrated Webcam" (video)
[dshow @ 00000123]     Alternative name "@device_pnp_\\\\?\\usb#vid_123"
[dshow @ 00000123]  "USB Camera" (video)
[dshow @ 00000123] DirectShow audio devices
[dshow @ 00000123]  "Microphone" (audio)
`;

      let exitedResolve: (code: number) => void;
      const mockSpawn = mock(() => ({
        stdout: new ReadableStream(),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(encodeString(mockStderr));
            controller.close();
          }
        }),
        exited: new Promise<number>((resolve) => {
          exitedResolve = resolve;
          setTimeout(() => resolve(1), 10); // FFmpeg exits with 1 when listing
        })
      }));

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const devices = await manager.listDevices();

      expect(mockSpawn).toHaveBeenCalled();
      expect(devices.length).toBe(2);
      expect(devices[0]).toEqual({ id: 'Integrated Webcam', name: 'Integrated Webcam', type: 'video' });
      expect(devices[1]).toEqual({ id: 'USB Camera', name: 'USB Camera', type: 'video' });
    });

    test('returns empty array when no devices found', async () => {
      const mockSpawn = mock(() => ({
        stdout: new ReadableStream(),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(encodeString('[dshow @ 00000123] DirectShow video devices\n'));
            controller.close();
          }
        }),
        exited: Promise.resolve(1)
      }));

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const devices = await manager.listDevices();
      expect(devices).toEqual([]);
    });

    test('emits error event on FFmpeg failure', async () => {
      const mockSpawn = mock(() => {
        throw new Error('FFmpeg not found');
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const { events } = captureEvents<{ type: string; error: string }>(manager, 'error');

      const devices = await manager.listDevices();

      expect(devices).toEqual([]);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('list-error');
    });
  });

  describe('startStream', () => {
    test('returns true if already streaming same device', async () => {
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', { deviceId: 'test-device' });

      const result = await manager.startStream('test-device');
      expect(result).toBe(true);
    });

    test('spawns FFmpeg with correct arguments', async () => {
      let capturedArgs: string[] = [];

      const mockSpawn = mock((args: string[]) => {
        capturedArgs = args;
        return {
          pid: 12345,
          stdout: new ReadableStream({
            start(controller) {
              controller.close();
            }
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.close();
            }
          }),
          exited: new Promise<number>((resolve) => {
            setTimeout(() => resolve(0), 50);
          })
        };
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const result = await manager.startStream('My Webcam', '1280x720', 30);

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalled();
      expect(capturedArgs).toContain('ffmpeg');
      expect(capturedArgs).toContain('-f');
      expect(capturedArgs).toContain('dshow');
      expect(capturedArgs).toContain('-video_size');
      expect(capturedArgs).toContain('1280x720');
      expect(capturedArgs).toContain('-framerate');
      expect(capturedArgs).toContain('30');
      expect(capturedArgs).toContain('video=My Webcam');
      expect(capturedArgs).toContain('-f');
      expect(capturedArgs).toContain('mjpeg');
    });

    test('emits stream-started event', async () => {
      const mockSpawn = mock(() => ({
        pid: 12345,
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: new Promise<number>((resolve) => setTimeout(() => resolve(0), 50))
      }));

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const { events } = captureEvents<{ deviceId: string }>(manager, 'stream-started');

      await manager.startStream('test-device');

      expect(events.length).toBe(1);
      expect(events[0].deviceId).toBe('test-device');
    });

    test('emits error event on spawn failure', async () => {
      const mockSpawn = mock(() => {
        throw new Error('Spawn failed');
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const { events } = captureEvents<{ deviceId: string; type: string }>(manager, 'error');

      const result = await manager.startStream('test-device');

      expect(result).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0].deviceId).toBe('test-device');
      expect(events[0].type).toBe('start-error');
    });

    test('uses default resolution and frame rate', async () => {
      let capturedArgs: string[] = [];

      const mockSpawn = mock((args: string[]) => {
        capturedArgs = args;
        return {
          pid: 12345,
          stdout: new ReadableStream({ start(c) { c.close(); } }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
          exited: new Promise<number>((resolve) => setTimeout(() => resolve(0), 50))
        };
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      await manager.startStream('test-device');

      expect(capturedArgs).toContain('640x480');
      expect(capturedArgs).toContain('15');
    });
  });

  describe('setResolution', () => {
    test('returns false if device is not streaming', async () => {
      const result = await manager.setResolution('non-existent', '1920x1080');
      expect(result).toBe(false);
    });

    test('returns true if resolution and frame rate already match', async () => {
      const killMock = mock(() => {});
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: killMock },
        deviceId: 'test-device',
        resolution: '1280x720',
        frameRate: 30
      });

      const result = await manager.setResolution('test-device', '1280x720', 30);
      expect(result).toBe(true);
      // Should not have killed the process since nothing changed
      expect(killMock).not.toHaveBeenCalled();
    });
  });

  describe('handleStderr', () => {
    let handleStderr: (deviceId: string, stderr: ReadableStream<Uint8Array>) => Promise<void>;

    beforeEach(() => {
      handleStderr = (manager as unknown as {
        handleStderr: (deviceId: string, stderr: ReadableStream<Uint8Array>) => Promise<void>
      }).handleStderr.bind(manager);
    });

    test('emits error event for FFmpeg errors', async () => {
      const { events } = captureEvents<{ deviceId: string; type: string; error: string }>(manager, 'error');

      const stderr = new ReadableStream({
        start(controller) {
          controller.enqueue(encodeString('Error: device not found\n'));
          controller.close();
        }
      });

      await handleStderr('test-device', stderr);

      expect(events.length).toBe(1);
      expect(events[0].deviceId).toBe('test-device');
      expect(events[0].type).toBe('ffmpeg-error');
      expect(events[0].error).toContain('Error: device not found');
    });

    test('emits error event for Invalid errors', async () => {
      const { events } = captureEvents<{ deviceId: string; type: string }>(manager, 'error');

      const stderr = new ReadableStream({
        start(controller) {
          controller.enqueue(encodeString('Invalid video size\n'));
          controller.close();
        }
      });

      await handleStderr('test-device', stderr);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('ffmpeg-error');
    });

    test('does not emit error for normal output', async () => {
      const { events } = captureEvents(manager, 'error');

      const stderr = new ReadableStream({
        start(controller) {
          controller.enqueue(encodeString('frame=   10 fps=15.0 q=5.0 size=N/A\n'));
          controller.close();
        }
      });

      await handleStderr('test-device', stderr);

      expect(events.length).toBe(0);
    });
  });

  describe('handleFrameStream', () => {
    let handleFrameStream: (deviceId: string, stdout: ReadableStream<Uint8Array>) => Promise<void>;

    beforeEach(() => {
      handleFrameStream = (manager as unknown as {
        handleFrameStream: (deviceId: string, stdout: ReadableStream<Uint8Array>) => Promise<void>
      }).handleFrameStream.bind(manager);
    });

    test('emits frame event for complete JPEG frame', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      const frame = createMockJpegFrame({ width: 640, height: 480 });
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(frame);
          controller.close();
        }
      });

      await handleFrameStream('test-device', stdout);

      expect(events.length).toBe(1);
      expect(events[0].deviceId).toBe('test-device');
      expect(typeof events[0].data).toBe('string'); // Base64 string
    });

    test('handles multiple frames in stream', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      const frame1 = createMockJpegFrame({ width: 640, height: 480 });
      const frame2 = createMockJpegFrame({ width: 640, height: 480 });

      const stdout = new ReadableStream({
        start(controller) {
          // Send both frames at once
          const combined = new Uint8Array(frame1.length + frame2.length);
          combined.set(frame1);
          combined.set(frame2, frame1.length);
          controller.enqueue(combined);
          controller.close();
        }
      });

      await handleFrameStream('test-device', stdout);

      expect(events.length).toBe(2);
    });

    test('handles frames split across chunks', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      const frame = createMockJpegFrame({ width: 640, height: 480 });
      const midpoint = Math.floor(frame.length / 2);

      const stdout = new ReadableStream({
        start(controller) {
          // Split frame in the middle
          controller.enqueue(frame.slice(0, midpoint));
          controller.enqueue(frame.slice(midpoint));
          controller.close();
        }
      });

      await handleFrameStream('test-device', stdout);

      expect(events.length).toBe(1);
    });

    test('handles partial frame at end of stream', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      // SOI marker but no EOI
      const partialFrame = new Uint8Array([0xFF, 0xD8, 0x00, 0x00, 0x00]);

      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(partialFrame);
          controller.close();
        }
      });

      await handleFrameStream('test-device', stdout);

      // Should not emit incomplete frame
      expect(events.length).toBe(0);
    });

    test('skips data before first SOI marker', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      const frame = createMockJpegFrame();
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      const combined = new Uint8Array(garbage.length + frame.length);
      combined.set(garbage);
      combined.set(frame, garbage.length);

      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(combined);
          controller.close();
        }
      });

      await handleFrameStream('test-device', stdout);

      expect(events.length).toBe(1);
    });
  });

  describe('Event Emission', () => {
    test('stream-stopped event includes exit code', async () => {
      const { events } = captureEvents<{ deviceId: string; code: number }>(manager, 'stream-stopped');

      const killMock = mock(() => {});
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: killMock },
        deviceId: 'test-device',
        resolution: '640x480',
        frameRate: 15
      });

      manager.stopStream('test-device');

      expect(events.length).toBe(1);
      expect(events[0].deviceId).toBe('test-device');
      expect(events[0].code).toBe(0);
    });
  });
});

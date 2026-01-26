/**
 * @fileoverview Unit tests for WebcamManager.
 *
 * Tests device listing, stream management, JPEG parsing, and event emission.
 * Uses mocked Bun.spawn to avoid actual FFmpeg process spawning.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { WebcamManager } from '../../server/webcam-manager';
import type { DeviceMode } from '../../server/webcam-manager';
import { createMockJpegFrame, captureEvents, encodeString } from './test-utils';

// Store original Bun.spawn
const originalBunSpawn = Bun.spawn;

/** Creates a mock Bun.spawn that returns a fake FFmpeg process. */
function createMockSpawn(opts?: { captureArgs?: boolean; stderrText?: string }) {
  let capturedArgs: string[] = [];
  const fn = mock((args: string[]) => {
    if (opts?.captureArgs) capturedArgs = args;
    return {
      pid: 12345,
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({
        start(c) {
          if (opts?.stderrText) c.enqueue(encodeString(opts.stderrText));
          c.close();
        }
      }),
      exited: new Promise<number>((resolve) => setTimeout(() => resolve(0), 50))
    };
  });
  return { fn, getCapturedArgs: () => capturedArgs };
}

/** Installs a mock Bun.spawn globally and returns it. */
function installMockSpawn(opts?: Parameters<typeof createMockSpawn>[0]) {
  const mock = createMockSpawn(opts);
  (globalThis as { Bun: typeof Bun }).Bun.spawn = mock.fn as typeof Bun.spawn;
  return mock;
}

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
    test('creates manager with default quality', () => {
      const m = new WebcamManager();
      expect((m as unknown as { quality: number }).quality).toBe(5);
    });

    test('creates manager with custom quality', () => {
      const m = new WebcamManager(10);
      expect((m as unknown as { quality: number }).quality).toBe(10);
    });
  });

  describe('isStreaming', () => {
    test('returns false when no stream is active', () => {
      expect(manager.isStreaming('test-device')).toBe(false);
    });

    test('returns true when stream is active', () => {
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: mock(() => {}) },
        deviceId: 'test-device',
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
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
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
        frameRate: 15
      });
      activeStreams.set('device-2', {
        process: { kill: mock(() => {}) },
        deviceId: 'device-2',
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'fullscreen',
        resolution: '1280x720',
        frameRate: 30
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
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
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
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
        frameRate: 15
      });
      activeStreams.set('device-2', {
        process: { kill: killMock2 },
        deviceId: 'device-2',
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'fullscreen',
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

  describe('selectNativeMode', () => {
    let selectNativeMode: (capabilities: DeviceMode[]) => { width: number; height: number; fps: number; pixelFormat: string } | null;

    beforeEach(() => {
      selectNativeMode = (manager as unknown as {
        selectNativeMode: (capabilities: DeviceMode[]) => { width: number; height: number; fps: number; pixelFormat: string } | null
      }).selectNativeMode.bind(manager);
    });

    test('returns null for empty capabilities', () => {
      expect(selectNativeMode([])).toBeNull();
    });

    test('prefers MJPEG over raw pixel format', () => {
      const caps: DeviceMode[] = [
        { pixelFormat: 'yuyv422', width: 1920, height: 1080, maxFps: 10 },
        { pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 },
      ];
      const result = selectNativeMode(caps);
      expect(result).toEqual({ width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' });
    });

    test('selects highest resolution among MJPEG modes', () => {
      const caps: DeviceMode[] = [
        { pixelFormat: 'mjpeg', width: 640, height: 480, maxFps: 30 },
        { pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 },
        { pixelFormat: 'mjpeg', width: 960, height: 540, maxFps: 30 },
      ];
      const result = selectNativeMode(caps);
      expect(result).toEqual({ width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' });
    });

    test('selects highest fps when resolutions are equal', () => {
      const caps: DeviceMode[] = [
        { pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 15 },
        { pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 },
      ];
      const result = selectNativeMode(caps);
      expect(result).toEqual({ width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' });
    });

    test('falls back to raw formats when no MJPEG modes', () => {
      const caps: DeviceMode[] = [
        { pixelFormat: 'yuyv422', width: 640, height: 480, maxFps: 30 },
        { pixelFormat: 'yuyv422', width: 320, height: 240, maxFps: 30 },
      ];
      const result = selectNativeMode(caps);
      expect(result).toEqual({ width: 640, height: 480, fps: 30, pixelFormat: 'yuyv422' });
    });
  });

  describe('listDevices', () => {
    test('parses video devices from FFmpeg output', async () => {
      const mockDeviceListStderr = `
[dshow @ 00000123] DirectShow video devices
[dshow @ 00000123]  "Integrated Webcam" (video)
[dshow @ 00000123]     Alternative name "@device_pnp_\\\\?\\usb#vid_123"
[dshow @ 00000123]  "USB Camera" (video)
[dshow @ 00000123] DirectShow audio devices
[dshow @ 00000123]  "Microphone" (audio)
`;
      const mockCapabilitiesStderr = `
[dshow @ 00000456] DirectShow video device options (from video pin)
[dshow @ 00000456]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30
[dshow @ 00000456]   vcodec=mjpeg  min s=640x480 fps=5 max s=640x480 fps=30
`;

      let callCount = 0;
      const mockSpawn = mock(() => {
        callCount++;
        // First call: device enumeration. Subsequent calls: capability queries.
        const stderr = callCount === 1 ? mockDeviceListStderr : mockCapabilitiesStderr;
        return {
          stdout: new ReadableStream(),
          stderr: new ReadableStream({
            start(controller) {
              controller.enqueue(encodeString(stderr));
              controller.close();
            }
          }),
          exited: Promise.resolve(1)
        };
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const devices = await manager.listDevices();

      // 1 for device list + 2 for capability queries (one per video device)
      expect(callCount).toBe(3);
      expect(devices.length).toBe(2);
      expect(devices[0].id).toBe('Integrated Webcam');
      expect(devices[0].name).toBe('Integrated Webcam');
      expect(devices[0].type).toBe('video');
      expect(devices[0].capabilities).toBeDefined();
      expect(devices[0].capabilities!.length).toBe(2);
      expect(devices[0].nativeMode).toEqual({ width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' });
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

    test('uses cached capabilities on second call', async () => {
      const mockCapStderr = `
[dshow @ 00000456]   vcodec=mjpeg  min s=640x480 fps=5 max s=640x480 fps=30
`;
      let callCount = 0;
      const mockSpawn = mock(() => {
        callCount++;
        const stderr = callCount === 1
          ? '[dshow @ 00000123]  "Test Cam" (video)\n'
          : mockCapStderr;
        return {
          stdout: new ReadableStream(),
          stderr: new ReadableStream({
            start(c) { c.enqueue(encodeString(stderr)); c.close(); }
          }),
          exited: Promise.resolve(1)
        };
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      await manager.listDevices(); // First call: 1 list + 1 capability = 2 spawns
      const firstCount = callCount;

      await manager.listDevices(); // Second call: 1 list + 0 capability (cached) = 1 spawn
      const secondCount = callCount - firstCount;

      expect(firstCount).toBe(2);
      expect(secondCount).toBe(1); // Only device list, capabilities cached
    });
  });

  describe('startStream', () => {
    test('returns true if already streaming same device', async () => {
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', { deviceId: 'test-device' });

      const result = await manager.startStream('test-device');
      expect(result).toBe(true);
    });

    test('spawns FFmpeg with native resolution and grid mode output filter', async () => {
      // Pre-populate device capabilities
      const caps = (manager as unknown as { deviceCapabilities: Map<string, unknown> }).deviceCapabilities;
      caps.set('My Webcam', {
        capabilities: [{ pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 }],
        nativeMode: { width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' }
      });

      const { fn, getCapturedArgs } = installMockSpawn({ captureArgs: true });

      const result = await manager.startStream('My Webcam', 'grid');

      expect(result).toBe(true);
      expect(fn).toHaveBeenCalled();
      const args = getCapturedArgs();
      // Should force MJPEG input codec to avoid H.264 software decode
      expect(args).toContain('-vcodec');
      expect(args).toContain('mjpeg');
      // Input should be native resolution and framerate
      expect(args).toContain('-video_size');
      expect(args).toContain('1280x720');
      expect(args).toContain('-framerate');
      expect(args).toContain('30');
      expect(args).toContain('video=My Webcam');
      // Grid mode should have scale filter (half native: 1280/2=640, 720/2=360)
      expect(args).toContain('-vf');
      expect(args).toContain('scale=640:360');
      expect(args).toContain('-r');
      expect(args).toContain('15');
    });

    test('spawns FFmpeg in fullscreen mode without scale filter', async () => {
      const caps = (manager as unknown as { deviceCapabilities: Map<string, unknown> }).deviceCapabilities;
      caps.set('My Webcam', {
        capabilities: [{ pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 }],
        nativeMode: { width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' }
      });

      const { fn, getCapturedArgs } = installMockSpawn({ captureArgs: true });

      const result = await manager.startStream('My Webcam', 'fullscreen');

      expect(result).toBe(true);
      const args = getCapturedArgs();
      // Should force MJPEG input codec
      expect(args).toContain('-vcodec');
      // Input should be native resolution and framerate
      expect(args).toContain('1280x720');
      expect(args).toContain('-framerate');
      // Fullscreen mode should NOT have scale filter
      expect(args).not.toContain('-vf');
      // Frame rate should be native
      expect(args).toContain('-r');
      expect(args).toContain('30');
    });

    test('applies half-resolution scale filter for small camera in grid mode', async () => {
      const caps = (manager as unknown as { deviceCapabilities: Map<string, unknown> }).deviceCapabilities;
      caps.set('Small Cam', {
        capabilities: [{ pixelFormat: 'mjpeg', width: 640, height: 480, maxFps: 30 }],
        nativeMode: { width: 640, height: 480, fps: 30, pixelFormat: 'mjpeg' }
      });

      const { getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await manager.startStream('Small Cam', 'grid');

      const args = getCapturedArgs();
      // Half of 640x480 = 320x240
      expect(args).toContain('-vf');
      expect(args).toContain('scale=320:240');
      expect(args).toContain('-r');
      expect(args).toContain('15');
    });

    test('uses fallback resolution when no capabilities cached', async () => {
      // Don't populate deviceCapabilities
      const { getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await manager.startStream('Unknown Cam');

      const args = getCapturedArgs();
      // Fallback: 640x480 input, half = 320x240 for grid
      expect(args).toContain('640x480');
      expect(args).toContain('-vf');
      expect(args).toContain('scale=320:240');
      expect(args).toContain('-r');
      expect(args).toContain('15');
      // Should NOT force vcodec when no capabilities are known
      expect(args).not.toContain('-vcodec');
    });

    test('emits stream-started event', async () => {
      installMockSpawn();

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
  });

  describe('setOutputMode', () => {
    test('returns false if device is not streaming', async () => {
      const result = await manager.setOutputMode('non-existent', 'fullscreen');
      expect(result).toBe(false);
    });

    test('returns true if mode already matches', async () => {
      const killMock = mock(() => {});
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: killMock },
        deviceId: 'test-device',
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
        frameRate: 15
      });

      const result = await manager.setOutputMode('test-device', 'grid');
      expect(result).toBe(true);
      // Should not have killed the process since nothing changed
      expect(killMock).not.toHaveBeenCalled();
    });

    test('kills old process and starts new one when mode changes', async () => {
      const killMock = mock(() => {});
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', {
        process: { kill: killMock, exited: Promise.resolve(0) },
        deviceId: 'test-device',
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
        frameRate: 15
      });

      installMockSpawn();

      const result = await manager.setOutputMode('test-device', 'fullscreen');

      expect(result).toBe(true);
      expect(killMock).toHaveBeenCalled();
      // New stream should be active
      expect(manager.isStreaming('test-device')).toBe(true);
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
        inputResolution: '1280x720',
        inputFrameRate: 30,
        outputMode: 'grid',
        resolution: '640x360',
        frameRate: 15
      });

      manager.stopStream('test-device');

      expect(events.length).toBe(1);
      expect(events[0].deviceId).toBe('test-device');
      expect(events[0].code).toBe(0);
    });
  });
});

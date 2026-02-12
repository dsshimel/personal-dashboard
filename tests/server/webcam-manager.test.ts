/**
 * @fileoverview Unit tests for WebcamManager.
 *
 * Tests device listing, stream management, JPEG parsing, and event emission.
 * Uses mocked Bun.spawn to avoid actual FFmpeg process spawning.
 * Tests both Linux (v4l2) and Windows (DirectShow) code paths.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { WebcamManager } from '../../server/webcam-manager';
import type { DeviceMode } from '../../server/webcam-manager';
import { createMockJpegFrame, captureEvents, encodeString } from './test-utils';

// Store original Bun.spawn and process.platform
const originalBunSpawn = Bun.spawn;
const originalPlatform = process.platform;

/** Sets process.platform for testing. */
function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
}

/** Restores process.platform to its original value. */
function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true });
}

/** Creates a mock Bun.spawn that returns a fake FFmpeg process. */
function createMockSpawn(opts?: { captureArgs?: boolean; stderrText?: string }) {
  let capturedArgs: string[] = [];
  const fn = mock((args: string[]) => {
    if (opts?.captureArgs) capturedArgs = args;
    return {
      pid: 12345,
      kill: mock(() => {}),
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
    // Restore original Bun.spawn and platform
    (globalThis as { Bun: typeof Bun }).Bun.spawn = originalBunSpawn;
    restorePlatform();
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

  describe('listDevices (Windows)', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    test('parses video devices from FFmpeg DirectShow output', async () => {
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

  describe('listDevices (Linux)', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    /** Mocks the private listVideoDeviceNodes method to return given paths. */
    function mockVideoNodes(paths: string[]) {
      (manager as unknown as { listVideoDeviceNodes: () => Promise<string[]> }).listVideoDeviceNodes =
        async () => paths;
    }

    test('parses video devices from /dev/video* and v4l2-ctl', async () => {
      // v4l2-ctl --info output for a capture device
      const v4l2InfoCapture = `Driver Info:
	Driver name      : uvcvideo
	Card type        : HD Pro Webcam C920
	Bus info         : usb-0000:00:14.0-1
	Driver version   : 6.1.0
	Capabilities     : 0x84A00001
		Video Capture
		Metadata Capture
		Streaming
		Extended Pix Format
		Device Capabilities
	Device Caps      : 0x04200001
		Video Capture
		Streaming
		Extended Pix Format
`;
      // v4l2-ctl --info output for a metadata device (should be filtered out)
      const v4l2InfoMetadata = `Driver Info:
	Driver name      : uvcvideo
	Card type        : HD Pro Webcam C920
	Bus info         : usb-0000:00:14.0-1
	Capabilities     : 0x84A00001
	Device Caps      : 0x04A00000
		Metadata Capture
`;
      const v4l2CapabilitiesStderr = `[video4linux2,v4l2 @ 0x1234] Compressed:       mjpeg :          Motion-JPEG : 1920x1080 1280x720 640x480
[video4linux2,v4l2 @ 0x1234] Raw       :     yuyv422 :           YUYV 4:2:2 : 640x480 320x240
`;

      let spawnCallCount = 0;
      const mockSpawn = mock((args: string[]) => {
        spawnCallCount++;
        const cmd = args[0];

        if (cmd === 'v4l2-ctl') {
          // Determine which device is being queried
          const deviceArg = args.find(a => a.startsWith('--device='));
          const isVideo0 = deviceArg?.includes('video0');
          const stdout = isVideo0 ? v4l2InfoCapture : v4l2InfoMetadata;
          return {
            stdout: new ReadableStream({
              start(c) { c.enqueue(encodeString(stdout)); c.close(); }
            }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            exited: Promise.resolve(0)
          };
        }

        // FFmpeg capability query
        return {
          stdout: new ReadableStream({ start(c) { c.close(); } }),
          stderr: new ReadableStream({
            start(c) { c.enqueue(encodeString(v4l2CapabilitiesStderr)); c.close(); }
          }),
          exited: Promise.resolve(1)
        };
      });

      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      // Mock device node listing to return two video devices
      mockVideoNodes(['/dev/video0', '/dev/video1']);

      const devices = await manager.listDevices();

      // video0 is capture, video1 is metadata — only video0 should appear
      expect(devices.length).toBe(1);
      expect(devices[0].id).toBe('/dev/video0');
      expect(devices[0].name).toBe('HD Pro Webcam C920');
      expect(devices[0].type).toBe('video');
      expect(devices[0].capabilities).toBeDefined();
      expect(devices[0].capabilities!.length).toBe(5); // 3 mjpeg + 2 yuyv422
      expect(devices[0].nativeMode).toEqual({ width: 1920, height: 1080, fps: 30, pixelFormat: 'mjpeg' });
    });

    test('returns empty array when no /dev/video* devices exist', async () => {
      mockVideoNodes([]);

      const devices = await manager.listDevices();
      expect(devices).toEqual([]);
    });

    test('emits error event when device enumeration throws', async () => {
      (manager as unknown as { listVideoDeviceNodes: () => Promise<string[]> }).listVideoDeviceNodes =
        async () => { throw new Error('Permission denied'); };

      const { events } = captureEvents<{ type: string; error: string }>(manager, 'error');

      const devices = await manager.listDevices();
      expect(devices).toEqual([]);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('list-error');
    });

    test('skips device and logs when v4l2-ctl is not installed', async () => {
      mockVideoNodes(['/dev/video0']);

      const mockSpawn = mock(() => {
        throw new Error('Executable not found in $PATH: "v4l2-ctl"');
      });
      (globalThis as { Bun: typeof Bun }).Bun.spawn = mockSpawn as typeof Bun.spawn;

      const devices = await manager.listDevices();
      // Should return empty — the device was skipped because v4l2-ctl wasn't found
      expect(devices).toEqual([]);
    });
  });

  describe('queryDeviceCapabilities (Linux)', () => {
    let queryCapabilitiesLinux: (deviceId: string) => Promise<DeviceMode[]>;

    beforeEach(() => {
      setPlatform('linux');
      queryCapabilitiesLinux = (manager as unknown as {
        queryCapabilitiesLinux: (deviceId: string) => Promise<DeviceMode[]>
      }).queryCapabilitiesLinux.bind(manager);
    });

    test('parses v4l2 compressed and raw formats', async () => {
      const stderr = `[video4linux2,v4l2 @ 0x5555] Compressed:       mjpeg :          Motion-JPEG : 640x480 1920x1080 1280x720
[video4linux2,v4l2 @ 0x5555] Raw       :     yuyv422 :           YUYV 4:2:2 : 640x480 320x240
`;
      installMockSpawn({ stderrText: stderr });

      const modes = await queryCapabilitiesLinux('/dev/video0');

      expect(modes.length).toBe(5);
      // MJPEG modes
      expect(modes[0]).toEqual({ pixelFormat: 'mjpeg', width: 640, height: 480, maxFps: 30 });
      expect(modes[1]).toEqual({ pixelFormat: 'mjpeg', width: 1920, height: 1080, maxFps: 30 });
      expect(modes[2]).toEqual({ pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 });
      // YUYV modes
      expect(modes[3]).toEqual({ pixelFormat: 'yuyv422', width: 640, height: 480, maxFps: 30 });
      expect(modes[4]).toEqual({ pixelFormat: 'yuyv422', width: 320, height: 240, maxFps: 30 });
    });

    test('returns empty array for unrecognized output', async () => {
      installMockSpawn({ stderrText: 'some random ffmpeg output\n' });

      const modes = await queryCapabilitiesLinux('/dev/video0');
      expect(modes).toEqual([]);
    });

    test('spawns FFmpeg with v4l2 flags', async () => {
      const { fn, getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await queryCapabilitiesLinux('/dev/video0');

      expect(fn).toHaveBeenCalled();
      const args = getCapturedArgs();
      expect(args).toContain('-f');
      expect(args).toContain('v4l2');
      expect(args).toContain('-list_formats');
      expect(args).toContain('all');
      expect(args).toContain('/dev/video0');
    });
  });

  describe('queryDeviceCapabilities (Windows)', () => {
    let queryCapabilitiesWindows: (deviceId: string) => Promise<DeviceMode[]>;

    beforeEach(() => {
      setPlatform('win32');
      queryCapabilitiesWindows = (manager as unknown as {
        queryCapabilitiesWindows: (deviceId: string) => Promise<DeviceMode[]>
      }).queryCapabilitiesWindows.bind(manager);
    });

    test('parses DirectShow capability output', async () => {
      const stderr = `[dshow @ 00000456] DirectShow video device options (from video pin)
[dshow @ 00000456]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30
[dshow @ 00000456]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=15
`;
      installMockSpawn({ stderrText: stderr });

      const modes = await queryCapabilitiesWindows('Integrated Webcam');

      expect(modes.length).toBe(2);
      expect(modes[0]).toEqual({ pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 });
      expect(modes[1]).toEqual({ pixelFormat: 'yuyv422', width: 640, height: 480, maxFps: 15 });
    });

    test('spawns FFmpeg with dshow flags', async () => {
      const { fn, getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await queryCapabilitiesWindows('My Webcam');

      expect(fn).toHaveBeenCalled();
      const args = getCapturedArgs();
      expect(args).toContain('-f');
      expect(args).toContain('dshow');
      expect(args).toContain('-list_options');
      expect(args).toContain('true');
      expect(args).toContain('video=My Webcam');
    });
  });

  describe('startStream (Linux)', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    test('spawns FFmpeg with v4l2 format and -input_format for MJPEG', async () => {
      const caps = (manager as unknown as { deviceCapabilities: Map<string, unknown> }).deviceCapabilities;
      caps.set('/dev/video0', {
        capabilities: [{ pixelFormat: 'mjpeg', width: 1280, height: 720, maxFps: 30 }],
        nativeMode: { width: 1280, height: 720, fps: 30, pixelFormat: 'mjpeg' }
      });

      const { fn, getCapturedArgs } = installMockSpawn({ captureArgs: true });

      const result = await manager.startStream('/dev/video0', 'grid');

      expect(result).toBe(true);
      expect(fn).toHaveBeenCalled();
      const args = getCapturedArgs();
      // Should use v4l2 format
      expect(args).toContain('-f');
      expect(args).toContain('v4l2');
      // Should use -input_format instead of -vcodec on Linux
      expect(args).toContain('-input_format');
      expect(args).toContain('mjpeg');
      expect(args).not.toContain('-vcodec');
      // Device path used directly (not video=...)
      expect(args).toContain('/dev/video0');
      expect(args).not.toContain('video=/dev/video0');
      // Grid mode scale filter
      expect(args).toContain('-vf');
      expect(args).toContain('scale=640:360');
      expect(args).toContain('-r');
      expect(args).toContain('15');
    });

    test('spawns FFmpeg in fullscreen mode without scale filter', async () => {
      const caps = (manager as unknown as { deviceCapabilities: Map<string, unknown> }).deviceCapabilities;
      caps.set('/dev/video0', {
        capabilities: [{ pixelFormat: 'mjpeg', width: 1920, height: 1080, maxFps: 30 }],
        nativeMode: { width: 1920, height: 1080, fps: 30, pixelFormat: 'mjpeg' }
      });

      const { getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await manager.startStream('/dev/video0', 'fullscreen');

      const args = getCapturedArgs();
      expect(args).toContain('-f');
      expect(args).toContain('v4l2');
      expect(args).toContain('-input_format');
      expect(args).not.toContain('-vf');
      expect(args).toContain('-r');
      expect(args).toContain('30');
    });

    test('omits -input_format when pixel format is not MJPEG', async () => {
      const caps = (manager as unknown as { deviceCapabilities: Map<string, unknown> }).deviceCapabilities;
      caps.set('/dev/video0', {
        capabilities: [{ pixelFormat: 'yuyv422', width: 640, height: 480, maxFps: 30 }],
        nativeMode: { width: 640, height: 480, fps: 30, pixelFormat: 'yuyv422' }
      });

      const { getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await manager.startStream('/dev/video0', 'grid');

      const args = getCapturedArgs();
      expect(args).not.toContain('-input_format');
      expect(args).not.toContain('-vcodec');
    });
  });

  describe('startStream (Windows)', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    test('returns true if already streaming same device', async () => {
      const activeStreams = (manager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
      activeStreams.set('test-device', { deviceId: 'test-device' });

      const result = await manager.startStream('test-device');
      expect(result).toBe(true);
    });

    test('spawns FFmpeg with native resolution and grid mode output filter', async () => {
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
  });

  describe('startStream (common)', () => {
    test('includes low-latency FFmpeg flags', async () => {
      const { getCapturedArgs } = installMockSpawn({ captureArgs: true });

      await manager.startStream('test-device');

      const args = getCapturedArgs();
      expect(args).toContain('-fflags');
      expect(args).toContain('nobuffer');
      expect(args).toContain('-probesize');
      expect(args).toContain('32');
      expect(args).toContain('-analyzeduration');
      expect(args).toContain('0');
      // Low-latency flags should come before -i
      const fflagsIdx = args.indexOf('-fflags');
      const inputIdx = args.indexOf('-i');
      expect(fflagsIdx).toBeLessThan(inputIdx);
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

  describe('FrameBuffer', () => {
    let createFrameBuffer: (deviceId: string, fps: number) => void;
    let pushFrame: (deviceId: string, base64: string) => void;
    let destroyFrameBuffer: (deviceId: string) => void;
    let frameBuffers: Map<string, { frames: (string | null)[]; writeIndex: number; readIndex: number; count: number; timer: ReturnType<typeof setInterval> }>;

    beforeEach(() => {
      const m = manager as unknown as {
        createFrameBuffer: (deviceId: string, fps: number) => void;
        pushFrame: (deviceId: string, base64: string) => void;
        destroyFrameBuffer: (deviceId: string) => void;
        frameBuffers: typeof frameBuffers;
      };
      createFrameBuffer = m.createFrameBuffer.bind(manager);
      pushFrame = m.pushFrame.bind(manager);
      destroyFrameBuffer = m.destroyFrameBuffer.bind(manager);
      frameBuffers = m.frameBuffers;
    });

    afterEach(() => {
      // Clean up any active timers
      for (const [deviceId] of frameBuffers) {
        destroyFrameBuffer(deviceId);
      }
    });

    test('createFrameBuffer adds a buffer to the map', () => {
      createFrameBuffer('test-device', 15);
      expect(frameBuffers.has('test-device')).toBe(true);
      const buf = frameBuffers.get('test-device')!;
      expect(buf.count).toBe(0);
      expect(buf.writeIndex).toBe(0);
      expect(buf.readIndex).toBe(0);
      expect(buf.frames.length).toBe(4);
    });

    test('destroyFrameBuffer removes the buffer', () => {
      createFrameBuffer('test-device', 15);
      expect(frameBuffers.has('test-device')).toBe(true);
      destroyFrameBuffer('test-device');
      expect(frameBuffers.has('test-device')).toBe(false);
    });

    test('destroyFrameBuffer is safe to call when no buffer exists', () => {
      expect(() => destroyFrameBuffer('nonexistent')).not.toThrow();
    });

    test('pushFrame adds frames to the buffer', () => {
      createFrameBuffer('test-device', 15);
      pushFrame('test-device', 'frame1');
      pushFrame('test-device', 'frame2');
      const buf = frameBuffers.get('test-device')!;
      expect(buf.count).toBe(2);
      expect(buf.frames[0]).toBe('frame1');
      expect(buf.frames[1]).toBe('frame2');
    });

    test('pushFrame overwrites oldest when buffer is full', () => {
      createFrameBuffer('test-device', 15);
      pushFrame('test-device', 'frame1');
      pushFrame('test-device', 'frame2');
      pushFrame('test-device', 'frame3');
      pushFrame('test-device', 'frame4');
      // Buffer is now full (size 4)
      const buf = frameBuffers.get('test-device')!;
      expect(buf.count).toBe(4);

      // Push one more — should overwrite frame1
      pushFrame('test-device', 'frame5');
      expect(buf.count).toBe(4);
      // readIndex should have advanced past the overwritten slot
      expect(buf.frames[buf.readIndex]).toBe('frame2');
    });

    test('pushFrame falls back to direct emit when no buffer exists', () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');
      pushFrame('no-buffer-device', 'directFrame');
      expect(events.length).toBe(1);
      expect(events[0].data).toBe('directFrame');
    });

    test('first frame is emitted immediately when buffer is empty', () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      createFrameBuffer('test-device', 15);
      pushFrame('test-device', 'firstFrame');

      // First frame should be emitted synchronously
      expect(events.length).toBe(1);
      expect(events[0].data).toBe('firstFrame');
    });

    test('subsequent frames are not emitted synchronously', () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      createFrameBuffer('test-device', 15);
      pushFrame('test-device', 'frame1');
      pushFrame('test-device', 'frame2');
      pushFrame('test-device', 'frame3');

      // Only the first frame is emitted synchronously
      expect(events.length).toBe(1);
      expect(events[0].data).toBe('frame1');
    });

    test('buffer drains frames at steady interval', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      // 100 FPS = 10ms interval for fast testing
      createFrameBuffer('test-device', 100);
      pushFrame('test-device', 'frame1');
      pushFrame('test-device', 'frame2');
      pushFrame('test-device', 'frame3');

      // First frame emitted immediately, rest buffered
      expect(events.length).toBe(1);

      // Wait for drain timer ticks
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(events.length).toBe(4); // 1 immediate + 3 from buffer drain
      expect(events[0].data).toBe('frame1'); // immediate
      expect(events[1].data).toBe('frame1'); // first drain tick (still in buffer)
      expect(events[2].data).toBe('frame2');
      expect(events[3].data).toBe('frame3');
    });

    test('empty buffer ticks do not emit frames', async () => {
      const { events } = captureEvents<{ deviceId: string; data: string }>(manager, 'frame');

      createFrameBuffer('test-device', 100);

      // Wait for several timer ticks with empty buffer
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(events.length).toBe(0);
    });

    test('createFrameBuffer destroys existing buffer for same device', () => {
      createFrameBuffer('test-device', 15);
      const buf1 = frameBuffers.get('test-device')!;
      const timer1 = buf1.timer;

      createFrameBuffer('test-device', 30);
      const buf2 = frameBuffers.get('test-device')!;

      // Should be a different buffer instance
      expect(buf2).not.toBe(buf1);
      expect(frameBuffers.size).toBe(1);
    });

    test('startStream creates a frame buffer', async () => {
      installMockSpawn();
      await manager.startStream('test-device');
      expect(frameBuffers.has('test-device')).toBe(true);
    });

    test('stopStream destroys the frame buffer', async () => {
      installMockSpawn();
      await manager.startStream('test-device');
      expect(frameBuffers.has('test-device')).toBe(true);
      manager.stopStream('test-device');
      expect(frameBuffers.has('test-device')).toBe(false);
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

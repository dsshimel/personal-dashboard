/**
 * @fileoverview Webcam streaming manager using FFmpeg.
 *
 * Provides webcam device enumeration and MJPEG streaming via FFmpeg.
 * Supports Linux (Video4Linux2) and Windows (DirectShow) platforms.
 *
 * Always captures at the camera's native max resolution and frame rate,
 * then uses FFmpeg output filters to scale and adjust FPS per output mode.
 */

import { EventEmitter } from 'events';
import { readdir } from 'fs/promises';

const log = (msg: string) => {
  console.log(msg);
};

/** A supported resolution+framerate combination reported by the capture device. */
export interface DeviceMode {
  /** Horizontal resolution in pixels. */
  width: number;
  /** Vertical resolution in pixels. */
  height: number;
  /** Maximum frame rate for this mode. */
  maxFps: number;
  /** Pixel format or codec name (e.g., 'mjpeg', 'yuyv422'). */
  pixelFormat: string;
}

/** Represents a webcam device detected by FFmpeg. */
export interface WebcamDevice {
  /** Device identifier (device path on Linux, device name on Windows). */
  id: string;
  /** Human-readable device name. */
  name: string;
  /** Device type (only 'video' devices are used). */
  type: 'video' | 'audio';
  /** Supported modes discovered via FFmpeg device query. */
  capabilities?: DeviceMode[];
  /** The best native mode (highest MJPEG resolution and fps). */
  nativeMode?: { width: number; height: number; fps: number; pixelFormat: string };
}

/** Output display mode for the stream. */
export type OutputMode = 'grid' | 'fullscreen';

/** Grid mode output FPS (fullscreen uses native fps). */
const GRID_FPS = 15;

/** Number of slots in the per-stream frame ring buffer. */
const FRAME_BUFFER_SIZE = 4;

/** Per-stream ring buffer that smooths bursty FFmpeg output into steady emission. */
interface FrameBuffer {
  frames: (string | null)[];
  writeIndex: number;
  readIndex: number;
  count: number;
  timer: ReturnType<typeof setInterval>;
}

/** Tracks an active FFmpeg streaming process. */
interface FFmpegProcess {
  /** The Bun subprocess handle. */
  process: ReturnType<typeof Bun.spawn>;
  /** Device ID this process is streaming from. */
  deviceId: string;
  /** Native input resolution being captured. */
  inputResolution: string;
  /** Native input frame rate. */
  inputFrameRate: number;
  /** Current output mode. */
  outputMode: OutputMode;
  /** Current output resolution (may differ from input due to scaling). */
  resolution: string;
  /** Current output frame rate. */
  frameRate: number;
}

/**
 * Manages webcam device enumeration and MJPEG streaming via FFmpeg.
 *
 * Emits events for frames, stream lifecycle, and errors.
 * Uses Video4Linux2 on Linux and DirectShow on Windows.
 */
export class WebcamManager extends EventEmitter {
  /** Map of device ID to active FFmpeg process. */
  private activeStreams: Map<string, FFmpegProcess> = new Map();
  /** Set of device IDs currently changing mode (don't emit stop for these). */
  private changingResolution: Set<string> = new Set();
  /** JPEG quality (2-31, lower is better quality). */
  private quality: number;
  /** Cache of device capabilities to avoid repeated FFmpeg queries. */
  private deviceCapabilities: Map<string, { capabilities: DeviceMode[]; nativeMode: { width: number; height: number; fps: number; pixelFormat: string } | null }> = new Map();
  /** Per-device frame buffers for smoothing output. */
  private frameBuffers: Map<string, FrameBuffer> = new Map();
  /** Per-device timestamps for mode switch telemetry. */
  private streamStartTimes: Map<string, number> = new Map();

  /**
   * Creates a new WebcamManager.
   *
   * @param quality - JPEG quality (2-31, lower is better). Defaults to 5.
   */
  constructor(quality = 5) {
    super();
    this.quality = quality;
  }

  /**
   * Lists available webcam devices.
   *
   * On Linux, enumerates /dev/video* devices and uses v4l2-ctl to identify
   * capture devices. On Windows, uses FFmpeg DirectShow device enumeration.
   * Queries each video device for its supported modes.
   *
   * @returns Array of detected webcam devices with capabilities.
   */
  async listDevices(): Promise<WebcamDevice[]> {
    const devices: WebcamDevice[] =
      process.platform === 'win32'
        ? await this.listDevicesWindows()
        : process.platform === 'linux'
          ? await this.listDevicesLinux()
          : (() => { throw new Error(`Unsupported platform: ${process.platform}. Only linux and win32 are supported.`); })();

    // Query capabilities for each video device
    for (const device of devices) {
      const cached = this.deviceCapabilities.get(device.id);
      if (cached) {
        device.capabilities = cached.capabilities;
        device.nativeMode = cached.nativeMode ?? undefined;
      } else {
        const caps = await this.queryDeviceCapabilities(device.id);
        const native = this.selectNativeMode(caps);
        device.capabilities = caps;
        device.nativeMode = native ?? undefined;
        this.deviceCapabilities.set(device.id, { capabilities: caps, nativeMode: native });
        log(`[WebcamManager] Device "${device.name}" capabilities: ${caps.length} modes, native: ${native ? `${native.width}x${native.height}@${native.fps}fps` : 'unknown'}`);
      }
    }

    // Filter out devices with no detected capabilities (ISP pipeline nodes, metadata endpoints, etc.)
    return devices.filter(d => d.capabilities && d.capabilities.length > 0);
  }

  /**
   * Lists webcam devices on Linux using /dev/video* and v4l2-ctl.
   *
   * Filters out metadata devices (only includes capture-capable devices).
   */
  private async listDevicesLinux(): Promise<WebcamDevice[]> {
    const devices: WebcamDevice[] = [];

    try {
      const videoPaths = await this.listVideoDeviceNodes();
      log(`[WebcamManager] Found ${videoPaths.length} /dev/video* nodes: ${videoPaths.join(', ')}`);

      // Check each device with v4l2-ctl to filter capture devices and get names
      // v4l2-ctl is from the v4l-utils package (apt install v4l-utils)
      for (const devPath of videoPaths) {
        try {
          const proc = Bun.spawn(['v4l2-ctl', `--device=${devPath}`, '--info'], {
            stdout: 'pipe',
            stderr: 'pipe',
          });

          const stdout = await new Response(proc.stdout).text();
          const exitCode = await proc.exited;
          log(`[WebcamManager] v4l2-ctl ${devPath}: exit=${exitCode}, hasCapture=${stdout.includes('Video Capture')}`);

          // Skip non-capture devices (metadata nodes report "Video Output" or no "Video Capture")
          if (!stdout.includes('Video Capture')) {
            continue;
          }

          // Extract card name from "Card type     : <name>" line
          const cardMatch = stdout.match(/Card type\s*:\s*(.+)/);
          const name = cardMatch ? cardMatch[1].trim() : devPath;

          devices.push({
            id: devPath,
            name,
            type: 'video',
          });
          log(`[WebcamManager] Added capture device: ${devPath} (${name})`);
        } catch (err) {
          const msg = String(err);
          if (msg.includes('ENOENT') || msg.includes('not found')) {
            log(`[WebcamManager] v4l2-ctl not found. Install v4l-utils: apt install v4l-utils`);
            break;
          }
          log(`[WebcamManager] Failed to query ${devPath}: ${msg}`);
        }
      }
    } catch (error) {
      console.error('Error listing webcam devices:', error);
      this.emit('error', { type: 'list-error', error: String(error) });
    }

    return devices;
  }

  /** Enumerates /dev/video* device node paths. */
  private async listVideoDeviceNodes(): Promise<string[]> {
    const entries = await readdir('/dev');
    return entries
      .filter(e => e.startsWith('video'))
      .map(e => `/dev/${e}`)
      .sort();
  }

  /**
   * Lists webcam devices on Windows using FFmpeg DirectShow.
   */
  private async listDevicesWindows(): Promise<WebcamDevice[]> {
    const devices: WebcamDevice[] = [];

    try {
      const proc = Bun.spawn(['ffmpeg', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // FFmpeg outputs device list to stderr
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      const lines = stderr.split('\n');

      for (const line of lines) {
        if (line.includes('Alternative name')) {
          continue;
        }

        // Example: [dshow @ 000001...] "Integrated Webcam" (video)
        const match = line.match(/\[dshow @[^\]]+\]\s+"([^"]+)"\s+\((video|audio)\)/);
        if (match) {
          const deviceName = match[1];
          const deviceType = match[2] as 'video' | 'audio';

          if (deviceType === 'video') {
            devices.push({
              id: deviceName,
              name: deviceName,
              type: 'video',
            });
          }
        }
      }
    } catch (error) {
      console.error('Error listing webcam devices:', error);
      this.emit('error', { type: 'list-error', error: String(error) });
    }

    return devices;
  }

  /**
   * Queries supported resolutions and frame rates for a specific device.
   *
   * On Linux, runs: ffmpeg -f v4l2 -list_formats all -i <device>
   * On Windows, runs: ffmpeg -f dshow -list_options true -i video=<device>
   *
   * @param deviceId - The device identifier to query.
   * @returns Array of supported modes.
   */
  private async queryDeviceCapabilities(deviceId: string): Promise<DeviceMode[]> {
    if (process.platform === 'win32') return this.queryCapabilitiesWindows(deviceId);
    if (process.platform === 'linux') return this.queryCapabilitiesLinux(deviceId);
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  /**
   * Queries device capabilities on Linux using FFmpeg v4l2.
   *
   * Parses output like:
   *   [video4linux2,v4l2 @ ...] Compressed:       mjpeg : ... : 640x480 1920x1080
   *   [video4linux2,v4l2 @ ...] Raw       :     yuyv422 : ... : 640x480 320x240
   */
  private async queryCapabilitiesLinux(deviceId: string): Promise<DeviceMode[]> {
    const modes: DeviceMode[] = [];
    try {
      log(`[WebcamManager] Querying capabilities for ${deviceId} via ffmpeg -f v4l2 -list_formats all`);
      const proc = Bun.spawn(
        ['ffmpeg', '-f', 'v4l2', '-list_formats', 'all', '-i', deviceId],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const v4l2Lines = stderr.split('\n').filter(l => l.includes('[video4linux2'));
      log(`[WebcamManager] ffmpeg exit=${exitCode}, v4l2 format lines: ${v4l2Lines.length}`);

      // Each line has a pixel format and space-separated resolutions:
      // [video4linux2,v4l2 @ ...] Compressed:       mjpeg :     Motion-JPEG : 640x480 160x90 ... 1920x1080
      // [video4linux2,v4l2 @ ...] Raw       :     yuyv422 :     YUYV 4:2:2 : 640x480 160x90 ...
      const lineRegex = /\[video4linux2.*\]\s+(?:Compressed|Raw)\s*:\s*(\w+)\s*:.*:\s+([\dx\s]+)/;
      for (const line of stderr.split('\n')) {
        const m = line.match(lineRegex);
        if (m) {
          const pixelFormat = m[1];
          const resolutions = m[2].trim().split(/\s+/);
          for (const res of resolutions) {
            const parts = res.match(/^(\d+)x(\d+)$/);
            if (parts) {
              modes.push({
                pixelFormat,
                width: parseInt(parts[1], 10),
                height: parseInt(parts[2], 10),
                maxFps: 30, // v4l2 list_formats doesn't report fps; 30 is standard USB webcam default
              });
            }
          }
        }
      }
    } catch (error) {
      log(`[WebcamManager] Failed to query capabilities for ${deviceId}: ${error}`);
    }
    return modes;
  }

  /**
   * Queries device capabilities on Windows using FFmpeg DirectShow.
   *
   * Parses output like:
   *   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
   *   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30
   */
  private async queryCapabilitiesWindows(deviceId: string): Promise<DeviceMode[]> {
    const modes: DeviceMode[] = [];
    try {
      const proc = Bun.spawn(
        ['ffmpeg', '-f', 'dshow', '-list_options', 'true', '-i', `video=${deviceId}`],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      const lineRegex =
        /(?:pixel_format=(\w+)|vcodec=(\w+))\s+min\s+s=(\d+)x(\d+)\s+fps=([\d.]+)\s+max\s+s=(\d+)x(\d+)\s+fps=([\d.]+)/;
      for (const line of stderr.split('\n')) {
        const m = line.match(lineRegex);
        if (m) {
          modes.push({
            pixelFormat: m[1] || m[2],
            width: parseInt(m[6], 10),
            height: parseInt(m[7], 10),
            maxFps: parseFloat(m[8]),
          });
        }
      }
    } catch (error) {
      log(`[WebcamManager] Failed to query capabilities for ${deviceId}: ${error}`);
    }
    return modes;
  }

  /**
   * Selects the best native capture mode from device capabilities.
   *
   * Prefers MJPEG over raw pixel formats (lower CPU), then highest
   * resolution, then highest fps.
   *
   * @param capabilities - Array of supported modes.
   * @returns The best mode, or null if no capabilities.
   */
  private selectNativeMode(capabilities: DeviceMode[]): { width: number; height: number; fps: number; pixelFormat: string } | null {
    if (capabilities.length === 0) return null;

    const mjpegModes = capabilities.filter(m => m.pixelFormat === 'mjpeg');
    const pool = mjpegModes.length > 0 ? mjpegModes : capabilities;

    // Sort by pixel count descending, then fps descending
    const sorted = [...pool].sort((a, b) => {
      const pixelsA = a.width * a.height;
      const pixelsB = b.width * b.height;
      if (pixelsB !== pixelsA) return pixelsB - pixelsA;
      return b.maxFps - a.maxFps;
    });

    const best = sorted[0];
    return { width: best.width, height: best.height, fps: best.maxFps, pixelFormat: best.pixelFormat };
  }

  /**
   * Starts MJPEG streaming from a webcam device.
   *
   * Opens the camera at its native max resolution and frame rate.
   * Applies output scaling and frame rate based on the output mode.
   *
   * @param deviceId - The device ID (name) to stream from.
   * @param outputMode - 'grid' for downscaled output, 'fullscreen' for native pass-through.
   * @returns True if stream started successfully.
   */
  async startStream(deviceId: string, outputMode: OutputMode = 'grid'): Promise<boolean> {
    if (this.activeStreams.has(deviceId)) {
      console.log(`Stream already active for device: ${deviceId}`);
      return true;
    }

    // Look up cached capabilities
    const cached = this.deviceCapabilities.get(deviceId);
    const nativeMode = cached?.nativeMode;

    const inputWidth = nativeMode?.width ?? 640;
    const inputHeight = nativeMode?.height ?? 480;
    const inputFps = nativeMode?.fps ?? 30;
    const inputResolution = `${inputWidth}x${inputHeight}`;

    // Grid mode: half the native resolution (preserving aspect ratio), capped fps
    // Fullscreen mode: native resolution and fps, no scaling
    const isGrid = outputMode === 'grid';
    const gridWidth = Math.round(inputWidth / 2);
    const gridHeight = Math.round(inputHeight / 2);
    const needsScale = isGrid && (gridWidth !== inputWidth || gridHeight !== inputHeight);
    const outputFps = isGrid ? GRID_FPS : inputFps;

    try {
      log(`[WebcamManager] Starting stream for: ${deviceId}, input: ${inputResolution}@${inputFps}fps, mode: ${outputMode}`);

      // FFmpeg command: capture at native resolution, apply output filters
      // Input format flags must come BEFORE -i to set the capture format from the camera
      // Force MJPEG input when available to prevent H.264 software decode (which can saturate CPU)
      const isWindows = process.platform === 'win32';
      const inputFormat = nativeMode?.pixelFormat;
      const mjpegArgs = inputFormat === 'mjpeg'
        ? (isWindows ? ['-vcodec', 'mjpeg'] : ['-input_format', 'mjpeg'])
        : [];
      const args: string[] = [
        '-fflags', 'nobuffer',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-f', isWindows ? 'dshow' : 'v4l2',
        ...mjpegArgs,
        '-video_size', inputResolution,
        '-framerate', String(inputFps),
        '-i', isWindows ? `video=${deviceId}` : deviceId,
      ];

      // Add scale filter for grid mode: half native resolution
      if (needsScale) {
        args.push('-vf', `scale=${gridWidth}:${gridHeight}`);
      }

      args.push(
        '-r', String(outputFps),
        '-f', 'mjpeg',
        '-q:v', String(this.quality),
        '-',
      );

      log(`[WebcamManager] FFmpeg args: ffmpeg ${args.join(' ')}`);

      const proc = Bun.spawn(['ffmpeg', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const outputResolution = needsScale
        ? `${gridWidth}x${gridHeight}`
        : inputResolution;

      this.activeStreams.set(deviceId, {
        process: proc,
        deviceId,
        inputResolution,
        inputFrameRate: inputFps,
        outputMode,
        resolution: outputResolution,
        frameRate: outputFps,
      });

      // Create frame buffer for smooth output at target FPS
      this.createFrameBuffer(deviceId, outputFps);

      // Handle stderr for logging (FFmpeg outputs progress to stderr)
      this.handleStderr(deviceId, proc.stderr);

      // Handle stdout for frame data
      this.handleFrameStream(deviceId, proc.stdout);

      // Handle process exit
      proc.exited.then((code) => {
        log(`[WebcamManager] FFmpeg process exited for ${deviceId} with code ${code}`);
        // Don't emit stream-stopped if we're just changing mode
        if (this.changingResolution.has(deviceId)) {
          log(`[WebcamManager] Skipping stream-stopped emit for ${deviceId} (mode change)`);
          return;
        }
        log(`[WebcamManager] Emitting stream-stopped for ${deviceId}`);
        this.activeStreams.delete(deviceId);
        this.emit('stream-stopped', { deviceId, code });
      });

      this.emit('stream-started', { deviceId });
      return true;
    } catch (error) {
      console.error(`Error starting stream for ${deviceId}:`, error);
      this.emit('error', { deviceId, type: 'start-error', error: String(error) });
      return false;
    }
  }

  /**
   * Stops streaming from a webcam device.
   *
   * @param deviceId - The device ID to stop streaming.
   * @returns True if stream was stopped, false if not streaming.
   */
  stopStream(deviceId: string): boolean {
    const stream = this.activeStreams.get(deviceId);
    if (!stream) {
      console.log(`No active stream for device: ${deviceId}`);
      return false;
    }

    try {
      console.log(`Stopping webcam stream for: ${deviceId}`);
      this.destroyFrameBuffer(deviceId);
      stream.process.kill();
      this.activeStreams.delete(deviceId);
      this.emit('stream-stopped', { deviceId, code: 0 });
      return true;
    } catch (error) {
      console.error(`Error stopping stream for ${deviceId}:`, error);
      return false;
    }
  }

  /** Stops all active webcam streams. */
  stopAllStreams(): void {
    for (const [deviceId] of this.activeStreams) {
      this.stopStream(deviceId);
    }
  }

  /**
   * Changes the output mode of an active stream (grid vs fullscreen).
   *
   * Kills and restarts FFmpeg. The camera input resolution stays the same;
   * only the output filter chain changes.
   *
   * @param deviceId - The device ID to change mode for.
   * @param outputMode - New output mode.
   * @returns True if mode change was initiated successfully.
   */
  async setOutputMode(deviceId: string, outputMode: OutputMode): Promise<boolean> {
    const stream = this.activeStreams.get(deviceId);
    if (!stream) {
      console.log(`No active stream for device: ${deviceId}`);
      return false;
    }

    if (stream.outputMode === outputMode) {
      console.log(`Stream already in ${outputMode} mode for device: ${deviceId}`);
      return true;
    }

    log(`[WebcamManager] Changing output mode for ${deviceId} from ${stream.outputMode} to ${outputMode}`);
    const t0 = performance.now();

    // Mark as changing so we don't emit stream-stopped
    this.changingResolution.add(deviceId);

    // Stop current stream and wait for it to exit
    try {
      log(`[WebcamManager] Killing FFmpeg process for ${deviceId}`);
      const oldProcess = stream.process;
      stream.process.kill();
      this.destroyFrameBuffer(deviceId);
      this.activeStreams.delete(deviceId);
      const tKill = performance.now();

      log(`[WebcamManager] Waiting for old process to exit`);
      await oldProcess.exited;
      const tExit = performance.now();
      log(`[WebcamManager] Old process exited (kill=${(tKill - t0).toFixed(0)}ms, exit=${(tExit - tKill).toFixed(0)}ms)`);
    } catch (error) {
      this.changingResolution.delete(deviceId);
      console.error(`Error stopping stream for mode change: ${error}`);
      return false;
    }

    // Start new stream with new mode
    const tSpawnStart = performance.now();
    log(`[WebcamManager] Starting new stream in ${outputMode} mode`);
    this.streamStartTimes.set(deviceId, tSpawnStart);
    const result = await this.startStream(deviceId, outputMode);
    const tSpawnEnd = performance.now();

    // Now safe to clear the flag after new stream has started
    this.changingResolution.delete(deviceId);
    log(`[WebcamManager] Mode switch for ${deviceId}: total=${(tSpawnEnd - t0).toFixed(0)}ms, spawn=${(tSpawnEnd - tSpawnStart).toFixed(0)}ms`);
    return result;
  }

  /**
   * Checks if a device is currently streaming.
   *
   * @param deviceId - The device ID to check.
   * @returns True if the device is streaming.
   */
  isStreaming(deviceId: string): boolean {
    return this.activeStreams.has(deviceId);
  }

  /**
   * Gets the list of currently streaming device IDs.
   *
   * @returns Array of device IDs that are currently streaming.
   */
  getActiveStreams(): string[] {
    return Array.from(this.activeStreams.keys());
  }

  /**
   * Handles FFmpeg stderr output, emitting errors when detected.
   *
   * @param deviceId - The device this stream is for.
   * @param stderr - The stderr ReadableStream from FFmpeg.
   */
  private async handleStderr(deviceId: string, stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);

        // Log all FFmpeg stderr for debugging - it contains resolution info
        log(`[FFmpeg stderr ${deviceId}] ${text.trim()}`);

        // Emit errors
        if (text.includes('Error') || text.includes('error') || text.includes('Invalid')) {
          this.emit('error', { deviceId, type: 'ffmpeg-error', error: text });
        }
      }
    } catch {
      // Stream closed, ignore
    }
  }

  /**
   * Parses JPEG dimensions from the frame data.
   * Looks for SOF0 marker (0xFFC0) which contains width/height.
   */
  private parseJpegDimensions(data: Uint8Array): { width: number; height: number } | null {
    // Look for SOF0 marker (0xFF 0xC0) or SOF2 (0xFF 0xC2)
    for (let i = 0; i < data.length - 9; i++) {
      if (data[i] === 0xFF && (data[i + 1] === 0xC0 || data[i + 1] === 0xC2)) {
        // SOF format: FF C0 LL LL PP HH HH WW WW
        // LL LL = length, PP = precision, HH HH = height, WW WW = width
        const height = (data[i + 5] << 8) | data[i + 6];
        const width = (data[i + 7] << 8) | data[i + 8];
        return { width, height };
      }
    }
    return null;
  }

  /**
   * Creates a frame buffer for a device that drains at a steady FPS interval.
   *
   * @param deviceId - The device to create a buffer for.
   * @param fps - Target output frame rate.
   */
  private createFrameBuffer(deviceId: string, fps: number): void {
    this.destroyFrameBuffer(deviceId);
    const intervalMs = Math.round(1000 / fps);
    const frames = new Array<string | null>(FRAME_BUFFER_SIZE).fill(null);

    const timer = setInterval(() => {
      const buf = this.frameBuffers.get(deviceId);
      if (!buf || buf.count === 0) return;

      const data = buf.frames[buf.readIndex];
      buf.frames[buf.readIndex] = null;
      buf.readIndex = (buf.readIndex + 1) % FRAME_BUFFER_SIZE;
      buf.count--;

      if (data) {
        this.emit('frame', { deviceId, data });
      }
    }, intervalMs);

    this.frameBuffers.set(deviceId, { frames, writeIndex: 0, readIndex: 0, count: 0, timer });
  }

  /**
   * Pushes a frame into the ring buffer for a device.
   * If the buffer is full, the oldest frame is overwritten.
   *
   * @param deviceId - The device that produced the frame.
   * @param base64 - Base64-encoded JPEG frame data.
   */
  private pushFrame(deviceId: string, base64: string): void {
    const buf = this.frameBuffers.get(deviceId);
    if (!buf) {
      this.emit('frame', { deviceId, data: base64 });
      return;
    }

    // Emit first frame immediately to minimize time-to-display after mode switch
    if (buf.count === 0) {
      this.emit('frame', { deviceId, data: base64 });
    }

    buf.frames[buf.writeIndex] = base64;
    buf.writeIndex = (buf.writeIndex + 1) % FRAME_BUFFER_SIZE;

    if (buf.count < FRAME_BUFFER_SIZE) {
      buf.count++;
    } else {
      // Overwrite oldest: advance read pointer
      buf.readIndex = (buf.readIndex + 1) % FRAME_BUFFER_SIZE;
    }
  }

  /**
   * Destroys the frame buffer for a device, clearing its drain timer.
   *
   * @param deviceId - The device to destroy the buffer for.
   */
  private destroyFrameBuffer(deviceId: string): void {
    const buf = this.frameBuffers.get(deviceId);
    if (buf) {
      clearInterval(buf.timer);
      this.frameBuffers.delete(deviceId);
    }
  }

  /**
   * Parses MJPEG frame stream from FFmpeg stdout.
   *
   * MJPEG frames are delimited by SOI (0xFFD8) and EOI (0xFFD9) markers.
   * Extracts complete frames and pushes them into the frame buffer.
   *
   * @param deviceId - The device this stream is for.
   * @param stdout - The stdout ReadableStream from FFmpeg.
   */
  private async handleFrameStream(deviceId: string, stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    let buffer = new Uint8Array(0);
    let firstFrameLogged = false;

    // JPEG markers: SOI = 0xFFD8 (Start of Image), EOI = 0xFFD9 (End of Image)

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append new data to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        // Extract complete JPEG frames
        while (buffer.length > 4) {
          // Find JPEG SOI marker
          let soiIndex = -1;
          for (let i = 0; i < buffer.length - 1; i++) {
            if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
              soiIndex = i;
              break;
            }
          }

          if (soiIndex === -1) {
            // No SOI found, clear buffer up to last byte (might be partial 0xFF)
            buffer = buffer.slice(Math.max(0, buffer.length - 1));
            break;
          }

          // Find JPEG EOI marker after SOI
          let eoiIndex = -1;
          for (let i = soiIndex + 2; i < buffer.length - 1; i++) {
            if (buffer[i] === 0xFF && buffer[i + 1] === 0xD9) {
              eoiIndex = i + 2; // Include the EOI marker
              break;
            }
          }

          if (eoiIndex === -1) {
            // No complete frame yet, wait for more data
            // Trim any data before SOI
            if (soiIndex > 0) {
              buffer = buffer.slice(soiIndex);
            }
            break;
          }

          // Extract the complete JPEG frame
          const frame = buffer.slice(soiIndex, eoiIndex);
          buffer = buffer.slice(eoiIndex);

          // Parse JPEG dimensions from SOF0 marker for debugging
          const dims = this.parseJpegDimensions(frame);
          if (dims) {
            // Only log occasionally to avoid spam (every 30 frames ~= 2 seconds)
            if (Math.random() < 0.03) {
              log(`[WebcamManager] Frame for ${deviceId}: ${dims.width}x${dims.height}, size=${frame.length} bytes`);
            }
          }

          // Convert to base64 and push into frame buffer
          const base64 = btoa(String.fromCharCode(...frame));
          if (!firstFrameLogged) {
            firstFrameLogged = true;
            const startTime = this.streamStartTimes.get(deviceId);
            if (startTime) {
              log(`[WebcamManager] First frame for ${deviceId}: ${(performance.now() - startTime).toFixed(0)}ms after spawn`);
              this.streamStartTimes.delete(deviceId);
            }
          }
          this.pushFrame(deviceId, base64);
        }
      }
    } catch (error) {
      // Stream closed or error
      console.error(`Frame stream error for ${deviceId}:`, error);
    }
  }
}

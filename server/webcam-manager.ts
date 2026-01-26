/**
 * @fileoverview Webcam streaming manager using FFmpeg.
 *
 * Provides webcam device enumeration and MJPEG streaming via FFmpeg.
 * Designed for Windows DirectShow devices, streams frames as base64 JPEG.
 */

import { EventEmitter } from 'events';
import { logToFile } from './file-logger.js';

const log = (msg: string) => {
  console.log(msg);
  logToFile('info', msg);
};

/** Represents a webcam device detected by FFmpeg. */
export interface WebcamDevice {
  /** Device identifier (device name on Windows DirectShow). */
  id: string;
  /** Human-readable device name. */
  name: string;
  /** Device type (only 'video' devices are used). */
  type: 'video' | 'audio';
}

/** Tracks an active FFmpeg streaming process. */
interface FFmpegProcess {
  /** The Bun subprocess handle. */
  process: ReturnType<typeof Bun.spawn>;
  /** Device ID this process is streaming from. */
  deviceId: string;
  /** Current resolution of the stream. */
  resolution: string;
  /** Current frame rate of the stream. */
  frameRate: number;
}

/**
 * Manages webcam device enumeration and MJPEG streaming via FFmpeg.
 *
 * Emits events for frames, stream lifecycle, and errors.
 * Uses FFmpeg DirectShow on Windows to capture and encode MJPEG.
 */
export class WebcamManager extends EventEmitter {
  /** Map of device ID to active FFmpeg process. */
  private activeStreams: Map<string, FFmpegProcess> = new Map();
  /** Set of device IDs currently changing resolution (don't emit stop for these). */
  private changingResolution: Set<string> = new Set();
  /** Target frame rate for streaming. */
  private frameRate: number;
  /** JPEG quality (2-31, lower is better quality). */
  private quality: number;

  /**
   * Creates a new WebcamManager.
   *
   * @param frameRate - Target FPS for streaming. Defaults to 15.
   * @param quality - JPEG quality (2-31, lower is better). Defaults to 5.
   */
  constructor(frameRate = 15, quality = 5) {
    super();
    this.frameRate = frameRate;
    this.quality = quality;
  }

  /**
   * Lists available webcam devices using FFmpeg DirectShow.
   *
   * Parses FFmpeg's device enumeration output to extract video devices.
   * Only returns video devices, not audio.
   *
   * @returns Array of detected webcam devices.
   */
  async listDevices(): Promise<WebcamDevice[]> {
    const devices: WebcamDevice[] = [];

    try {
      // On Windows, use DirectShow to list devices
      const proc = Bun.spawn(['ffmpeg', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // FFmpeg outputs device list to stderr
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      // Parse the output to extract device names
      // Format: [dshow @ ...] "Device Name" (video) or (audio)
      const lines = stderr.split('\n');

      for (const line of lines) {
        // Skip alternative name lines
        if (line.includes('Alternative name')) {
          continue;
        }

        // Parse device lines - they contain quoted device names followed by (video) or (audio)
        // Example: [dshow @ 000001...] "Integrated Webcam" (video)
        const match = line.match(/\[dshow @[^\]]+\]\s+"([^"]+)"\s+\((video|audio)\)/);
        if (match) {
          const deviceName = match[1];
          const deviceType = match[2] as 'video' | 'audio';

          // Only include video devices
          if (deviceType === 'video') {
            devices.push({
              id: deviceName, // Use name as ID for dshow
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
   * Starts MJPEG streaming from a webcam device.
   *
   * Spawns FFmpeg to capture from the device and output MJPEG to stdout.
   * Emits 'frame' events with base64-encoded JPEG data.
   *
   * @param deviceId - The device ID (name) to stream from.
   * @param resolution - Resolution string (e.g., '640x480', '1920x1080'). Defaults to '640x480'.
   * @param frameRate - Frame rate for streaming. Defaults to class frameRate (15).
   * @returns True if stream started successfully.
   */
  async startStream(deviceId: string, resolution: string = '640x480', frameRate?: number): Promise<boolean> {
    if (this.activeStreams.has(deviceId)) {
      console.log(`Stream already active for device: ${deviceId}`);
      return true;
    }

    const fps = frameRate ?? this.frameRate;

    try {
      log(`[WebcamManager] Starting webcam stream for: ${deviceId} at ${resolution} @ ${fps}fps`);

      // FFmpeg command to capture from webcam and output MJPEG to stdout
      // -video_size must come BEFORE -i to set the capture resolution from the camera
      const args = [
        '-f', 'dshow',
        '-video_size', resolution,
        '-framerate', String(fps),
        '-i', `video=${deviceId}`,
        '-f', 'mjpeg',
        '-q:v', String(this.quality),
        '-',
      ];

      log(`[WebcamManager] FFmpeg args: ffmpeg ${args.join(' ')}`);

      const proc = Bun.spawn(['ffmpeg', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      this.activeStreams.set(deviceId, { process: proc, deviceId, resolution, frameRate: fps });

      // Handle stderr for logging (FFmpeg outputs progress to stderr)
      this.handleStderr(deviceId, proc.stderr);

      // Handle stdout for frame data
      this.handleFrameStream(deviceId, proc.stdout);

      // Handle process exit
      proc.exited.then((code) => {
        log(`[WebcamManager] FFmpeg process exited for ${deviceId} with code ${code}`);
        log(`[WebcamManager] changingResolution set: ${JSON.stringify(Array.from(this.changingResolution))}`);
        log(`[WebcamManager] Is changing resolution: ${this.changingResolution.has(deviceId)}`);
        // Don't emit stream-stopped if we're just changing resolution
        if (this.changingResolution.has(deviceId)) {
          log(`[WebcamManager] Skipping stream-stopped emit for ${deviceId} (resolution change)`);
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
   * Changes the resolution and/or frame rate of an active stream.
   * Stops the current stream and restarts it with the new settings.
   *
   * @param deviceId - The device ID to change settings for.
   * @param resolution - New resolution string (e.g., '1920x1080').
   * @param frameRate - New frame rate. Optional.
   * @returns True if change was initiated successfully.
   */
  async setResolution(deviceId: string, resolution: string, frameRate?: number): Promise<boolean> {
    const stream = this.activeStreams.get(deviceId);
    if (!stream) {
      console.log(`No active stream for device: ${deviceId}`);
      return false;
    }

    const newFrameRate = frameRate ?? stream.frameRate;
    if (stream.resolution === resolution && stream.frameRate === newFrameRate) {
      console.log(`Stream already at ${resolution} @ ${newFrameRate}fps for device: ${deviceId}`);
      return true;
    }

    log(`[WebcamManager] Changing settings for ${deviceId} from ${stream.resolution}@${stream.frameRate}fps to ${resolution}@${newFrameRate}fps`);

    // Mark as changing resolution so we don't emit stream-stopped
    this.changingResolution.add(deviceId);
    log(`[WebcamManager] Added ${deviceId} to changingResolution: ${JSON.stringify(Array.from(this.changingResolution))}`);

    // Stop current stream and wait for it to exit
    try {
      log(`[WebcamManager] Killing FFmpeg process for ${deviceId}`);
      const oldProcess = stream.process;
      stream.process.kill();
      this.activeStreams.delete(deviceId);

      // Wait for the old process to actually exit before starting new one
      log(`[WebcamManager] Waiting for old process to exit`);
      await oldProcess.exited;
      log(`[WebcamManager] Old process exited, starting new stream`);
    } catch (error) {
      this.changingResolution.delete(deviceId);
      console.error(`Error stopping stream for resolution change: ${error}`);
      return false;
    }

    // Start new stream with new settings (keep changingResolution flag until stream starts)
    log(`[WebcamManager] Starting new stream at ${resolution}@${newFrameRate}fps`);
    const result = await this.startStream(deviceId, resolution, newFrameRate);

    // Now safe to clear the flag after new stream has started
    this.changingResolution.delete(deviceId);
    log(`[WebcamManager] Removed ${deviceId} from changingResolution, result: ${result}`);
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
   * Parses MJPEG frame stream from FFmpeg stdout.
   *
   * MJPEG frames are delimited by SOI (0xFFD8) and EOI (0xFFD9) markers.
   * Extracts complete frames and emits them as base64-encoded JPEG.
   *
   * @param deviceId - The device this stream is for.
   * @param stdout - The stdout ReadableStream from FFmpeg.
   */
  private async handleFrameStream(deviceId: string, stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    let buffer = new Uint8Array(0);

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

          // Convert to base64 and emit
          const base64 = btoa(String.fromCharCode(...frame));
          this.emit('frame', { deviceId, data: base64 });
        }
      }
    } catch (error) {
      // Stream closed or error
      console.error(`Frame stream error for ${deviceId}:`, error);
    }
  }
}

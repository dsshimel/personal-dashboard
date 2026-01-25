/**
 * @fileoverview Webcam streaming manager using FFmpeg.
 *
 * Provides webcam device enumeration and MJPEG streaming via FFmpeg.
 * Designed for Windows DirectShow devices, streams frames as base64 JPEG.
 */

import { EventEmitter } from 'events';

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
   * @returns True if stream started successfully.
   */
  async startStream(deviceId: string, resolution: string = '640x480'): Promise<boolean> {
    if (this.activeStreams.has(deviceId)) {
      console.log(`Stream already active for device: ${deviceId}`);
      return true;
    }

    try {
      console.log(`Starting webcam stream for: ${deviceId} at ${resolution}`);

      // FFmpeg command to capture from webcam and output MJPEG to stdout
      const args = [
        '-f', 'dshow',
        '-i', `video=${deviceId}`,
        '-f', 'mjpeg',
        '-q:v', String(this.quality),
        '-r', String(this.frameRate),
        '-s', resolution,
        '-',
      ];

      const proc = Bun.spawn(['ffmpeg', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      this.activeStreams.set(deviceId, { process: proc, deviceId, resolution });

      // Handle stderr for logging (FFmpeg outputs progress to stderr)
      this.handleStderr(deviceId, proc.stderr);

      // Handle stdout for frame data
      this.handleFrameStream(deviceId, proc.stdout);

      // Handle process exit
      proc.exited.then((code) => {
        console.log(`FFmpeg process exited for ${deviceId} with code ${code}`);
        // Don't emit stream-stopped if we're just changing resolution
        if (this.changingResolution.has(deviceId)) {
          return;
        }
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
   * Changes the resolution of an active stream.
   * Stops the current stream and restarts it with the new resolution.
   *
   * @param deviceId - The device ID to change resolution for.
   * @param resolution - New resolution string (e.g., '1920x1080').
   * @returns True if resolution change was initiated successfully.
   */
  async setResolution(deviceId: string, resolution: string): Promise<boolean> {
    const stream = this.activeStreams.get(deviceId);
    if (!stream) {
      console.log(`No active stream for device: ${deviceId}`);
      return false;
    }

    if (stream.resolution === resolution) {
      console.log(`Stream already at ${resolution} for device: ${deviceId}`);
      return true;
    }

    console.log(`Changing resolution for ${deviceId} from ${stream.resolution} to ${resolution}`);

    // Mark as changing resolution so we don't emit stream-stopped
    this.changingResolution.add(deviceId);

    // Stop current stream without emitting stop event (we'll emit started with new resolution)
    try {
      stream.process.kill();
      this.activeStreams.delete(deviceId);
    } catch (error) {
      this.changingResolution.delete(deviceId);
      console.error(`Error stopping stream for resolution change: ${error}`);
      return false;
    }

    // Start new stream with new resolution
    const result = await this.startStream(deviceId, resolution);
    this.changingResolution.delete(deviceId);
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
        // Only log errors, not progress
        if (text.includes('Error') || text.includes('error') || text.includes('Invalid')) {
          console.error(`[FFmpeg ${deviceId}] ${text}`);
          this.emit('error', { deviceId, type: 'ffmpeg-error', error: text });
        }
      }
    } catch {
      // Stream closed, ignore
    }
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

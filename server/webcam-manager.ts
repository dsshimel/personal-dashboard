import { EventEmitter } from 'events';

export interface WebcamDevice {
  id: string;
  name: string;
  type: 'video' | 'audio';
}

interface FFmpegProcess {
  process: ReturnType<typeof Bun.spawn>;
  deviceId: string;
}

export class WebcamManager extends EventEmitter {
  private activeStreams: Map<string, FFmpegProcess> = new Map();
  private frameRate: number;
  private quality: number;

  constructor(frameRate = 15, quality = 5) {
    super();
    this.frameRate = frameRate;
    this.quality = quality; // JPEG quality (2-31, lower is better)
  }

  /**
   * List available webcam devices using FFmpeg
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
   * Start streaming from a webcam device
   */
  async startStream(deviceId: string): Promise<boolean> {
    if (this.activeStreams.has(deviceId)) {
      console.log(`Stream already active for device: ${deviceId}`);
      return true;
    }

    try {
      console.log(`Starting webcam stream for: ${deviceId}`);

      // FFmpeg command to capture from webcam and output MJPEG to stdout
      const args = [
        '-f', 'dshow',
        '-i', `video=${deviceId}`,
        '-f', 'mjpeg',
        '-q:v', String(this.quality),
        '-r', String(this.frameRate),
        '-s', '640x480', // Resolution
        '-',
      ];

      const proc = Bun.spawn(['ffmpeg', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      this.activeStreams.set(deviceId, { process: proc, deviceId });

      // Handle stderr for logging (FFmpeg outputs progress to stderr)
      this.handleStderr(deviceId, proc.stderr);

      // Handle stdout for frame data
      this.handleFrameStream(deviceId, proc.stdout);

      // Handle process exit
      proc.exited.then((code) => {
        console.log(`FFmpeg process exited for ${deviceId} with code ${code}`);
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
   * Stop streaming from a webcam device
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

  /**
   * Stop all active streams
   */
  stopAllStreams(): void {
    for (const [deviceId] of this.activeStreams) {
      this.stopStream(deviceId);
    }
  }

  /**
   * Check if a device is currently streaming
   */
  isStreaming(deviceId: string): boolean {
    return this.activeStreams.has(deviceId);
  }

  /**
   * Get list of currently streaming device IDs
   */
  getActiveStreams(): string[] {
    return Array.from(this.activeStreams.keys());
  }

  /**
   * Handle FFmpeg stderr output (progress/errors)
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
    } catch (error) {
      // Stream closed, ignore
    }
  }

  /**
   * Handle MJPEG frame stream from FFmpeg stdout
   * MJPEG frames start with 0xFFD8 (SOI) and end with 0xFFD9 (EOI)
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

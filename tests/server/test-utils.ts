/**
 * @fileoverview Test utilities for server tests.
 *
 * Provides mock implementations of WebSocket, Bun.spawn, and file system
 * operations for testing without external dependencies.
 */

import { EventEmitter } from 'events';

/**
 * Mock WebSocket implementation for testing.
 */
export class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];

  send(data: string): void {
    if (this.readyState === MockWebSocket.OPEN) {
      this.sentMessages.push(data);
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  /** Simulates receiving a message from the client. */
  simulateMessage(data: string | object): void {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    this.emit('message', Buffer.from(str));
  }

  /** Simulates a WebSocket error. */
  simulateError(error: Error): void {
    this.emit('error', error);
  }

  /** Gets parsed JSON messages that were sent. */
  getJsonMessages(): unknown[] {
    return this.sentMessages.map(m => JSON.parse(m));
  }

  /** Clears sent messages. */
  clearMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * Creates a mock readable stream that emits data and then closes.
 */
export function createMockReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index++;
      } else {
        controller.close();
      }
    }
  });
}

/**
 * Creates a mock Bun.spawn result for testing.
 */
export interface MockSpawnResult {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { end: () => void };
  exited: Promise<number>;
  kill: () => void;
}

export function createMockSpawnResult(options: {
  stdoutChunks?: Uint8Array[];
  stderrChunks?: Uint8Array[];
  exitCode?: number;
  pid?: number;
}): MockSpawnResult {
  const {
    stdoutChunks = [],
    stderrChunks = [],
    exitCode = 0,
    pid = 12345
  } = options;

  let killed = false;
  let resolveExited: (code: number) => void;
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  // Auto-resolve after streams are consumed
  setTimeout(() => {
    if (!killed) {
      resolveExited(exitCode);
    }
  }, 10);

  return {
    pid,
    stdout: createMockReadableStream(stdoutChunks),
    stderr: createMockReadableStream(stderrChunks),
    stdin: { end: () => {} },
    exited: exitedPromise,
    kill: () => {
      killed = true;
      resolveExited(143); // SIGTERM
    }
  };
}

/**
 * Helper to encode a string as Uint8Array.
 */
export function encodeString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Creates a valid JPEG frame with SOI and EOI markers for testing.
 * Optionally includes SOF0 marker with dimensions.
 */
export function createMockJpegFrame(options?: { width?: number; height?: number }): Uint8Array {
  const { width = 640, height = 480 } = options || {};

  // SOI marker
  const soi = [0xFF, 0xD8];

  // SOF0 marker with dimensions (simplified)
  // FF C0 00 0B 08 HH HH WW WW 01 00 00 00
  const sof0 = [
    0xFF, 0xC0, // SOF0 marker
    0x00, 0x0B, // Length
    0x08,       // Precision (8 bits)
    (height >> 8) & 0xFF, height & 0xFF, // Height
    (width >> 8) & 0xFF, width & 0xFF,   // Width
    0x01,       // Number of components
    0x00, 0x00, 0x00 // Component data
  ];

  // Some dummy data
  const data = [0x00, 0x00, 0x00, 0x00];

  // EOI marker
  const eoi = [0xFF, 0xD9];

  return new Uint8Array([...soi, ...sof0, ...data, ...eoi]);
}

/**
 * Creates a test session message in JSONL format.
 */
export function createSessionMessage(type: 'user' | 'assistant', content: string, timestamp?: string): string {
  const ts = timestamp || new Date().toISOString();

  if (type === 'user') {
    return JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'text', text: content }]
      },
      timestamp: ts
    });
  }

  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: content }]
    },
    timestamp: ts
  });
}

/**
 * Waits for a condition to be true with timeout.
 */
export async function waitFor(
  condition: () => boolean,
  timeout = 1000,
  interval = 10
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timeout');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/**
 * Captures events emitted by an EventEmitter.
 */
export function captureEvents<T>(
  emitter: EventEmitter,
  eventName: string
): { events: T[]; cleanup: () => void } {
  const events: T[] = [];
  const handler = (data: T) => events.push(data);
  emitter.on(eventName, handler);

  return {
    events,
    cleanup: () => emitter.off(eventName, handler)
  };
}

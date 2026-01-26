/**
 * @fileoverview Buffered file logger with per-session log files.
 *
 * Creates a `_logs/` directory and writes a new timestamped log file each time
 * a server process starts. Manages directory size by deleting the oldest session
 * files first, then trimming the current session file if still over budget.
 */

import { stat, readFile, writeFile, readdir, unlink } from 'fs/promises';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), '_logs');
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER_SIZE = 100;
const MAX_DIR_BYTES = 20 * 1024 * 1024;  // 20 MB total for _logs/
const MAX_FILE_BYTES = 5 * 1024 * 1024;  // 5 MB per session file

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let serverLabel = 'server';
let logFilePath: string | null = null;
let dirEnsured = false;

/**
 * Sets the server label used in the log filename.
 * Call once at startup before any logging occurs.
 */
export function initLogger(label: string): void {
  serverLabel = label;
}

/** Ensures the _logs/ directory exists and determines the session log file path. */
function ensureLogFile(): string {
  if (logFilePath) return logFilePath;

  if (!dirEnsured) {
    mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  logFilePath = join(LOG_DIR, `${timestamp}_${serverLabel}.log`);
  return logFilePath;
}

/** Formats a log line with timestamp and level. */
function formatLine(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;
}

/** Flushes the in-memory buffer to disk, then trims if needed. */
async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const lines = buffer.join('');
  buffer = [];
  try {
    const filePath = ensureLogFile();
    await writeFile(filePath, lines, { flag: 'a' });
    await trimIfNeeded();
  } catch {
    // Ignore write errors — logging should never crash the server
  }
}

let trimming = false;

/**
 * Two-tier size management:
 * 1. If _logs/ directory exceeds MAX_DIR_BYTES, delete oldest session files (never the current one).
 * 2. If the current session file exceeds MAX_FILE_BYTES, discard its oldest half.
 */
async function trimIfNeeded(): Promise<void> {
  if (trimming) return;
  trimming = true;

  try {
    const currentFile = ensureLogFile();
    const entries = await readdir(LOG_DIR);

    // Gather file info and total size
    const fileInfos: Array<{ name: string; path: string; size: number }> = [];
    let totalSize = 0;

    for (const name of entries) {
      const fullPath = join(LOG_DIR, name);
      try {
        const info = await stat(fullPath);
        if (info.isFile()) {
          fileInfos.push({ name, path: fullPath, size: info.size });
          totalSize += info.size;
        }
      } catch {
        // File may have disappeared
      }
    }

    // Tier 1: Delete oldest session files until under directory budget
    if (totalSize > MAX_DIR_BYTES) {
      // Sort by name ascending — filenames start with ISO timestamps so this is chronological
      fileInfos.sort((a, b) => a.name.localeCompare(b.name));

      for (const fileInfo of fileInfos) {
        if (totalSize <= MAX_DIR_BYTES) break;
        if (fileInfo.path === currentFile) continue;
        try {
          await unlink(fileInfo.path);
          totalSize -= fileInfo.size;
        } catch {
          // May have been deleted by the other server process
        }
      }
    }

    // Tier 2: If current session file is still too large, trim its oldest half
    try {
      const currentInfo = await stat(currentFile);
      if (currentInfo.size > MAX_FILE_BYTES) {
        const content = await readFile(currentFile, 'utf-8');
        const midpoint = Math.floor(content.length / 2);
        const cutIndex = content.indexOf('\n', midpoint);
        const trimmed = cutIndex === -1 ? '' : content.slice(cutIndex + 1);
        await writeFile(currentFile, trimmed);
      }
    } catch {
      // Non-critical
    }
  } catch {
    // Ignore all trim errors
  } finally {
    trimming = false;
  }
}

/** Synchronous flush for process exit handlers where async isn't possible. */
function flushSync(): void {
  if (buffer.length === 0) return;
  const lines = buffer.join('');
  buffer = [];
  try {
    const filePath = ensureLogFile();
    appendFileSync(filePath, lines);
  } catch {
    // Ignore
  }
}

/** Starts the periodic flush timer. Called automatically on first log. */
function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flush(); }, FLUSH_INTERVAL_MS);
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }

  process.on('exit', flushSync);
  process.on('SIGINT', () => { flushSync(); process.exit(0); });
  process.on('SIGTERM', () => { flushSync(); process.exit(0); });
}

/**
 * Appends a log line to the buffer. Triggers a flush if the buffer is full.
 *
 * @param level - Log severity (info, warn, error).
 * @param message - The log message.
 */
export function logToFile(level: string, message: string): void {
  ensureTimer();
  buffer.push(formatLine(level, message));
  if (buffer.length >= MAX_BUFFER_SIZE) {
    flush();
  }
}

/**
 * @fileoverview Restart watcher process for graceful server restarts.
 *
 * Runs as a separate supervisor process that monitors for a restart signal file.
 * When the signal is detected, it gracefully stops the app, kills processes
 * on the required ports, and restarts everything.
 *
 * Usage: bun run server/restart-watcher.ts
 */

import { spawn, execSync } from 'child_process';
import { watch, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const WORKING_DIR = process.cwd();
/** Path to the signal file that triggers a restart. */
const SIGNAL_FILE = join(WORKING_DIR, '.restart-signal');
const isWindows = process.platform === 'win32';

/** The currently running app process. */
let appProcess: ReturnType<typeof spawn> | null = null;

/** Heartbeat check interval handle. */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/** Heartbeat configuration. */
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 3_000;
const HEARTBEAT_GRACE_PERIOD_MS = 45_000;

/** Endpoints to check for heartbeats. */
const HEARTBEAT_ENDPOINTS = [
  { name: 'Express', url: 'http://localhost:4001/heartbeat' },
  { name: 'Vite', url: 'http://localhost:6969/' },
];

/** Whether a restart is currently in progress. */
let restartInProgress = false;

/**
 * Checks a single heartbeat endpoint.
 * Returns true if healthy, false if unhealthy.
 */
async function checkHeartbeat(endpoint: { name: string; url: string }): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    const response = await fetch(endpoint.url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Checks all heartbeat endpoints and triggers a restart if any are unhealthy.
 */
async function checkAllHeartbeats() {
  if (restartInProgress || !appProcess) return;

  const results = await Promise.all(
    HEARTBEAT_ENDPOINTS.map(async (ep) => ({
      ...ep,
      healthy: await checkHeartbeat(ep),
    }))
  );

  const failed = results.filter((r) => !r.healthy);
  if (failed.length > 0) {
    console.log(`[Watcher] Heartbeat failed for: ${failed.map((f) => f.name).join(', ')}`);
    stopHeartbeatMonitor();
    restart();
  }
}

/** Starts the heartbeat monitor after a grace period. */
function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  console.log(`[Watcher] Heartbeat monitor will start after ${HEARTBEAT_GRACE_PERIOD_MS / 1000}s grace period`);
  setTimeout(() => {
    console.log(`[Watcher] Heartbeat monitor active (checking every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
    heartbeatInterval = setInterval(checkAllHeartbeats, HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_GRACE_PERIOD_MS);
}

/** Stops the heartbeat monitor. */
function stopHeartbeatMonitor() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Kills any processes listening on the app's ports.
 * Uses platform-specific commands (taskkill on Windows, fuser on Linux).
 */
function killProcessesOnPorts() {
  const ports = [4001, 4002, 6969];
  console.log(`[Watcher] Killing processes on ports ${ports.join(', ')}...`);

  if (isWindows) {
    for (const port of ports) {
      try {
        execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, {
          shell: 'cmd.exe',
          stdio: 'ignore'
        });
      } catch { /* ignore */ }
    }
  } else {
    for (const port of ports) {
      try {
        execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  }
}

/** Starts the app by running `bun run prod:all`. */
function startApp() {
  console.log('[Watcher] Starting app with bun run prod:all...');
  restartInProgress = false;

  appProcess = spawn('bun', ['run', 'prod:all'], {
    cwd: WORKING_DIR,
    stdio: 'inherit',
    shell: true
  });

  appProcess.on('exit', (code) => {
    console.log(`[Watcher] App process exited with code ${code}`);
    appProcess = null;
    stopHeartbeatMonitor();
  });

  startHeartbeatMonitor();
}

/** Handles restart by stopping current app, killing ports, and restarting. */
function restart() {
  console.log('[Watcher] Restart triggered!');
  restartInProgress = true;
  stopHeartbeatMonitor();

  // Kill the current app process tree
  if (appProcess) {
    console.log('[Watcher] Stopping current app...');
    if (isWindows) {
      try {
        execSync(`taskkill /F /T /PID ${appProcess.pid}`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    } else {
      appProcess.kill('SIGKILL');
    }
    appProcess = null;
  }

  // Kill any remaining processes on our ports
  killProcessesOnPorts();

  // Wait for processes to fully exit, then kill ports again to catch
  // any late-starting processes (e.g. Express starting after its build step)
  setTimeout(() => {
    killProcessesOnPorts();
    setTimeout(() => {
      startApp();
    }, 1500);
  }, 3000);
}

// Clean up signal file if it exists
if (existsSync(SIGNAL_FILE)) {
  unlinkSync(SIGNAL_FILE);
}

// Watch for the signal file
console.log('[Watcher] Starting restart watcher...');
console.log(`[Watcher] Watching for signal file: ${SIGNAL_FILE}`);

// Create a directory watcher
const watcher = watch(WORKING_DIR, (_eventType, filename) => {
  if (filename === '.restart-signal' && existsSync(SIGNAL_FILE)) {
    // Remove the signal file
    try {
      unlinkSync(SIGNAL_FILE);
    } catch { /* ignore */ }

    restart();
  }
});

// Kill any existing processes on our ports before starting
killProcessesOnPorts();

// Wait a moment for ports to be released, then start the app
setTimeout(() => {
  startApp();
}, 1500);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('[Watcher] Shutting down...');
  stopHeartbeatMonitor();
  watcher.close();
  if (appProcess) {
    if (isWindows) {
      try {
        execSync(`taskkill /F /T /PID ${appProcess.pid}`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    } else {
      appProcess.kill('SIGTERM');
    }
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Watcher] Shutting down...');
  stopHeartbeatMonitor();
  watcher.close();
  if (appProcess) {
    if (isWindows) {
      try {
        execSync(`taskkill /F /T /PID ${appProcess.pid}`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    } else {
      appProcess.kill('SIGTERM');
    }
  }
  process.exit(0);
});

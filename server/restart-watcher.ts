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
import { createServer as createNetServer } from 'net';
import { join } from 'path';

const WORKING_DIR = process.cwd();
/** Path to the signal file that triggers a restart. */
const SIGNAL_FILE = join(WORKING_DIR, '.restart-signal');
const isWindows = process.platform === 'win32';
const APP_PORTS = [4001, 4002, 6969];

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
 * Gets PIDs of processes listening on a port.
 * Returns empty array if no listeners found.
 */
function getListeningPids(port: number): number[] {
  if (isWindows) {
    try {
      const output = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
        { shell: 'cmd.exe', encoding: 'utf-8', timeout: 10_000 }
      ).trim();
      if (output) {
        return [...new Set(output.split(/\r?\n/).map(s => parseInt(s.trim())).filter(n => !isNaN(n)))];
      }
    } catch { /* ignore */ }
  } else {
    try {
      const output = execSync(
        `fuser ${port}/tcp 2>/dev/null || true`,
        { encoding: 'utf-8' }
      ).trim();
      if (output) {
        return [...new Set(output.split(/\s+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n)))];
      }
    } catch { /* ignore */ }
  }
  return [];
}

/**
 * Checks if a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills any processes listening on the app's ports.
 * Returns true if all blocking processes are ghost sockets (dead process, port still held).
 */
function killProcessesOnPorts(): boolean {
  console.log(`[Watcher] Killing processes on ports ${APP_PORTS.join(', ')}...`);
  let allGhosts = true;

  for (const port of APP_PORTS) {
    const pids = getListeningPids(port);
    if (pids.length === 0) continue;

    for (const pid of pids) {
      if (!isProcessAlive(pid)) {
        console.log(`[Watcher] Port ${port}: PID ${pid} is dead (ghost socket, OS will reclaim)`);
        continue;
      }
      allGhosts = false;
      console.log(`[Watcher] Port ${port}: killing PID ${pid}`);
      if (isWindows) {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { shell: 'cmd.exe', stdio: 'ignore' });
        } catch { /* ignore */ }
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
      }
    }
  }

  return allGhosts;
}

/**
 * Checks if a port is available for binding.
 * Cross-platform — works on both Windows and Linux.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Waits until all specified ports are free, retrying kills if needed.
 * If ports are blocked by ghost sockets (dead processes), proceeds after
 * a short wait since the Express server has its own listen-retry logic.
 */
async function waitForPortsFree(ports: number[], maxWaitMs: number = 15_000): Promise<boolean> {
  const start = Date.now();
  let retryKills = 0;
  let ghostDetected = false;

  while (Date.now() - start < maxWaitMs) {
    const results = await Promise.all(ports.map(isPortFree));
    if (results.every(Boolean)) return true;

    const busyPorts = ports.filter((_, i) => !results[i]);

    // Check if all blocking processes are ghosts (dead but port still held by OS)
    if (!ghostDetected) {
      const allGhosts = busyPorts.every(port => {
        const pids = getListeningPids(port);
        return pids.length === 0 || pids.every(pid => !isProcessAlive(pid));
      });
      if (allGhosts && busyPorts.length > 0) {
        ghostDetected = true;
        console.log(`[Watcher] Ghost sockets detected on ports ${busyPorts.join(', ')} (dead process, OS hasn't reclaimed).`);
        console.log(`[Watcher] Proceeding — server will retry listen() until port is available.`);
        return false;
      }
    }

    console.log(`[Watcher] Waiting for ports to be free: ${busyPorts.join(', ')}`);

    // Retry killing every 3 seconds, up to 3 times
    if (retryKills < 3 && Date.now() - start >= (retryKills + 1) * 3000) {
      retryKills++;
      console.log(`[Watcher] Retry kill attempt ${retryKills}...`);
      killProcessesOnPorts();
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const finalResults = await Promise.all(ports.map(isPortFree));
  const stillBusy = ports.filter((_, i) => !finalResults[i]);
  if (stillBusy.length > 0) {
    console.warn(`[Watcher] WARNING: Ports still in use after ${maxWaitMs}ms: ${stillBusy.join(', ')}`);
  }
  return stillBusy.length === 0;
}

/** Starts the app by running `bun run prod:all`. */
function startApp() {
  console.log('[Watcher] Starting app with bun run prod:all...');
  restartInProgress = false;

  appProcess = spawn('bun', ['run', 'prod:all'], {
    cwd: WORKING_DIR,
    stdio: 'inherit',
    shell: true,
    detached: true,
    windowsHide: true,
  });

  appProcess.on('exit', (code) => {
    console.log(`[Watcher] App process exited with code ${code}`);
    appProcess = null;
    stopHeartbeatMonitor();
  });

  startHeartbeatMonitor();
}

/**
 * Kills the entire process group of the app process.
 * Using negative PID sends the signal to all processes in the group,
 * which includes children spawned by concurrently via shell: true.
 */
async function killAppProcessTree(): Promise<void> {
  if (!appProcess || !appProcess.pid) return;

  const pid = appProcess.pid;
  console.log(`[Watcher] Killing process group for PID ${pid}...`);

  if (isWindows) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  } else {
    // Send SIGTERM to the entire process group first for graceful shutdown
    try {
      process.kill(-pid, 'SIGTERM');
    } catch { /* ignore - group may not exist */ }

    // Wait briefly for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Force kill the process group if still alive
    try {
      process.kill(-pid, 'SIGKILL');
    } catch { /* ignore - already dead */ }
  }

  // Wait for the process to actually exit
  if (appProcess) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => resolve(), 5000);
      appProcess!.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  appProcess = null;
}

/** Handles restart by stopping current app, killing ports, and restarting. */
async function restart() {
  console.log('[Watcher] Restart triggered!');
  restartInProgress = true;
  stopHeartbeatMonitor();

  // Kill the current app process tree (entire process group)
  await killAppProcessTree();

  // Kill any remaining processes on our ports and wait until they're actually free
  killProcessesOnPorts();
  await waitForPortsFree(APP_PORTS);

  startApp();
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
  if (filename === '.restart-signal' && existsSync(SIGNAL_FILE) && !restartInProgress) {
    // Remove the signal file
    try {
      unlinkSync(SIGNAL_FILE);
    } catch { /* ignore */ }

    restart();
  }
});

// Kill any existing processes on our ports and wait until they're free
killProcessesOnPorts();
waitForPortsFree(APP_PORTS).then(() => {
  startApp();
});

/** Kills the app process group during shutdown. */
function killAppForShutdown() {
  if (!appProcess?.pid) return;
  if (isWindows) {
    try {
      execSync(`taskkill /F /T /PID ${appProcess.pid}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  } else {
    try { process.kill(-appProcess.pid, 'SIGTERM'); } catch { /* ignore */ }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('[Watcher] Shutting down...');
  stopHeartbeatMonitor();
  watcher.close();
  killAppForShutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Watcher] Shutting down...');
  stopHeartbeatMonitor();
  watcher.close();
  killAppForShutdown();
  process.exit(0);
});

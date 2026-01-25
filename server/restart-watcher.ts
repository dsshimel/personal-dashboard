/**
 * Restart Watcher Process
 *
 * This runs as a separate process that watches for a restart signal file.
 * When the signal is detected, it kills the main app and restarts it.
 *
 * Usage: bun run server/restart-watcher.ts
 */

import { spawn, execSync } from 'child_process';
import { watch, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const WORKING_DIR = process.cwd();
const SIGNAL_FILE = join(WORKING_DIR, '.restart-signal');
const isWindows = process.platform === 'win32';

let appProcess: ReturnType<typeof spawn> | null = null;

function killProcessesOnPorts() {
  const ports = [3001, 3002, 5173];
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

function startApp() {
  console.log('[Watcher] Starting app with bun run prod:all...');

  appProcess = spawn('bun', ['run', 'prod:all'], {
    cwd: WORKING_DIR,
    stdio: 'inherit',
    shell: true
  });

  appProcess.on('exit', (code) => {
    console.log(`[Watcher] App process exited with code ${code}`);
    appProcess = null;
  });
}

function restart() {
  console.log('[Watcher] Restart signal received!');

  // Kill the current app process tree
  if (appProcess) {
    console.log('[Watcher] Stopping current app...');
    if (isWindows) {
      try {
        execSync(`taskkill /F /T /PID ${appProcess.pid}`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    } else {
      appProcess.kill('SIGTERM');
    }
    appProcess = null;
  }

  // Kill any remaining processes on our ports
  killProcessesOnPorts();

  // Wait a moment for ports to be released
  setTimeout(() => {
    startApp();
  }, 1500);
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

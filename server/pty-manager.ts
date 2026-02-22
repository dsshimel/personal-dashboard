/**
 * @fileoverview PTY manager for interactive shell terminals.
 *
 * Uses Bun's native terminal API to spawn shell processes with proper
 * pseudo-terminal allocation. Supports resize and raw terminal I/O
 * for xterm.js on the client side. POSIX only (Linux/macOS).
 */

import { EventEmitter } from 'events';
import type { Subprocess } from 'bun';

export class PtyManager extends EventEmitter {
  private proc: Subprocess | null = null;
  private cols: number;
  private rows: number;
  private cwd: string;

  constructor(cwd: string, cols = 80, rows = 24) {
    super();
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
  }

  /** Spawns a shell process with a PTY attached. */
  spawn(shell?: string): void {
    if (this.proc) {
      throw new Error('PTY already spawned');
    }

    const shellCmd = shell || process.env.SHELL || '/bin/bash';

    // Only pass through safe environment variables — exclude secrets and server config
    const SAFE_ENV_KEYS = [
      'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE',
      'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO',
      'COLORTERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
    ];
    const safeEnv: Record<string, string> = { TERM: 'xterm-256color' };
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) safeEnv[key] = process.env[key]!;
    }

    this.proc = Bun.spawn([shellCmd], {
      cwd: this.cwd,
      env: safeEnv,
      terminal: {
        cols: this.cols,
        rows: this.rows,
        data: (_terminal: unknown, data: Uint8Array) => {
          this.emit('data', new TextDecoder().decode(data));
        },
        exit: () => {
          this.proc = null;
          this.emit('exit');
        },
      },
    });
  }

  /** Writes data (keystrokes) to the PTY. */
  write(data: string): void {
    if (!this.proc?.terminal) return;
    this.proc.terminal.write(data);
  }

  /** Resizes the PTY. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (!this.proc?.terminal) return;
    this.proc.terminal.resize(cols, rows);
  }

  /** Kills the shell process. */
  kill(): void {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }

  /** Returns whether a shell process is currently running. */
  isAlive(): boolean {
    return this.proc !== null;
  }
}

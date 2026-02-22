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

    this.proc = Bun.spawn([shellCmd], {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
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

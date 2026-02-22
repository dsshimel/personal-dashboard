/**
 * @fileoverview Tests for PtyManager.
 *
 * Tests the PTY manager's lifecycle, I/O, and resize functionality.
 * Requires a POSIX system (Linux/macOS) since Bun's terminal API
 * is not available on Windows.
 */

import { describe, test, expect } from 'bun:test';
import { PtyManager } from '../../server/pty-manager';
import { tmpdir } from 'os';

describe('PtyManager', () => {
  test('spawns a shell and receives output', async () => {
    const pty = new PtyManager(tmpdir());
    const chunks: string[] = [];

    pty.on('data', (data: string) => {
      chunks.push(data);
    });

    pty.spawn('/bin/sh');
    expect(pty.isAlive()).toBe(true);

    // Send a command and wait for output
    pty.write('echo hello_pty_test\n');

    // Wait for output to arrive
    await new Promise(resolve => setTimeout(resolve, 500));

    const output = chunks.join('');
    expect(output).toContain('hello_pty_test');

    pty.kill();
    expect(pty.isAlive()).toBe(false);
  });

  test('emits exit event when shell exits', async () => {
    const pty = new PtyManager(tmpdir());
    let exited = false;

    pty.on('exit', () => {
      exited = true;
    });

    pty.spawn('/bin/sh');
    pty.write('exit\n');

    await new Promise(resolve => setTimeout(resolve, 500));
    expect(exited).toBe(true);
    expect(pty.isAlive()).toBe(false);
  });

  test('throws if spawned twice', () => {
    const pty = new PtyManager(tmpdir());
    pty.spawn('/bin/sh');

    expect(() => pty.spawn('/bin/sh')).toThrow('PTY already spawned');

    pty.kill();
  });

  test('resize does not throw', () => {
    const pty = new PtyManager(tmpdir(), 80, 24);
    pty.spawn('/bin/sh');

    expect(() => pty.resize(120, 40)).not.toThrow();

    pty.kill();
  });

  test('write to killed PTY does not throw', () => {
    const pty = new PtyManager(tmpdir());
    pty.spawn('/bin/sh');
    pty.kill();

    expect(() => pty.write('test')).not.toThrow();
  });

  test('kill without spawn does not throw', () => {
    const pty = new PtyManager(tmpdir());
    expect(() => pty.kill()).not.toThrow();
  });
});

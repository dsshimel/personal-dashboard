/**
 * @fileoverview Unit tests for ClaudeCodeManager.
 *
 * Tests the manager's session handling, argument building, JSON line parsing,
 * and process lifecycle management.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ClaudeCodeManager } from './claude-code';

describe('ClaudeCodeManager', () => {
  let manager: ClaudeCodeManager;

  beforeEach(() => {
    manager = new ClaudeCodeManager('/test/directory');
  });

  test('initializes with null session ID', () => {
    expect(manager.getSessionId()).toBeNull();
  });

  test('isRunning returns false initially', () => {
    expect(manager.isRunning()).toBe(false);
  });

  test('builds args without session ID on first command', () => {
    // Access private method via type assertion for testing
    const buildArgs = (manager as unknown as { buildArgs: (msg: string) => string[] }).buildArgs.bind(manager);
    const args = buildArgs('hello world');

    expect(args).toEqual([
      '-p', 'hello world',
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch'
    ]);
  });

  test('builds args with session ID for subsequent commands', () => {
    // Simulate having a session ID
    (manager as unknown as { sessionId: string }).sessionId = 'test-session-123';

    const buildArgs = (manager as unknown as { buildArgs: (msg: string) => string[] }).buildArgs.bind(manager);
    const args = buildArgs('follow up');

    expect(args).toEqual([
      '--resume', 'test-session-123',
      '-p', 'follow up',
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch'
    ]);
  });

  test('handleJsonLine parses init message and extracts session ID', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedSessionId: string | null = null;
    manager.on('sessionId', (id) => {
      capturedSessionId = id;
    });

    const initMessage = JSON.stringify({
      type: 'init',
      session_id: 'abc-123-def'
    });

    handleJsonLine(initMessage);

    expect(capturedSessionId).toBe('abc-123-def');
    expect(manager.getSessionId()).toBe('abc-123-def');
  });

  test('handleJsonLine parses assistant message with text content', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedOutput: { type: string; content: string } | null = null;
    manager.on('output', (data) => {
      if (data.type === 'output') {
        capturedOutput = data;
      }
    });

    const assistantMessage = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello! How can I help you?' }
        ]
      }
    });

    handleJsonLine(assistantMessage);

    expect(capturedOutput).toEqual({
      type: 'output',
      content: 'Hello! How can I help you?'
    });
  });

  test('handleJsonLine parses result message without emitting output', () => {
    // Result messages are logged but don't emit output (to avoid duplication with assistant messages)
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedOutput: { type: string; content: string } | null = null;
    manager.on('output', (data) => {
      if (data.type === 'output') {
        capturedOutput = data;
      }
    });

    const resultMessage = JSON.stringify({
      type: 'result',
      result: 'Task completed successfully',
      total_cost_usd: 0.001
    });

    handleJsonLine(resultMessage);

    // Result messages are intentionally not emitted as output to avoid duplication
    expect(capturedOutput).toBeNull();
  });

  test('handleJsonLine parses error message', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedOutput: { type: string; content: string } | null = null;
    manager.on('output', (data) => {
      if (data.type === 'error') {
        capturedOutput = data;
      }
    });

    const errorMessage = JSON.stringify({
      type: 'error',
      content: 'Something went wrong'
    });

    handleJsonLine(errorMessage);

    expect(capturedOutput).toEqual({
      type: 'error',
      content: 'Something went wrong'
    });
  });

  test('handleJsonLine handles non-JSON lines gracefully', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedOutput: { type: string; content: string } | null = null;
    manager.on('output', (data) => {
      capturedOutput = data;
    });

    handleJsonLine('This is not JSON');

    expect(capturedOutput).toEqual({
      type: 'output',
      content: 'This is not JSON'
    });
  });

  test('reset clears session ID', () => {
    (manager as unknown as { sessionId: string }).sessionId = 'test-session';
    expect(manager.getSessionId()).toBe('test-session');

    manager.reset();

    expect(manager.getSessionId()).toBeNull();
  });

  test('abort emits aborted status', () => {
    let capturedStatus: string | null = null;
    manager.on('output', (data) => {
      if (data.type === 'status') {
        capturedStatus = data.content;
      }
    });

    // Simulate a running process
    (manager as unknown as { isProcessing: boolean }).isProcessing = true;
    (manager as unknown as { currentProcess: { kill: () => void } }).currentProcess = {
      kill: mock(() => {})
    };

    manager.abort();

    expect(capturedStatus).toBe('aborted');
    expect(manager.isRunning()).toBe(false);
  });

  test('does not process when already processing', async () => {
    (manager as unknown as { isProcessing: boolean }).isProcessing = true;

    let capturedError: { type: string; content: string } | null = null;
    manager.on('output', (data) => {
      if (data.type === 'error') {
        capturedError = data;
      }
    });

    await manager.sendCommand('test');

    expect(capturedError).toEqual({
      type: 'error',
      content: 'Already processing a command'
    });
  });
});

describe('ClaudeCodeManager Integration', () => {
  test('can create manager with default working directory', () => {
    const manager = new ClaudeCodeManager();
    expect(manager.getSessionId()).toBeNull();
  });

  test('handles system message with session_id', () => {
    const manager = new ClaudeCodeManager();
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedSessionId: string | null = null;
    manager.on('sessionId', (id) => {
      capturedSessionId = id;
    });

    const systemMessage = JSON.stringify({
      type: 'system',
      session_id: 'system-session-456'
    });

    handleJsonLine(systemMessage);

    expect(capturedSessionId).toBe('system-session-456');
  });

  test('ignores session_id if one already exists', () => {
    const manager = new ClaudeCodeManager();
    (manager as unknown as { sessionId: string }).sessionId = 'existing-session';

    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    let capturedSessionId: string | null = null;
    manager.on('sessionId', (id) => {
      capturedSessionId = id;
    });

    const initMessage = JSON.stringify({
      type: 'init',
      session_id: 'new-session'
    });

    handleJsonLine(initMessage);

    expect(capturedSessionId).toBeNull();
    expect(manager.getSessionId()).toBe('existing-session');
  });
});

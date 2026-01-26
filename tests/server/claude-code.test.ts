/**
 * @fileoverview Unit tests for ClaudeCodeManager.
 *
 * Tests the manager's session handling, argument building, JSON line parsing,
 * and process lifecycle management.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ClaudeCodeManager } from '../../server/claude-code';

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

describe('ClaudeCodeManager Slash Commands', () => {
  let manager: ClaudeCodeManager;

  beforeEach(() => {
    manager = new ClaudeCodeManager('/test/directory');
  });

  test('/help returns help message', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/help');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('Available commands:');
    expect(outputs[0].content).toContain('/help');
    expect(outputs[0].content).toContain('/clear');
    expect(outputs[0].content).toContain('/session');
    expect(outputs[0].content).toContain('/reset');
  });

  test('/session returns no active session when none exists', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/session');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('No active session');
  });

  test('/session returns session ID when one exists', async () => {
    (manager as unknown as { sessionId: string }).sessionId = 'test-session-abc';

    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/session');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('test-session-abc');
  });

  test('/clear emits clear status', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/clear');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('status');
    expect(outputs[0].content).toBe('clear');
  });

  test('/reset clears session and emits message', async () => {
    (manager as unknown as { sessionId: string }).sessionId = 'test-session';

    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/reset');

    expect(manager.getSessionId()).toBeNull();
    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('Session reset');
  });

  test('/usage returns not available message', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/usage');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('not available');
  });

  test('/cost returns not available message', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/cost');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('not available');
  });

  test('unknown slash command returns error', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/unknowncommand');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('error');
    expect(outputs[0].content).toContain('Unknown command');
    expect(outputs[0].content).toContain('/unknowncommand');
  });

  test('slash commands are case insensitive', async () => {
    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    await manager.sendCommand('/HELP');

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('output');
    expect(outputs[0].content).toContain('Available commands:');
  });
});

describe('ClaudeCodeManager formatToolDetail', () => {
  let manager: ClaudeCodeManager;
  let formatToolDetail: (name: string, input?: Record<string, unknown>) => string;

  beforeEach(() => {
    manager = new ClaudeCodeManager('/test/directory');
    formatToolDetail = (manager as unknown as {
      formatToolDetail: (name: string, input?: Record<string, unknown>) => string
    }).formatToolDetail.bind(manager);
  });

  test('returns tool name when no input provided', () => {
    expect(formatToolDetail('Read')).toBe('Read');
    expect(formatToolDetail('SomeTool')).toBe('SomeTool');
  });

  test('formats Read tool with file path', () => {
    expect(formatToolDetail('Read', { file_path: '/path/to/file.ts' }))
      .toBe('Read: /path/to/file.ts');
  });

  test('formats Read tool with fallback when no file_path', () => {
    expect(formatToolDetail('Read', {})).toBe('Read: file');
  });

  test('formats Write tool with file path', () => {
    expect(formatToolDetail('Write', { file_path: '/path/to/output.txt' }))
      .toBe('Write: /path/to/output.txt');
  });

  test('formats Edit tool with file path', () => {
    expect(formatToolDetail('Edit', { file_path: '/src/component.tsx' }))
      .toBe('Edit: /src/component.tsx');
  });

  test('formats Bash tool with short command', () => {
    expect(formatToolDetail('Bash', { command: 'npm install' }))
      .toBe('Bash: npm install');
  });

  test('formats Bash tool and truncates long command', () => {
    const longCommand = 'npm run build && npm run test && npm run lint && npm run deploy --production --verbose';
    const result = formatToolDetail('Bash', { command: longCommand });
    // The command is truncated at 60 chars + "..."
    expect(result).toBe('Bash: npm run build && npm run test && npm run lint && npm run dep...');
    expect(result.length).toBeLessThanOrEqual(70); // "Bash: " + 60 chars + "..."
  });

  test('formats Bash tool with fallback when no command', () => {
    expect(formatToolDetail('Bash', {})).toBe('Bash');
  });

  test('formats Glob tool with pattern', () => {
    expect(formatToolDetail('Glob', { pattern: '**/*.ts' }))
      .toBe('Glob: **/*.ts');
  });

  test('formats Grep tool with pattern', () => {
    expect(formatToolDetail('Grep', { pattern: 'TODO|FIXME' }))
      .toBe('Grep: TODO|FIXME');
  });

  test('formats WebSearch tool with query', () => {
    expect(formatToolDetail('WebSearch', { query: 'typescript best practices' }))
      .toBe('WebSearch: typescript best practices');
  });

  test('formats WebFetch tool with URL', () => {
    expect(formatToolDetail('WebFetch', { url: 'https://example.com/api' }))
      .toBe('WebFetch: https://example.com/api');
  });

  test('formats Task tool with description', () => {
    expect(formatToolDetail('Task', { description: 'Run unit tests' }))
      .toBe('Task: Run unit tests');
  });

  test('formats Task tool with fallback when no description', () => {
    expect(formatToolDetail('Task', {})).toBe('Task');
  });

  test('formats TodoWrite tool', () => {
    expect(formatToolDetail('TodoWrite', { todos: [] })).toBe('TodoWrite');
  });

  test('returns tool name for unknown tools', () => {
    expect(formatToolDetail('CustomTool', { someArg: 'value' })).toBe('CustomTool');
  });
});

describe('ClaudeCodeManager handleJsonLine Tool Use', () => {
  let manager: ClaudeCodeManager;

  beforeEach(() => {
    manager = new ClaudeCodeManager('/test/directory');
  });

  test('emits tool event for tool_use content', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    const message = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/test/file.ts' } }
        ]
      }
    });

    handleJsonLine(message);

    expect(outputs.length).toBe(1);
    expect(outputs[0].type).toBe('tool');
    expect(outputs[0].content).toBe('Read: /test/file.ts');
  });

  test('handles multiple content blocks in assistant message', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    const message = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check that file.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          { type: 'text', text: 'Here is what I found.' }
        ]
      }
    });

    handleJsonLine(message);

    expect(outputs.length).toBe(3);
    expect(outputs[0]).toEqual({ type: 'output', content: 'Let me check that file.' });
    expect(outputs[1]).toEqual({ type: 'tool', content: 'Read: /src/app.ts' });
    expect(outputs[2]).toEqual({ type: 'output', content: 'Here is what I found.' });
  });

  test('skips empty text blocks', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    const message = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Actual content' }
        ]
      }
    });

    handleJsonLine(message);

    expect(outputs.length).toBe(1);
    expect(outputs[0].content).toBe('Actual content');
  });

  test('handles empty lines gracefully', () => {
    const handleJsonLine = (manager as unknown as { handleJsonLine: (line: string) => void }).handleJsonLine.bind(manager);

    const outputs: { type: string; content: string }[] = [];
    manager.on('output', (data) => outputs.push(data));

    handleJsonLine('   ');

    expect(outputs.length).toBe(0);
  });
});

describe('ClaudeCodeManager setSessionId', () => {
  test('setSessionId updates the session ID', () => {
    const manager = new ClaudeCodeManager();
    expect(manager.getSessionId()).toBeNull();

    manager.setSessionId('new-session-id');

    expect(manager.getSessionId()).toBe('new-session-id');
  });
});

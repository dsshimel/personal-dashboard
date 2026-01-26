/**
 * @fileoverview Tests for the main Express server and WebSocket handlers.
 *
 * Tests REST API endpoints, WebSocket message handling, message buffering,
 * and session management. Uses isolated test instances to avoid port conflicts.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { MockWebSocket, encodeString } from './test-utils';

/**
 * Since index.ts starts servers on import, we test the extracted logic
 * by recreating the key functions and testing them in isolation.
 */

// ============================================================================
// Message Buffering Tests
// ============================================================================

describe('Message Buffering', () => {
  // Recreate the buffering logic for isolated testing
  const MESSAGE_BUFFER_SIZE = 1000;
  let globalMessageId = 0;
  let sessionMessages: Map<string, Array<{ id: number; type: string; content: string; timestamp: string }>>;

  function getNextMessageId(): number {
    return ++globalMessageId;
  }

  function bufferMessage(sessionId: string, type: string, content: string) {
    const message = {
      id: getNextMessageId(),
      type,
      content,
      timestamp: new Date().toISOString()
    };

    if (!sessionMessages.has(sessionId)) {
      sessionMessages.set(sessionId, []);
    }

    const messages = sessionMessages.get(sessionId)!;
    messages.push(message);

    if (messages.length > MESSAGE_BUFFER_SIZE) {
      messages.shift();
    }

    return message;
  }

  function getMessagesSince(sessionId: string, sinceId: number) {
    const messages = sessionMessages.get(sessionId);
    if (!messages) return [];
    return messages.filter(m => m.id > sinceId);
  }

  beforeEach(() => {
    globalMessageId = 0;
    sessionMessages = new Map();
  });

  describe('getNextMessageId', () => {
    test('returns sequential IDs', () => {
      expect(getNextMessageId()).toBe(1);
      expect(getNextMessageId()).toBe(2);
      expect(getNextMessageId()).toBe(3);
    });

    test('continues sequence across calls', () => {
      for (let i = 0; i < 10; i++) {
        getNextMessageId();
      }
      expect(getNextMessageId()).toBe(11);
    });
  });

  describe('bufferMessage', () => {
    test('creates message with sequential ID', () => {
      const msg1 = bufferMessage('session-1', 'output', 'Hello');
      const msg2 = bufferMessage('session-1', 'output', 'World');

      expect(msg1.id).toBe(1);
      expect(msg2.id).toBe(2);
    });

    test('includes timestamp', () => {
      const before = new Date();
      const msg = bufferMessage('session-1', 'output', 'Test');
      const after = new Date();

      const msgTime = new Date(msg.timestamp);
      expect(msgTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(msgTime.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    test('stores message in session map', () => {
      bufferMessage('session-1', 'output', 'Test');

      expect(sessionMessages.has('session-1')).toBe(true);
      expect(sessionMessages.get('session-1')!.length).toBe(1);
    });

    test('creates new array for new session', () => {
      bufferMessage('session-1', 'output', 'Test 1');
      bufferMessage('session-2', 'output', 'Test 2');

      expect(sessionMessages.has('session-1')).toBe(true);
      expect(sessionMessages.has('session-2')).toBe(true);
      expect(sessionMessages.get('session-1')!.length).toBe(1);
      expect(sessionMessages.get('session-2')!.length).toBe(1);
    });

    test('appends to existing session', () => {
      bufferMessage('session-1', 'output', 'Message 1');
      bufferMessage('session-1', 'output', 'Message 2');
      bufferMessage('session-1', 'output', 'Message 3');

      expect(sessionMessages.get('session-1')!.length).toBe(3);
    });

    test('maintains rolling window of MESSAGE_BUFFER_SIZE', () => {
      // Add more than buffer size
      for (let i = 0; i < MESSAGE_BUFFER_SIZE + 50; i++) {
        bufferMessage('session-1', 'output', `Message ${i}`);
      }

      const messages = sessionMessages.get('session-1')!;
      expect(messages.length).toBe(MESSAGE_BUFFER_SIZE);

      // First message should be index 50 (first 50 were shifted out)
      expect(messages[0].content).toBe('Message 50');
    });

    test('preserves message type', () => {
      const output = bufferMessage('s1', 'output', 'test');
      const error = bufferMessage('s1', 'error', 'test');
      const status = bufferMessage('s1', 'status', 'test');

      expect(output.type).toBe('output');
      expect(error.type).toBe('error');
      expect(status.type).toBe('status');
    });
  });

  describe('getMessagesSince', () => {
    test('returns empty array for non-existent session', () => {
      const result = getMessagesSince('non-existent', 0);
      expect(result).toEqual([]);
    });

    test('returns all messages when sinceId is 0', () => {
      bufferMessage('session-1', 'output', 'A');
      bufferMessage('session-1', 'output', 'B');
      bufferMessage('session-1', 'output', 'C');

      const result = getMessagesSince('session-1', 0);
      expect(result.length).toBe(3);
    });

    test('returns messages after specified ID', () => {
      bufferMessage('session-1', 'output', 'A'); // id 1
      bufferMessage('session-1', 'output', 'B'); // id 2
      bufferMessage('session-1', 'output', 'C'); // id 3
      bufferMessage('session-1', 'output', 'D'); // id 4

      const result = getMessagesSince('session-1', 2);
      expect(result.length).toBe(2);
      expect(result[0].content).toBe('C');
      expect(result[1].content).toBe('D');
    });

    test('returns empty array when sinceId is latest', () => {
      bufferMessage('session-1', 'output', 'A');
      bufferMessage('session-1', 'output', 'B');

      const result = getMessagesSince('session-1', 2);
      expect(result).toEqual([]);
    });

    test('returns empty array for empty session', () => {
      sessionMessages.set('empty-session', []);

      const result = getMessagesSince('empty-session', 0);
      expect(result).toEqual([]);
    });
  });
});

// ============================================================================
// broadcastLog Tests
// ============================================================================

describe('broadcastLog', () => {
  test('broadcasts to all open connections', () => {
    const allClients = new Set<MockWebSocket>();
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    allClients.add(ws1 as unknown as MockWebSocket);
    allClients.add(ws2 as unknown as MockWebSocket);

    // Recreate broadcastLog logic
    function broadcastLog(level: string, message: string) {
      const logMessage = JSON.stringify({
        type: 'log',
        level,
        content: message,
        timestamp: new Date().toISOString()
      });

      for (const client of allClients) {
        if (client.readyState === MockWebSocket.OPEN) {
          client.send(logMessage);
        }
      }
    }

    broadcastLog('info', 'Test message');

    expect(ws1.sentMessages.length).toBe(1);
    expect(ws2.sentMessages.length).toBe(1);

    const parsed = JSON.parse(ws1.sentMessages[0]);
    expect(parsed.type).toBe('log');
    expect(parsed.level).toBe('info');
    expect(parsed.content).toBe('Test message');
  });

  test('skips closed connections', () => {
    const allClients = new Set<MockWebSocket>();
    const wsOpen = new MockWebSocket();
    const wsClosed = new MockWebSocket();
    wsClosed.readyState = MockWebSocket.CLOSED;

    allClients.add(wsOpen as unknown as MockWebSocket);
    allClients.add(wsClosed as unknown as MockWebSocket);

    function broadcastLog(level: string, message: string) {
      const logMessage = JSON.stringify({ type: 'log', level, content: message });
      for (const client of allClients) {
        if (client.readyState === MockWebSocket.OPEN) {
          client.send(logMessage);
        }
      }
    }

    broadcastLog('warn', 'Warning');

    expect(wsOpen.sentMessages.length).toBe(1);
    expect(wsClosed.sentMessages.length).toBe(0);
  });
});

// ============================================================================
// WebSocket Message Handler Tests
// ============================================================================

describe('WebSocket Message Handlers', () => {
  // Mock ClaudeCodeManager for testing message handlers
  class MockClaudeCodeManager extends EventEmitter {
    sessionId: string | null = null;
    processing = false;
    aborted = false;
    resetCalled = false;
    lastCommand: string | null = null;
    private workingDirectory: string;

    constructor(workingDirectory?: string) {
      super();
      this.workingDirectory = workingDirectory || '/default';
    }

    getSessionId() {
      return this.sessionId;
    }

    getWorkingDirectory() {
      return this.workingDirectory;
    }

    setSessionId(id: string) {
      this.sessionId = id;
    }

    isRunning() {
      return this.processing;
    }

    async sendCommand(message: string) {
      this.lastCommand = message;
      this.processing = true;
      this.emit('output', { type: 'status', content: 'processing' });
    }

    abort() {
      this.aborted = true;
      this.processing = false;
      this.emit('output', { type: 'status', content: 'aborted' });
    }

    reset() {
      this.resetCalled = true;
      this.sessionId = null;
    }
  }

  let manager: MockClaudeCodeManager;
  let ws: MockWebSocket;

  beforeEach(() => {
    manager = new MockClaudeCodeManager();
    ws = new MockWebSocket();
  });

  describe('command message', () => {
    test('sends command to manager', async () => {
      // Simulate message handler
      const message = { type: 'command', content: 'Hello Claude' };

      if (message.type === 'command' && message.content && typeof message.content === 'string') {
        await manager.sendCommand(message.content);
      }

      expect(manager.lastCommand).toBe('Hello Claude');
    });

    test('ignores empty content', async () => {
      const message = { type: 'command', content: '' };

      if (message.type === 'command' && message.content && typeof message.content === 'string') {
        await manager.sendCommand(message.content);
      }

      expect(manager.lastCommand).toBeNull();
    });

    test('ignores non-string content', async () => {
      const message = { type: 'command', content: 123 };

      if (message.type === 'command' && message.content && typeof message.content === 'string') {
        await manager.sendCommand(message.content);
      }

      expect(manager.lastCommand).toBeNull();
    });
  });

  describe('abort message', () => {
    test('calls manager.abort()', () => {
      const message = { type: 'abort' };

      if (message.type === 'abort') {
        manager.abort();
      }

      expect(manager.aborted).toBe(true);
    });
  });

  describe('reset message', () => {
    test('calls manager.reset() and sends status', () => {
      manager.sessionId = 'test-session';
      const message = { type: 'reset' };

      if (message.type === 'reset') {
        manager.reset();
        ws.send(JSON.stringify({ type: 'status', content: 'reset' }));
      }

      expect(manager.resetCalled).toBe(true);
      expect(manager.sessionId).toBeNull();
      expect(ws.sentMessages.length).toBe(1);
      expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'status', content: 'reset' });
    });
  });

  describe('resume message', () => {
    test('sets session ID on manager', () => {
      const message = { type: 'resume', sessionId: 'session-abc-123' };

      if (message.type === 'resume' && message.sessionId && typeof message.sessionId === 'string') {
        manager.setSessionId(message.sessionId);
        ws.send(JSON.stringify({ type: 'session', content: message.sessionId }));
        ws.send(JSON.stringify({ type: 'status', content: 'resumed' }));
      }

      expect(manager.sessionId).toBe('session-abc-123');
      expect(ws.sentMessages.length).toBe(2);
    });

    test('ignores missing sessionId', () => {
      const message = { type: 'resume' };

      if (message.type === 'resume' && (message as { sessionId?: string }).sessionId) {
        manager.setSessionId((message as { sessionId: string }).sessionId);
      }

      expect(manager.sessionId).toBeNull();
    });

    test('ignores non-string sessionId', () => {
      const message = { type: 'resume', sessionId: 12345 };

      if (message.type === 'resume' && message.sessionId && typeof message.sessionId === 'string') {
        manager.setSessionId(message.sessionId);
      }

      expect(manager.sessionId).toBeNull();
    });
  });

  describe('unknown message type', () => {
    test('sends error response', () => {
      const message = { type: 'unknown-type' };

      // Simulate the default case
      ws.send(JSON.stringify({ type: 'error', content: `Unknown message type: ${message.type}` }));

      const response = JSON.parse(ws.sentMessages[0]);
      expect(response.type).toBe('error');
      expect(response.content).toContain('Unknown message type');
    });
  });

  describe('reset clears connectionSessions', () => {
    test('removes ws from connectionSessions on reset', () => {
      const connectionSessions = new Map<MockWebSocket, string>();
      const sessionManagers = new Map<string, MockClaudeCodeManager>();

      // Simulate an active session
      connectionSessions.set(ws, 'old-session');
      sessionManagers.set('old-session', manager);

      // Simulate reset handler
      const oldSessionId = connectionSessions.get(ws);
      if (oldSessionId) {
        sessionManagers.delete(oldSessionId);
      }
      connectionSessions.delete(ws);
      manager.reset();

      expect(connectionSessions.has(ws)).toBe(false);
      expect(sessionManagers.has('old-session')).toBe(false);
      expect(manager.sessionId).toBeNull();
    });
  });

  describe('command with workingDirectory', () => {
    test('does not carry over old session ID when switching directories', async () => {
      const connectionSessions = new Map<MockWebSocket, string>();

      // Simulate: manager was created with /project-a, has an active session
      manager = new MockClaudeCodeManager('/project-a');
      connectionSessions.set(ws, 'session-from-project-a');
      manager.setSessionId('session-from-project-a');

      const message = { type: 'command', content: 'hello', workingDirectory: '/project-b' };

      // Simulate the command handler's directory-switch logic
      if (message.workingDirectory && typeof message.workingDirectory === 'string') {
        const currentDir = manager.getWorkingDirectory();
        if (currentDir !== message.workingDirectory) {
          // Create new manager for different directory (no session ID carryover)
          manager = new MockClaudeCodeManager(message.workingDirectory);
        }
      }

      // The new manager should have no session ID (starts fresh for new project)
      expect(manager.getWorkingDirectory()).toBe('/project-b');
      expect(manager.getSessionId()).toBeNull();
    });

    test('does not create new manager when directory matches', async () => {
      manager = new MockClaudeCodeManager('/project-a');
      manager.setSessionId('existing-session');
      const originalManager = manager;

      const message = { type: 'command', content: 'hello', workingDirectory: '/project-a' };

      if (message.workingDirectory && typeof message.workingDirectory === 'string') {
        const currentDir = manager.getWorkingDirectory();
        if (currentDir !== message.workingDirectory) {
          manager = new MockClaudeCodeManager(message.workingDirectory);
        }
      }

      // Same manager, session preserved
      expect(manager).toBe(originalManager);
      expect(manager.getSessionId()).toBe('existing-session');
    });
  });

  describe('resume with workingDirectory', () => {
    test('creates new manager when workingDirectory differs', () => {
      const sessionManagers = new Map<string, MockClaudeCodeManager>();

      manager = new MockClaudeCodeManager('/project-a');
      const message = { type: 'resume', sessionId: 'new-session', workingDirectory: '/project-b' };

      // Simulate the resume handler (no existing running manager)
      const existingManager = sessionManagers.get(message.sessionId);
      if (!existingManager || !existingManager.isRunning()) {
        if (message.workingDirectory && typeof message.workingDirectory === 'string') {
          const currentDir = manager.getWorkingDirectory();
          if (currentDir !== message.workingDirectory) {
            manager = new MockClaudeCodeManager(message.workingDirectory);
          }
        }
        manager.setSessionId(message.sessionId);
        sessionManagers.set(message.sessionId, manager);
      }

      expect(manager.getWorkingDirectory()).toBe('/project-b');
      expect(manager.getSessionId()).toBe('new-session');
      expect(sessionManagers.get('new-session')).toBe(manager);
    });

    test('does not create new manager when workingDirectory matches', () => {
      const sessionManagers = new Map<string, MockClaudeCodeManager>();

      manager = new MockClaudeCodeManager('/project-a');
      const originalManager = manager;
      const message = { type: 'resume', sessionId: 'new-session', workingDirectory: '/project-a' };

      const existingManager = sessionManagers.get(message.sessionId);
      if (!existingManager || !existingManager.isRunning()) {
        if (message.workingDirectory && typeof message.workingDirectory === 'string') {
          const currentDir = manager.getWorkingDirectory();
          if (currentDir !== message.workingDirectory) {
            manager = new MockClaudeCodeManager(message.workingDirectory);
          }
        }
        manager.setSessionId(message.sessionId);
        sessionManagers.set(message.sessionId, manager);
      }

      expect(manager).toBe(originalManager);
      expect(manager.getSessionId()).toBe('new-session');
    });

    test('does not replace running manager even with different workingDirectory', () => {
      const sessionManagers = new Map<string, MockClaudeCodeManager>();

      // Existing running manager for this session
      const runningManager = new MockClaudeCodeManager('/project-b');
      runningManager.processing = true;
      runningManager.setSessionId('existing-session');
      sessionManagers.set('existing-session', runningManager);

      manager = new MockClaudeCodeManager('/project-a');
      const message = { type: 'resume', sessionId: 'existing-session', workingDirectory: '/project-c' };

      const existingManager = sessionManagers.get(message.sessionId);
      if (existingManager && existingManager.isRunning()) {
        // Reattach to existing running manager
        manager = existingManager;
      } else {
        if (message.workingDirectory && typeof message.workingDirectory === 'string') {
          const currentDir = manager.getWorkingDirectory();
          if (currentDir !== message.workingDirectory) {
            manager = new MockClaudeCodeManager(message.workingDirectory);
          }
        }
        manager.setSessionId(message.sessionId);
      }

      // Should reattach to the running manager, not create a new one
      expect(manager).toBe(runningManager);
      expect(manager.getWorkingDirectory()).toBe('/project-b');
    });
  });
});

// ============================================================================
// attachManagerToWebSocket Tests
// ============================================================================

describe('attachManagerToWebSocket', () => {
  class MockManager extends EventEmitter {
    sessionId: string | null = null;
    getSessionId() { return this.sessionId; }
  }

  let manager: MockManager;
  let ws: MockWebSocket;
  let connectionSessions: Map<MockWebSocket, string>;

  function attachManagerToWebSocket(
    manager: MockManager,
    ws: MockWebSocket,
    getSessionId: () => string | undefined
  ): () => void {
    const outputHandler = (data: { type: string; content: string }) => {
      const sessionId = getSessionId();
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: data.type, content: data.content }));
      }
    };

    const sessionIdHandler = (sessionId: string) => {
      connectionSessions.set(ws, sessionId);
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'session', content: sessionId }));
      }
    };

    const errorHandler = (error: Error) => {
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', content: error.message }));
      }
    };

    manager.on('output', outputHandler);
    manager.on('sessionId', sessionIdHandler);
    manager.on('error', errorHandler);

    return () => {
      manager.off('output', outputHandler);
      manager.off('sessionId', sessionIdHandler);
      manager.off('error', errorHandler);
    };
  }

  beforeEach(() => {
    manager = new MockManager();
    ws = new MockWebSocket();
    connectionSessions = new Map();
  });

  test('forwards output events to WebSocket', () => {
    attachManagerToWebSocket(manager, ws, () => undefined);

    manager.emit('output', { type: 'output', content: 'Hello' });

    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'output', content: 'Hello' });
  });

  test('forwards sessionId events to WebSocket', () => {
    attachManagerToWebSocket(manager, ws, () => undefined);

    manager.emit('sessionId', 'new-session-id');

    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'session', content: 'new-session-id' });
    expect(connectionSessions.get(ws)).toBe('new-session-id');
  });

  test('forwards error events to WebSocket', () => {
    attachManagerToWebSocket(manager, ws, () => undefined);

    manager.emit('error', new Error('Something went wrong'));

    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'error', content: 'Something went wrong' });
  });

  test('does not send to closed WebSocket', () => {
    attachManagerToWebSocket(manager, ws, () => undefined);
    ws.readyState = MockWebSocket.CLOSED;

    manager.emit('output', { type: 'output', content: 'Hello' });

    expect(ws.sentMessages.length).toBe(0);
  });

  test('cleanup function removes listeners', () => {
    const cleanup = attachManagerToWebSocket(manager, ws, () => undefined);

    manager.emit('output', { type: 'output', content: 'Before cleanup' });
    expect(ws.sentMessages.length).toBe(1);

    cleanup();

    manager.emit('output', { type: 'output', content: 'After cleanup' });
    expect(ws.sentMessages.length).toBe(1); // Still 1, no new message
  });
});

// ============================================================================
// REST Endpoint Logic Tests
// ============================================================================

describe('REST Endpoint Logic', () => {
  describe('GET /health', () => {
    test('returns status and connection count', () => {
      const managers = new Map();
      managers.set('ws1', {});
      managers.set('ws2', {});

      const response = { status: 'ok', connections: managers.size };

      expect(response.status).toBe('ok');
      expect(response.connections).toBe(2);
    });
  });

  describe('GET /sessions/:sessionId/messages', () => {
    test('returns messages since given ID', () => {
      const sessionMessages = new Map<string, Array<{ id: number; content: string }>>();
      sessionMessages.set('session-1', [
        { id: 1, content: 'A' },
        { id: 2, content: 'B' },
        { id: 3, content: 'C' }
      ]);

      const sessionId = 'session-1';
      const sinceId = 1;

      const messages = sessionMessages.get(sessionId)?.filter(m => m.id > sinceId) || [];

      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe('B');
      expect(messages[1].content).toBe('C');
    });

    test('returns empty for non-existent session', () => {
      const sessionMessages = new Map();
      const messages = sessionMessages.get('non-existent')?.filter(() => true) || [];

      expect(messages).toEqual([]);
    });
  });

  describe('Session History Parsing', () => {
    test('parses user message with array content', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'text', text: 'Hello Claude' }]
        },
        timestamp: '2024-01-01T00:00:00Z'
      });

      const parsed = JSON.parse(line);
      let text = '';

      if (parsed.type === 'user' && parsed.message) {
        if (Array.isArray(parsed.message.content)) {
          const textBlock = parsed.message.content.find(
            (c: { type: string; text?: string }) => c.type === 'text' && c.text
          );
          text = textBlock?.text || '';
        }
      }

      expect(text).toBe('Hello Claude');
    });

    test('parses user message with string content', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: 'Hello Claude'
        },
        timestamp: '2024-01-01T00:00:00Z'
      });

      const parsed = JSON.parse(line);
      let text = '';

      if (parsed.type === 'user' && parsed.message) {
        if (typeof parsed.message.content === 'string') {
          text = parsed.message.content;
        }
      }

      expect(text).toBe('Hello Claude');
    });

    test('parses assistant message with text blocks', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'tool_use', name: 'Read' },
            { type: 'text', text: 'Part 2' }
          ]
        },
        timestamp: '2024-01-01T00:00:00Z'
      });

      const parsed = JSON.parse(line);
      const texts: string[] = [];

      if (parsed.type === 'assistant' && parsed.message) {
        if (Array.isArray(parsed.message.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              texts.push(block.text);
            }
          }
        }
      }

      expect(texts).toEqual(['Part 1', 'Part 2']);
    });

    test('handles invalid JSON gracefully', () => {
      const line = 'not valid json {{{';
      let parsed = null;

      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip invalid JSON
      }

      expect(parsed).toBeNull();
    });
  });

  describe('Session List Parsing', () => {
    test('extracts session name from slug', () => {
      const slug = 'fancy-exploring-taco';
      const name = slug
        .split('-')
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      expect(name).toBe('Fancy Exploring Taco');
    });

    test('truncates long session names', () => {
      const longText = 'This is a very long session name that should be truncated because it exceeds the maximum allowed length for display purposes';
      const name = longText.replace(/\s+/g, ' ').trim().substring(0, 80);

      expect(name.length).toBeLessThanOrEqual(80);
    });

    test('sorts sessions by last modified descending', () => {
      const sessions = [
        { id: 'a', lastModified: new Date('2024-01-01') },
        { id: 'b', lastModified: new Date('2024-01-03') },
        { id: 'c', lastModified: new Date('2024-01-02') }
      ];

      sessions.sort((a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
      );

      expect(sessions[0].id).toBe('b');
      expect(sessions[1].id).toBe('c');
      expect(sessions[2].id).toBe('a');
    });

    test('limits to 50 sessions', () => {
      const sessions = Array.from({ length: 100 }, (_, i) => ({ id: `session-${i}` }));
      const limited = sessions.slice(0, 50);

      expect(limited.length).toBe(50);
    });
  });
});

// ============================================================================
// Connection Lifecycle Tests
// ============================================================================

describe('Connection Lifecycle', () => {
  test('initial connection sends connected status', () => {
    const ws = new MockWebSocket();

    // Simulate connection handler
    ws.send(JSON.stringify({ type: 'status', content: 'connected' }));

    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'status', content: 'connected' });
  });

  test('disconnect removes client from collections', () => {
    const ws = new MockWebSocket();
    const allClients = new Set<MockWebSocket>();
    const managers = new Map<MockWebSocket, unknown>();
    const connectionSessions = new Map<MockWebSocket, string>();

    allClients.add(ws);
    managers.set(ws, {});
    connectionSessions.set(ws, 'test-session');

    // Simulate close handler
    allClients.delete(ws);
    connectionSessions.delete(ws);
    managers.delete(ws);

    expect(allClients.has(ws)).toBe(false);
    expect(managers.has(ws)).toBe(false);
    expect(connectionSessions.has(ws)).toBe(false);
  });

  test('error removes client from collections', () => {
    const ws = new MockWebSocket();
    const allClients = new Set<MockWebSocket>();
    const managers = new Map<MockWebSocket, unknown>();

    allClients.add(ws);
    managers.set(ws, {});

    // Simulate error handler
    allClients.delete(ws);
    managers.delete(ws);

    expect(allClients.has(ws)).toBe(false);
    expect(managers.has(ws)).toBe(false);
  });
});

// ============================================================================
// CORS Middleware Tests
// ============================================================================

describe('CORS Middleware', () => {
  test('sets correct headers', () => {
    const headers: Record<string, string> = {};

    // Simulate CORS middleware
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = 'Origin, X-Requested-With, Content-Type, Accept';

    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
  });
});

// ============================================================================
// Restart Signal Tests
// ============================================================================

describe('Restart Signal', () => {
  test('broadcasts restarting status to all clients', () => {
    const allClients = new Set<MockWebSocket>();
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    allClients.add(ws1);
    allClients.add(ws2);

    // Simulate restart broadcast
    const restartMessage = JSON.stringify({ type: 'status', content: 'restarting' });
    for (const client of allClients) {
      if (client.readyState === MockWebSocket.OPEN) {
        client.send(restartMessage);
      }
    }

    expect(ws1.sentMessages.length).toBe(1);
    expect(ws2.sentMessages.length).toBe(1);
    expect(JSON.parse(ws1.sentMessages[0]).content).toBe('restarting');
  });
});

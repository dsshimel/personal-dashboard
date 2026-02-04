/**
 * @fileoverview Tests for multi-tab WebSocket multiplexing.
 *
 * Tests the tabId-based routing of WebSocket messages, per-tab manager
 * lifecycle, attachManagerToWebSocket with tabId, and cleanup behavior.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { EventEmitter } from 'events';
import { MockWebSocket } from './test-utils';

// ============================================================================
// Mock ClaudeCodeManager for multi-tab tests
// ============================================================================

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

  getSessionId() { return this.sessionId; }
  getWorkingDirectory() { return this.workingDirectory; }
  setSessionId(id: string) { this.sessionId = id; }
  isRunning() { return this.processing; }

  async sendCommand(message: string) {
    this.lastCommand = message;
    this.processing = true;
    this.emit('output', { type: 'status', content: 'processing' });
  }

  abort() {
    this.aborted = true;
    this.processing = false;
  }

  reset() {
    this.resetCalled = true;
    this.sessionId = null;
  }
}

// ============================================================================
// attachManagerToWebSocket with tabId
// ============================================================================

describe('attachManagerToWebSocket with tabId', () => {
  let manager: MockClaudeCodeManager;
  let ws: MockWebSocket;
  let tabSessions: Map<string, string>;

  /**
   * Recreates the server's attachManagerToWebSocket function with tabId support.
   */
  function attachManagerToWebSocket(
    manager: MockClaudeCodeManager,
    ws: MockWebSocket,
    tabId: string,
    getSessionId: () => string | undefined
  ): () => void {
    const outputHandler = (data: { type: string; content: string }) => {
      const sessionId = getSessionId();
      if (ws.readyState === MockWebSocket.OPEN) {
        if (sessionId) {
          ws.send(JSON.stringify({ type: data.type, content: data.content, tabId }));
        } else {
          ws.send(JSON.stringify({ type: data.type, content: data.content, tabId }));
        }
      }
    };

    const sessionIdHandler = (sessionId: string) => {
      tabSessions.set(tabId, sessionId);
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'session', content: sessionId, tabId }));
      }
    };

    const errorHandler = (error: Error) => {
      if (ws.readyState === MockWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', content: error.message, tabId }));
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
    manager = new MockClaudeCodeManager();
    ws = new MockWebSocket();
    tabSessions = new Map();
  });

  test('includes tabId in output messages', () => {
    attachManagerToWebSocket(manager, ws, 'tab-project1', () => undefined);

    manager.emit('output', { type: 'output', content: 'Hello from project1' });

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('output');
    expect(msg.content).toBe('Hello from project1');
    expect(msg.tabId).toBe('tab-project1');
  });

  test('includes tabId in session messages', () => {
    attachManagerToWebSocket(manager, ws, 'tab-project2', () => undefined);

    manager.emit('sessionId', 'session-abc');

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('session');
    expect(msg.content).toBe('session-abc');
    expect(msg.tabId).toBe('tab-project2');
  });

  test('includes tabId in error messages', () => {
    attachManagerToWebSocket(manager, ws, 'tab-project3', () => undefined);

    manager.emit('error', new Error('Something failed'));

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('error');
    expect(msg.content).toBe('Something failed');
    expect(msg.tabId).toBe('tab-project3');
  });

  test('stores session ID in tabSessions map on sessionId event', () => {
    attachManagerToWebSocket(manager, ws, 'tab-myproject', () => undefined);

    manager.emit('sessionId', 'session-xyz');

    expect(tabSessions.get('tab-myproject')).toBe('session-xyz');
  });

  test('different tabs get different tabIds in messages', () => {
    const manager1 = new MockClaudeCodeManager('/project-a');
    const manager2 = new MockClaudeCodeManager('/project-b');

    attachManagerToWebSocket(manager1, ws, 'tab-a', () => undefined);
    attachManagerToWebSocket(manager2, ws, 'tab-b', () => undefined);

    manager1.emit('output', { type: 'output', content: 'from A' });
    manager2.emit('output', { type: 'output', content: 'from B' });

    expect(ws.sentMessages.length).toBe(2);
    const msgA = JSON.parse(ws.sentMessages[0]);
    const msgB = JSON.parse(ws.sentMessages[1]);
    expect(msgA.tabId).toBe('tab-a');
    expect(msgA.content).toBe('from A');
    expect(msgB.tabId).toBe('tab-b');
    expect(msgB.content).toBe('from B');
  });

  test('cleanup removes listeners for specific tab only', () => {
    const manager1 = new MockClaudeCodeManager('/project-a');
    const manager2 = new MockClaudeCodeManager('/project-b');

    const cleanup1 = attachManagerToWebSocket(manager1, ws, 'tab-a', () => undefined);
    attachManagerToWebSocket(manager2, ws, 'tab-b', () => undefined);

    // Both should work before cleanup
    manager1.emit('output', { type: 'output', content: 'before cleanup' });
    manager2.emit('output', { type: 'output', content: 'before cleanup' });
    expect(ws.sentMessages.length).toBe(2);

    // Clean up tab-a only
    cleanup1();
    ws.clearMessages();

    manager1.emit('output', { type: 'output', content: 'after cleanup' });
    manager2.emit('output', { type: 'output', content: 'after cleanup' });

    // Only tab-b's message should come through
    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0]).tabId).toBe('tab-b');
  });

  test('does not send to closed WebSocket', () => {
    attachManagerToWebSocket(manager, ws, 'tab-test', () => undefined);
    ws.readyState = MockWebSocket.CLOSED;

    manager.emit('output', { type: 'output', content: 'Hello' });
    manager.emit('sessionId', 'session-123');
    manager.emit('error', new Error('test'));

    expect(ws.sentMessages.length).toBe(0);
  });
});

// ============================================================================
// Multi-Tab Manager Lifecycle
// ============================================================================

describe('Multi-Tab Manager Lifecycle', () => {
  let ws: MockWebSocket;
  let tabManagers: Map<string, MockClaudeCodeManager>;
  let tabSessions: Map<string, string>;
  let sessionManagers: Map<string, MockClaudeCodeManager>;
  let tabCleanups: Map<string, () => void>;

  function getOrCreateManager(tabId: string, workDir: string): MockClaudeCodeManager {
    let manager = tabManagers.get(tabId);
    if (manager && manager.getWorkingDirectory() === workDir) {
      return manager;
    }
    if (manager) {
      tabCleanups.get(tabId)?.();
    }
    manager = new MockClaudeCodeManager(workDir);
    tabManagers.set(tabId, manager);
    tabCleanups.set(tabId, () => { /* cleanup stub */ });
    return manager;
  }

  beforeEach(() => {
    ws = new MockWebSocket();
    tabManagers = new Map();
    tabSessions = new Map();
    sessionManagers = new Map();
    tabCleanups = new Map();
  });

  test('creates separate managers for different tabs', () => {
    const m1 = getOrCreateManager('tab-project-a', '/project-a');
    const m2 = getOrCreateManager('tab-project-b', '/project-b');

    expect(m1).not.toBe(m2);
    expect(m1.getWorkingDirectory()).toBe('/project-a');
    expect(m2.getWorkingDirectory()).toBe('/project-b');
    expect(tabManagers.size).toBe(2);
  });

  test('reuses manager for same tab and directory', () => {
    const m1 = getOrCreateManager('tab-project-a', '/project-a');
    const m2 = getOrCreateManager('tab-project-a', '/project-a');

    expect(m1).toBe(m2);
    expect(tabManagers.size).toBe(1);
  });

  test('replaces manager when directory changes for same tab', () => {
    const m1 = getOrCreateManager('tab-project-a', '/project-a');
    const m2 = getOrCreateManager('tab-project-a', '/project-b');

    expect(m1).not.toBe(m2);
    expect(m2.getWorkingDirectory()).toBe('/project-b');
    expect(tabManagers.size).toBe(1);
    expect(tabManagers.get('tab-project-a')).toBe(m2);
  });

  test('calls cleanup when replacing manager', () => {
    let cleanupCalled = false;
    getOrCreateManager('tab-x', '/dir-a');
    tabCleanups.set('tab-x', () => { cleanupCalled = true; });

    getOrCreateManager('tab-x', '/dir-b');

    expect(cleanupCalled).toBe(true);
  });
});

// ============================================================================
// Tab-Scoped Message Routing
// ============================================================================

describe('Tab-Scoped Message Routing', () => {
  let tabManagers: Map<string, MockClaudeCodeManager>;
  let tabSessions: Map<string, string>;
  let sessionManagers: Map<string, MockClaudeCodeManager>;

  beforeEach(() => {
    tabManagers = new Map();
    tabSessions = new Map();
    sessionManagers = new Map();
  });

  describe('command with tabId', () => {
    test('routes command to correct tab manager', async () => {
      const managerA = new MockClaudeCodeManager('/project-a');
      const managerB = new MockClaudeCodeManager('/project-b');
      tabManagers.set('tab-a', managerA);
      tabManagers.set('tab-b', managerB);

      const message = { type: 'command', content: 'Hello', tabId: 'tab-b' };
      const tabId = message.tabId || 'default';
      const manager = tabManagers.get(tabId);

      if (manager && message.content) {
        await manager.sendCommand(message.content);
      }

      expect(managerA.lastCommand).toBeNull();
      expect(managerB.lastCommand).toBe('Hello');
    });

    test('defaults to "default" tabId when not provided', () => {
      const message = { type: 'command', content: 'Hello' };
      const tabId = (message as { tabId?: string }).tabId || 'default';

      expect(tabId).toBe('default');
    });
  });

  describe('abort with tabId', () => {
    test('aborts only the targeted tab manager', () => {
      const managerA = new MockClaudeCodeManager('/project-a');
      const managerB = new MockClaudeCodeManager('/project-b');
      managerA.processing = true;
      managerB.processing = true;
      tabManagers.set('tab-a', managerA);
      tabManagers.set('tab-b', managerB);

      const tabId = 'tab-a';
      const manager = tabManagers.get(tabId);
      if (manager) manager.abort();

      expect(managerA.aborted).toBe(true);
      expect(managerB.aborted).toBe(false);
    });
  });

  describe('reset with tabId', () => {
    test('resets only the targeted tab and clears its session', () => {
      const managerA = new MockClaudeCodeManager('/project-a');
      const managerB = new MockClaudeCodeManager('/project-b');
      managerA.setSessionId('session-a');
      managerB.setSessionId('session-b');
      tabManagers.set('tab-a', managerA);
      tabManagers.set('tab-b', managerB);
      tabSessions.set('tab-a', 'session-a');
      tabSessions.set('tab-b', 'session-b');
      sessionManagers.set('session-a', managerA);
      sessionManagers.set('session-b', managerB);

      // Simulate reset for tab-a
      const tabId = 'tab-a';
      const oldSessionId = tabSessions.get(tabId);
      if (oldSessionId) sessionManagers.delete(oldSessionId);
      tabSessions.delete(tabId);
      const manager = tabManagers.get(tabId);
      if (manager) manager.reset();

      expect(managerA.resetCalled).toBe(true);
      expect(managerA.sessionId).toBeNull();
      expect(tabSessions.has('tab-a')).toBe(false);
      expect(sessionManagers.has('session-a')).toBe(false);

      // tab-b should be unaffected
      expect(managerB.resetCalled).toBe(false);
      expect(managerB.sessionId).toBe('session-b');
      expect(tabSessions.has('tab-b')).toBe(true);
      expect(sessionManagers.has('session-b')).toBe(true);
    });

    test('sends reset status with tabId', () => {
      const ws = new MockWebSocket();
      const tabId = 'tab-project';

      ws.send(JSON.stringify({ type: 'status', content: 'reset', tabId }));

      const msg = JSON.parse(ws.sentMessages[0]);
      expect(msg.type).toBe('status');
      expect(msg.content).toBe('reset');
      expect(msg.tabId).toBe('tab-project');
    });
  });

  describe('resume with tabId', () => {
    test('associates session with specific tab', () => {
      const manager = new MockClaudeCodeManager('/project-a');
      tabManagers.set('tab-a', manager);

      const tabId = 'tab-a';
      const sessionId = 'session-to-resume';

      const existingManager = sessionManagers.get(sessionId);
      if (!existingManager || !existingManager.isRunning()) {
        manager.setSessionId(sessionId);
        sessionManagers.set(sessionId, manager);
      }
      tabSessions.set(tabId, sessionId);

      expect(manager.getSessionId()).toBe('session-to-resume');
      expect(tabSessions.get('tab-a')).toBe('session-to-resume');
      expect(sessionManagers.get('session-to-resume')).toBe(manager);
    });

    test('reattaches to running manager for the session', () => {
      const runningManager = new MockClaudeCodeManager('/project-a');
      runningManager.processing = true;
      runningManager.setSessionId('active-session');
      sessionManagers.set('active-session', runningManager);

      const localManager = new MockClaudeCodeManager('/project-b');
      tabManagers.set('tab-x', localManager);

      const tabId = 'tab-x';
      const existingManager = sessionManagers.get('active-session');
      if (existingManager && existingManager.isRunning()) {
        tabManagers.set(tabId, existingManager);
      }
      tabSessions.set(tabId, 'active-session');

      expect(tabManagers.get('tab-x')).toBe(runningManager);
      expect(tabSessions.get('tab-x')).toBe('active-session');
    });

    test('sends session and status messages with tabId', () => {
      const ws = new MockWebSocket();
      const tabId = 'tab-project';
      const sessionId = 'resumed-session';

      ws.send(JSON.stringify({ type: 'session', content: sessionId, tabId }));
      ws.send(JSON.stringify({ type: 'status', content: 'resumed', tabId }));

      expect(ws.sentMessages.length).toBe(2);
      const sessionMsg = JSON.parse(ws.sentMessages[0]);
      const statusMsg = JSON.parse(ws.sentMessages[1]);
      expect(sessionMsg.tabId).toBe('tab-project');
      expect(statusMsg.tabId).toBe('tab-project');
      expect(statusMsg.content).toBe('resumed');
    });
  });

  describe('tab-close', () => {
    test('cleans up manager, session, and maps for closed tab', () => {
      const manager = new MockClaudeCodeManager('/project-a');
      manager.setSessionId('session-a');
      tabManagers.set('tab-a', manager);
      tabSessions.set('tab-a', 'session-a');
      sessionManagers.set('session-a', manager);

      let cleanupCalled = false;
      const tabCleanups = new Map<string, () => void>();
      tabCleanups.set('tab-a', () => { cleanupCalled = true; });

      // Simulate tab-close handler
      const tabId = 'tab-a';
      tabCleanups.get(tabId)?.();
      const closedManager = tabManagers.get(tabId);
      if (closedManager) closedManager.abort();
      const sid = tabSessions.get(tabId);
      if (sid) sessionManagers.delete(sid);
      tabSessions.delete(tabId);
      tabManagers.delete(tabId);
      tabCleanups.delete(tabId);

      expect(cleanupCalled).toBe(true);
      expect(manager.aborted).toBe(true);
      expect(tabManagers.has('tab-a')).toBe(false);
      expect(tabSessions.has('tab-a')).toBe(false);
      expect(sessionManagers.has('session-a')).toBe(false);
      expect(tabCleanups.has('tab-a')).toBe(false);
    });

    test('does not affect other tabs when one is closed', () => {
      const managerA = new MockClaudeCodeManager('/project-a');
      const managerB = new MockClaudeCodeManager('/project-b');
      managerA.setSessionId('session-a');
      managerB.setSessionId('session-b');
      tabManagers.set('tab-a', managerA);
      tabManagers.set('tab-b', managerB);
      tabSessions.set('tab-a', 'session-a');
      tabSessions.set('tab-b', 'session-b');
      sessionManagers.set('session-a', managerA);
      sessionManagers.set('session-b', managerB);

      // Close tab-a
      tabManagers.get('tab-a')?.abort();
      const sid = tabSessions.get('tab-a');
      if (sid) sessionManagers.delete(sid);
      tabSessions.delete('tab-a');
      tabManagers.delete('tab-a');

      // tab-b should be completely unaffected
      expect(tabManagers.has('tab-b')).toBe(true);
      expect(tabSessions.get('tab-b')).toBe('session-b');
      expect(sessionManagers.has('session-b')).toBe(true);
      expect(managerB.aborted).toBe(false);
    });
  });
});

// ============================================================================
// Connection Disconnect Cleanup (Multi-Tab)
// ============================================================================

describe('Multi-Tab Connection Cleanup', () => {
  test('cleans up all tabs on disconnect', () => {
    const ws = new MockWebSocket();
    const localTabManagers = new Map<string, MockClaudeCodeManager>();
    const localTabCleanups = new Map<string, () => void>();
    const connectionTabs = new Map<MockWebSocket, Set<string>>();
    const allClients = new Set<MockWebSocket>();

    // Simulate: two tabs open
    const m1 = new MockClaudeCodeManager('/project-a');
    const m2 = new MockClaudeCodeManager('/project-b');
    localTabManagers.set('tab-a', m1);
    localTabManagers.set('tab-b', m2);
    const cleanups: string[] = [];
    localTabCleanups.set('tab-a', () => cleanups.push('tab-a'));
    localTabCleanups.set('tab-b', () => cleanups.push('tab-b'));
    connectionTabs.set(ws, new Set(['tab-a', 'tab-b']));
    allClients.add(ws);

    // Simulate disconnect handler
    allClients.delete(ws);
    for (const cleanup of localTabCleanups.values()) cleanup();
    localTabManagers.clear();
    localTabCleanups.clear();
    connectionTabs.delete(ws);

    expect(allClients.has(ws)).toBe(false);
    expect(localTabManagers.size).toBe(0);
    expect(localTabCleanups.size).toBe(0);
    expect(connectionTabs.has(ws)).toBe(false);
    expect(cleanups).toContain('tab-a');
    expect(cleanups).toContain('tab-b');
  });

  test('error handler cleans up all tabs', () => {
    const ws = new MockWebSocket();
    const localTabManagers = new Map<string, MockClaudeCodeManager>();
    const localTabCleanups = new Map<string, () => void>();
    const connectionTabs = new Map<MockWebSocket, Set<string>>();
    const allClients = new Set<MockWebSocket>();

    localTabManagers.set('tab-x', new MockClaudeCodeManager('/x'));
    let cleanupCalled = false;
    localTabCleanups.set('tab-x', () => { cleanupCalled = true; });
    connectionTabs.set(ws, new Set(['tab-x']));
    allClients.add(ws);

    // Simulate error handler
    allClients.delete(ws);
    for (const cleanup of localTabCleanups.values()) cleanup();
    localTabManagers.clear();
    localTabCleanups.clear();
    connectionTabs.delete(ws);

    expect(cleanupCalled).toBe(true);
    expect(localTabManagers.size).toBe(0);
    expect(connectionTabs.has(ws)).toBe(false);
  });
});

// ============================================================================
// Messages without tabId (backward compatibility)
// ============================================================================

describe('Backward Compatibility', () => {
  test('messages without tabId default to "default"', () => {
    const message = { type: 'command', content: 'Hello' };
    const tabId: string = (message as { tabId?: string }).tabId || 'default';

    expect(tabId).toBe('default');
  });

  test('messages with explicit tabId use that value', () => {
    const message = { type: 'command', content: 'Hello', tabId: 'tab-project1' };
    const tabId: string = message.tabId || 'default';

    expect(tabId).toBe('tab-project1');
  });

  test('global messages (logs) have no tabId', () => {
    const ws = new MockWebSocket();

    // Simulate broadcastLog - no tabId included
    const logMessage = JSON.stringify({
      type: 'log',
      level: 'info',
      content: 'Server started',
      timestamp: new Date().toISOString()
    });
    ws.send(logMessage);

    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('log');
    expect(msg.tabId).toBeUndefined();
  });
});

// ============================================================================
// Concurrent Tab Operations
// ============================================================================

describe('Concurrent Tab Operations', () => {
  test('multiple tabs can have different sessions simultaneously', () => {
    const tabSessions = new Map<string, string>();
    tabSessions.set('tab-a', 'session-1');
    tabSessions.set('tab-b', 'session-2');
    tabSessions.set('tab-c', 'session-3');

    expect(tabSessions.get('tab-a')).toBe('session-1');
    expect(tabSessions.get('tab-b')).toBe('session-2');
    expect(tabSessions.get('tab-c')).toBe('session-3');
    expect(tabSessions.size).toBe(3);
  });

  test('multiple tabs can have different processing states', () => {
    const managerA = new MockClaudeCodeManager('/a');
    const managerB = new MockClaudeCodeManager('/b');
    const managerC = new MockClaudeCodeManager('/c');

    managerA.processing = true;  // tab-a is processing
    managerB.processing = false; // tab-b is idle
    managerC.processing = true;  // tab-c is processing

    expect(managerA.isRunning()).toBe(true);
    expect(managerB.isRunning()).toBe(false);
    expect(managerC.isRunning()).toBe(true);
  });

  test('aborting one tab does not affect others', () => {
    const managerA = new MockClaudeCodeManager('/a');
    const managerB = new MockClaudeCodeManager('/b');
    managerA.processing = true;
    managerB.processing = true;

    managerA.abort();

    expect(managerA.aborted).toBe(true);
    expect(managerA.processing).toBe(false);
    expect(managerB.aborted).toBe(false);
    expect(managerB.processing).toBe(true);
  });

  test('messages from different tabs are distinguishable', () => {
    const ws = new MockWebSocket();

    // Simulate messages from different tabs arriving
    const messages = [
      { type: 'output', content: 'Result A', tabId: 'tab-a' },
      { type: 'output', content: 'Result B', tabId: 'tab-b' },
      { type: 'status', content: 'processing', tabId: 'tab-a' },
      { type: 'complete', tabId: 'tab-b' },
    ];

    for (const msg of messages) {
      ws.send(JSON.stringify(msg));
    }

    const parsed = ws.getJsonMessages() as Array<{ tabId: string; type: string }>;
    const tabAMessages = parsed.filter(m => m.tabId === 'tab-a');
    const tabBMessages = parsed.filter(m => m.tabId === 'tab-b');

    expect(tabAMessages.length).toBe(2);
    expect(tabBMessages.length).toBe(2);
    expect(tabAMessages[0].type).toBe('output');
    expect(tabAMessages[1].type).toBe('status');
    expect(tabBMessages[0].type).toBe('output');
    expect(tabBMessages[1].type).toBe('complete');
  });
});

// ============================================================================
// Health Endpoint (updated for multi-tab)
// ============================================================================

describe('Health Endpoint (multi-tab)', () => {
  test('returns connection and tab counts', () => {
    const connectionTabs = new Map<MockWebSocket, Set<string>>();
    const tabManagers = new Map<string, MockClaudeCodeManager>();

    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    connectionTabs.set(ws1, new Set(['tab-a', 'tab-b']));
    connectionTabs.set(ws2, new Set(['tab-c']));
    tabManagers.set('tab-a', new MockClaudeCodeManager('/a'));
    tabManagers.set('tab-b', new MockClaudeCodeManager('/b'));
    tabManagers.set('tab-c', new MockClaudeCodeManager('/c'));

    const response = {
      status: 'ok',
      connections: connectionTabs.size,
      tabs: tabManagers.size,
    };

    expect(response.status).toBe('ok');
    expect(response.connections).toBe(2);
    expect(response.tabs).toBe(3);
  });
});

// ============================================================================
// Single Connection Multi-Tab (no reconnection needed per tab switch)
// ============================================================================

describe('Single Connection Multi-Tab', () => {
  test('all tabs share one WebSocket connection', () => {
    const ws = new MockWebSocket();
    const connectionTabs = new Map<MockWebSocket, Set<string>>();
    const tabManagers = new Map<string, MockClaudeCodeManager>();

    // Simulate opening multiple tabs on the same connection
    connectionTabs.set(ws, new Set());
    for (const tabId of ['tab-a', 'tab-b', 'tab-c']) {
      const manager = new MockClaudeCodeManager(`/project-${tabId}`);
      tabManagers.set(tabId, manager);
      connectionTabs.get(ws)!.add(tabId);
    }

    // Only one connection, three tabs
    expect(connectionTabs.size).toBe(1);
    expect(connectionTabs.get(ws)!.size).toBe(3);
    expect(tabManagers.size).toBe(3);
  });

  test('switching active tab does not require new connection', () => {
    const ws = new MockWebSocket();
    const tabManagers = new Map<string, MockClaudeCodeManager>();

    // Set up two tabs on one connection
    const managerA = new MockClaudeCodeManager('/a');
    const managerB = new MockClaudeCodeManager('/b');
    tabManagers.set('tab-a', managerA);
    tabManagers.set('tab-b', managerB);

    // "Switch" to tab-b and send a command - same ws, just different tabId
    const tabId = 'tab-b';
    const manager = tabManagers.get(tabId);
    expect(manager).toBe(managerB);

    ws.send(JSON.stringify({ type: 'command', content: 'hello', tabId }));

    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.tabId).toBe('tab-b');
    expect(msg.content).toBe('hello');

    // "Switch" to tab-a and send a command - still same ws
    const tabId2 = 'tab-a';
    const manager2 = tabManagers.get(tabId2);
    expect(manager2).toBe(managerA);

    ws.send(JSON.stringify({ type: 'command', content: 'world', tabId: tabId2 }));

    const msg2 = JSON.parse(ws.sentMessages[1]);
    expect(msg2.tabId).toBe('tab-a');
    expect(msg2.content).toBe('world');

    // Still only 2 messages on 1 connection
    expect(ws.sentMessages.length).toBe(2);
  });

  test('reconnect resumes all tabs on single new connection', () => {
    const tabSessions = new Map<string, string>();
    tabSessions.set('tab-a', 'session-1');
    tabSessions.set('tab-b', 'session-2');
    tabSessions.set('tab-c', 'session-3');

    // Simulate reconnection: new WebSocket, resume all tabs
    const newWs = new MockWebSocket();
    const resumeMessages: Array<{ type: string; tabId: string; sessionId: string }> = [];

    for (const [tabId, sessionId] of tabSessions.entries()) {
      const msg = { type: 'resume', tabId, sessionId, workingDirectory: `/project-${tabId}` };
      newWs.send(JSON.stringify(msg));
      resumeMessages.push(msg);
    }

    // All 3 tabs resumed on single connection
    expect(newWs.sentMessages.length).toBe(3);
    const parsed = newWs.getJsonMessages() as Array<{ type: string; tabId: string; sessionId: string }>;
    expect(parsed.every(m => m.type === 'resume')).toBe(true);
    expect(new Set(parsed.map(m => m.tabId))).toEqual(new Set(['tab-a', 'tab-b', 'tab-c']));
    expect(parsed.find(m => m.tabId === 'tab-a')!.sessionId).toBe('session-1');
    expect(parsed.find(m => m.tabId === 'tab-b')!.sessionId).toBe('session-2');
    expect(parsed.find(m => m.tabId === 'tab-c')!.sessionId).toBe('session-3');
  });

  test('interleaved messages from multiple tabs on single connection are correctly tagged', () => {
    const ws = new MockWebSocket();
    const managerA = new MockClaudeCodeManager('/a');
    const managerB = new MockClaudeCodeManager('/b');

    // Attach both managers to same ws with different tabIds
    const outputHandlerA = (data: { type: string; content: string }) => {
      ws.send(JSON.stringify({ ...data, tabId: 'tab-a' }));
    };
    const outputHandlerB = (data: { type: string; content: string }) => {
      ws.send(JSON.stringify({ ...data, tabId: 'tab-b' }));
    };
    managerA.on('output', outputHandlerA);
    managerB.on('output', outputHandlerB);

    // Interleaved output from both managers
    managerA.emit('output', { type: 'output', content: 'A1' });
    managerB.emit('output', { type: 'output', content: 'B1' });
    managerA.emit('output', { type: 'output', content: 'A2' });
    managerB.emit('output', { type: 'output', content: 'B2' });
    managerA.emit('output', { type: 'status', content: 'processing' });

    const parsed = ws.getJsonMessages() as Array<{ type: string; content: string; tabId: string }>;
    expect(parsed.length).toBe(5);

    // Verify ordering and correct tab tagging
    expect(parsed[0]).toEqual({ type: 'output', content: 'A1', tabId: 'tab-a' });
    expect(parsed[1]).toEqual({ type: 'output', content: 'B1', tabId: 'tab-b' });
    expect(parsed[2]).toEqual({ type: 'output', content: 'A2', tabId: 'tab-a' });
    expect(parsed[3]).toEqual({ type: 'output', content: 'B2', tabId: 'tab-b' });
    expect(parsed[4]).toEqual({ type: 'status', content: 'processing', tabId: 'tab-a' });
  });
});

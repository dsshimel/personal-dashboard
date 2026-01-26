# Backend (server/)

Node.js/Bun backend providing WebSocket servers and Claude CLI process management.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Express server (port 3001): WebSocket for commands, REST API for sessions |
| `claude-code.ts` | `ClaudeCodeManager` class: spawns Claude CLI, handles I/O streaming |
| `webcam-server.ts` | WebSocket server (port 3002) for webcam streaming |
| `webcam-manager.ts` | `WebcamManager` class: FFmpeg webcam capture and MJPEG streaming |
| `restart-watcher.ts` | Standalone process that monitors for restart signals |

## Key Classes

### ClaudeCodeManager
Manages Claude CLI process lifecycle. Extends `EventEmitter`.

**Events:**
- `output` - Claude response data `{type, content}`
- `sessionId` - New session ID assigned
- `error` - Error occurred

**Methods:**
- `sendCommand(message)` - Send prompt to Claude
- `abort()` - Kill current process
- `reset()` - Clear session and abort
- `setSessionId(id)` - Resume existing session

### WebcamManager
Manages FFmpeg webcam capture. Extends `EventEmitter`.

**Events:**
- `frame` - JPEG frame `{deviceId, data: base64}`
- `stream-started` / `stream-stopped` - Stream lifecycle
- `error` - FFmpeg error

**Methods:**
- `listDevices()` - Enumerate webcams via FFmpeg, queries device capabilities
- `startStream(deviceId, outputMode)` - Begin capturing at native resolution; `'grid'` scales to half native, `'fullscreen'` passes through
- `stopStream(deviceId)` - Stop capturing
- `setOutputMode(deviceId, outputMode)` - Switch between grid/fullscreen (kills and restarts FFmpeg)

## Process Spawning

Uses `Bun.spawn` for Claude CLI:
```typescript
Bun.spawn(['claude', '-p', message, '--output-format', 'stream-json', ...])
```

Output is streamed JSON lines parsed in real-time.

## Session Storage

Sessions read from `~/.claude/projects/<project>/<session-id>.jsonl` (Claude CLI format).

## Message Buffering

Server buffers last 1000 messages per session for reconnection support.
Clients can fetch missed messages via `/sessions/:id/messages?since=N`.

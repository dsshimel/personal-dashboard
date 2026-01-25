# Personal Dashboard

Web terminal interface for Claude Code CLI with webcam streaming support.

## Commands

```bash
bun run dev:all      # Development (frontend + backend servers)
bun run prod:all     # Production build and serve
bun run server       # Backend only (port 3001)
bun run webcam       # Webcam server only (port 3002)
bun test server/     # Run server tests
bun run lint         # Run ESLint
```

## Architecture

```
Browser
  ├─ WebSocket :3001 ─→ Express Server ─→ ClaudeCodeManager ─→ Claude CLI
  └─ WebSocket :3002 ─→ WebcamServer ─→ WebcamManager ─→ FFmpeg
```

## Directory Structure

- `src/` - React frontend (single-page app)
- `server/` - Backend servers and process managers

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main React component with all UI, state, and WebSocket handling |
| `server/index.ts` | Express server + WebSocket (port 3001), REST API for sessions |
| `server/claude-code.ts` | `ClaudeCodeManager` class - spawns and manages Claude CLI |
| `server/webcam-server.ts` | WebSocket server for webcam streams (port 3002) |
| `server/webcam-manager.ts` | `WebcamManager` class - FFmpeg webcam capture/streaming |
| `server/restart-watcher.ts` | Process watcher for graceful server restarts |

## WebSocket Protocol

### Main Server (port 3001)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `{type: 'command', content: string}` | client→server | Send prompt to Claude |
| `{type: 'abort'}` | client→server | Cancel current operation |
| `{type: 'reset'}` | client→server | Clear session |
| `{type: 'resume', sessionId: string}` | client→server | Resume existing session |
| `{type: 'output', content: string}` | server→client | Claude response text |
| `{type: 'error', content: string}` | server→client | Error message |
| `{type: 'status', content: string}` | server→client | Status: connected/processing/restarting |
| `{type: 'session', content: string}` | server→client | New session ID |
| `{type: 'log', level, content, timestamp}` | server→client | Server log broadcast |

### Webcam Server (port 3002)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `{type: 'webcam-list'}` | client→server | Request device list |
| `{type: 'webcam-start', deviceId}` | client→server | Start streaming |
| `{type: 'webcam-stop', deviceId}` | client→server | Stop streaming |
| `{type: 'webcam-devices', devices}` | server→client | Device list response |
| `{type: 'webcam-frame', deviceId, data}` | server→client | Base64 JPEG frame |

## Session Management

- Sessions stored as JSONL in `~/.claude/projects/<project>/<session-id>.jsonl`
- Current session ID persisted to `localStorage.currentSessionId`
- Message buffering supports reconnection (last 1000 messages per session)

## REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/sessions` | GET | List recent sessions (top 50) |
| `/sessions/:id/history` | GET | Get conversation history |
| `/sessions/:id/messages?since=N` | GET | Get messages since ID (reconnection) |
| `/restart` | POST | Trigger server restart |

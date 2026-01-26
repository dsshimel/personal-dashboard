# Frontend (src/)

React single-page application providing a terminal interface for Claude Code.

## Structure

- `App.tsx` - Main component containing all UI, state, and logic
- `main.tsx` - React entry point
- `App.css` - Component styles
- `index.css` - Global styles and CSS variables

## Key Patterns

### State Management
Uses React hooks (`useState`, `useRef`, `useCallback`) for local state. No external state library.

### WebSocket Connections
Two separate connections managed via refs:
- `wsRef` - Main server (port 3001) for Claude commands
- `webcamWsRef` - Webcam server (port 3002) for video streaming

### Key Interfaces

```typescript
interface Message { id, type, content, timestamp }  // Terminal messages
interface LogMessage { id, level, content, timestamp }  // Server logs
interface Session { id, name, lastModified, project }  // Session metadata
interface WebcamDevice { id, name, type }  // Webcam device info
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'processing' | 'restarting'
type ActiveTab = 'terminal' | 'logs' | 'webcams'
```

### Session Persistence
- Current session stored in `localStorage.currentSessionId`
- On reconnect, fetches missed messages via REST API
- Supports page reload recovery via `localStorage.restartSessionId`

## UI Components

- **Sidebar** - Session list, new chat
- **Tab bar** - Terminal / Server Logs / Webcams
- **Terminal output** - Message history with auto-scroll
- **Input** - Command entry with Enter to send, Ctrl+C to abort

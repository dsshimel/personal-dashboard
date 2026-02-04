# Personal Dashboard

Web terminal interface for Claude Code CLI with webcam streaming support.

## Commands

```bash
bun run dev:all      # Development (frontend + backend servers)
bun run prod:all     # Production build and serve
bun run prod:watch   # Production build with restart watcher
bun run server       # Backend only (port 4001)
bun run webcam       # Webcam server only (port 4002)
bun test tests/server/  # Run server tests
bun run lint         # Run ESLint
docker compose up -d    # Start Prometheus (port 9090) + Grafana (port 3000)
docker compose down     # Stop monitoring stack
```

## Architecture

```
Browser
  ├─ WebSocket :4001 ─→ Express Server ─→ ClaudeCodeManager ─→ Claude CLI
  ├─ WebSocket :4002 ─→ WebcamServer ─→ WebcamManager ─→ FFmpeg
  └─ iframe :3000 ─→ Grafana ─→ Prometheus ─→ Express /metrics
```

## Directory Structure

- `src/` - React frontend (single-page app)
- `server/` - Backend servers and process managers
- `grafana/` - Grafana provisioning configs and dashboard JSON files
  - `dashboards/` - Dashboard definitions (client-performance.json, server-performance.json)
  - `provisioning/` - Auto-provisioned datasources and dashboard providers

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main React component with all UI, state, and WebSocket handling |
| `server/index.ts` | Express server + WebSocket (port 4001), REST API for sessions |
| `server/claude-code.ts` | `ClaudeCodeManager` class - spawns and manages Claude CLI |
| `server/webcam-server.ts` | WebSocket server for webcam streams (port 4002) |
| `server/webcam-manager.ts` | `WebcamManager` class - FFmpeg webcam capture/streaming |
| `server/telemetry.ts` | Prometheus metrics definitions, Express middleware, `/metrics` endpoints |
| `src/telemetry.ts` | Client-side Web Vitals collection, pushes metrics to server |
| `server/restart-watcher.ts` | Process watcher for graceful server restarts |

## WebSocket Protocol

### Main Server (port 4001)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `{type: 'command', tabId, content: string}` | client→server | Send prompt to Claude |
| `{type: 'abort', tabId}` | client→server | Cancel current operation |
| `{type: 'reset', tabId}` | client→server | Clear session |
| `{type: 'resume', tabId, sessionId: string}` | client→server | Resume existing session |
| `{type: 'tab-close', tabId}` | client→server | Close tab and clean up its manager |
| `{type: 'output', tabId, content: string}` | server→client | Claude response text |
| `{type: 'error', tabId, content: string}` | server→client | Error message |
| `{type: 'status', tabId, content: string}` | server→client | Status: connected/processing/restarting |
| `{type: 'session', tabId, content: string}` | server→client | New session ID |
| `{type: 'log', level, content, timestamp}` | server→client | Server log broadcast (global, no tabId) |

### Webcam Server (port 4002)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `{type: 'webcam-list'}` | client→server | Request device list |
| `{type: 'webcam-start', deviceId, mode?}` | client→server | Start streaming (mode: `'grid'`\|`'fullscreen'`) |
| `{type: 'webcam-stop', deviceId}` | client→server | Stop streaming |
| `{type: 'webcam-mode', deviceId, mode}` | client→server | Switch output mode (grid/fullscreen) |
| `{type: 'webcam-devices', devices}` | server→client | Device list response |
| `{type: 'webcam-frame', deviceId, data}` | server→client | Base64 JPEG frame |
| `{type: 'webcam-log', level, content, timestamp}` | server→client | Webcam server log broadcast |

## Workflow

Before starting non-trivial changes, enter plan mode and ask the user clarifying questions about requirements, edge cases, and preferred approach. Get explicit confirmation on the plan before writing any code.

After finishing work, run `bun run build` to make sure everything builds with no errors. Run `bun test tests/server/` to make sure all tests pass.

## Testing

When adding new features or changing existing behavior, add corresponding tests in `tests/server/`. Run tests with `bun test tests/server/` to verify.

## Performance Monitoring

Uses `prom-client` for server metrics and `web-vitals` for client metrics, with Prometheus + Grafana running via Docker Compose.

- **Server metrics** (`server/telemetry.ts`): HTTP request duration/count, WebSocket connections/messages, Claude command duration/count, process CPU/memory/event loop lag (via `collectDefaultMetrics`)
- **Client metrics** (`src/telemetry.ts`): Web Vitals (LCP, CLS, INP, TTFB), WebSocket reconnections. Pushed to server via `POST /metrics/client`
- **Prometheus** (port 9090): Scrapes `GET /metrics` on port 4001 every 10s. Config in `prometheus.yml`
- **Grafana** (port 3000): Anonymous access enabled, iframe embedding enabled. Dashboards auto-provisioned from `grafana/dashboards/`
- **UI**: Diagnostics tab has three sub-tabs: Server Logs, Client Performance (Grafana iframe), Server Performance (Grafana iframe)
- **Grafana restart**: Sidebar button calls `POST /grafana/restart` which runs `docker restart dashboard-grafana`

To modify dashboards, edit the JSON in `grafana/dashboards/` and restart Grafana (`docker compose restart grafana`).

## Multi-Tab Terminal

- Activating a project opens a new terminal tab with its own Claude session
- Multiple terminal tabs can run different Claude instances in parallel
- Each tab has independent messages, session, status, and working directory
- Server multiplexes via `tabId` field on all per-tab WebSocket messages (messages without `tabId` default to `'default'`)
- Server tracks per-tab managers (`tabManagers`), sessions (`tabSessions`), and connection→tab mappings (`connectionTabs`)
- Tab bar: dynamic terminal tabs on the left, Projects/Conversations on the right, separated by a visual divider
- Closing a tab sends `tab-close` to the server for cleanup

## Session Management

- Sessions stored as JSONL in `~/.claude/projects/<project>/<session-id>.jsonl`
- Open terminal tabs persisted to `localStorage.terminalTabs` (array of `{id, projectId, projectName, workingDirectory, sessionId}`)
- Active tab persisted to `localStorage.activeTerminalTabId`
- Message buffering supports reconnection (last 1000 messages per session)

## REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/sessions` | GET | List recent sessions (top 50) |
| `/sessions/:id/history` | GET | Get conversation history |
| `/sessions/:id/messages?since=N` | GET | Get messages since ID (reconnection) |
| `/restart` | POST | Trigger server restart |
| `/grafana/restart` | POST | Restart the Grafana Docker container |
| `/metrics` | GET | Prometheus scrape endpoint (all server + client-pushed metrics) |
| `/metrics/client` | POST | Client pushes Web Vitals and WS metrics (body: `{name, value}`) |
| `/projects` | GET | List all projects |
| `/projects` | POST | Add a new project (body: `{directory}`) |
| `/projects/:id` | DELETE | Remove a project |
| `/projects/:id/conversations` | GET | List conversations for a project |
| `/projects/:id/conversations` | POST | Add conversation to project (body: `{conversationId}`) |
| `/projects/:id/conversations/:convId` | DELETE | Remove conversation from project |

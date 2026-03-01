# Personal Dashboard

A web-based personal productivity dashboard with a Claude Code terminal, multi-webcam streaming, daily briefing emails, and more. Designed to run on a home server and be accessed remotely via Tailscale or local network.

## Features

### Terminal
Interactive web terminal for the Claude Code CLI with full multi-tab support.
- Multiple parallel Claude sessions, each in its own tab with independent state
- Session persistence — resume previous conversations by ID
- Conversation history browser
- Image attachment support (drag & drop or paste)
- Shell terminal access (gated by Google auth)

### Hardware
Multi-webcam streaming via FFmpeg.
- Auto-detect connected webcams
- Multiple simultaneous streams in a grid layout
- Click to fullscreen with automatic HD resolution switching (1080p @ 30fps)
- Auto-reconnect on connection loss

### Daily Briefing
Automated daily digest email sent via Resend at 8 AM.
- **Prompt Editor** — editable Claude prompt that controls the AI-generated briefing content
- **Calendar** — view upcoming Google Calendar events (next 4 weeks) included in the email
- Manual send and preview endpoints for testing

### TODO List
Simple task list with done/active separation.
- Inline editing, checkbox to mark done
- Collapsible "Done" section

### Recitations
Freeform text snippets (title + content) included verbatim in the daily briefing email. Useful for things you want to review daily.

### Research
AI-powered research with a personal notebook.
- **Topics** — define research topics; articles are auto-generated daily via Claude CLI with web search and included in the briefing email
- **Notebook** — personal notes with title and body, with full create/edit/delete support and created/updated timestamps

### Friend CRM
Lightweight contact relationship manager.
- **Contacts** — track friends and contacts with name, email, phone, and social handles; sorted by time since last interaction
- **Google Contacts** — browse and search your Google Contacts via the Google People API

### Notifications
Monitor Google Docs and Sheets for changes.
- **Feed** — chronological list of detected document changes with read/unread state
- **Watched Docs** — manage which Google Docs/Sheets URLs are being monitored; changes are checked hourly via cron

### Monitoring
Performance observability via Prometheus and Grafana (run via Docker Compose).
- **Server Logs** — real-time server log stream for debugging
- **Client Performance** — Web Vitals (LCP, CLS, INP, TTFB) and WebSocket reconnection metrics
- **Server Performance** — HTTP request duration/count, WebSocket connections, Claude command metrics, process CPU/memory/event loop lag

### Auth
Google OAuth integration used by Calendar, Drive, Contacts, and shell terminal access.

### Configuration
- **Feature Flags** — boolean toggles for enabling/disabling features at runtime
- **Cron Jobs** — view the status and schedule of all background cron jobs

---

## Requirements

- [Bun](https://bun.sh) runtime
- [FFmpeg](https://ffmpeg.org) (for webcam streaming)
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated

## Quick Start

```bash
# Install dependencies
bun install

# Run development servers (frontend + backend)
bun run dev:all

# Or run production build
bun run prod:all
```

## Commands

```bash
bun run dev:all      # Development (frontend + backend servers)
bun run prod:all     # Production build and serve
bun run server       # Backend only (port 4001)
bun run webcam       # Webcam server only (port 4002)
bun test tests/server/  # Run server tests
bun run lint         # Run ESLint
docker compose up -d    # Start Prometheus (port 9090) + Grafana (port 3000)
```

## Architecture

```
Browser
  ├─ WebSocket :4001 ─→ Express Server ─→ ClaudeCodeManager ─→ Claude CLI
  ├─ WebSocket :4002 ─→ WebcamServer ─→ WebcamManager ─→ FFmpeg
  └─ iframe :3000 ─→ Grafana ─→ Prometheus ─→ Express /metrics
```

## Ports

- **4001** - Main Express + WebSocket server (Claude CLI, REST API)
- **4002** - Webcam WebSocket server
- **3000** - Grafana (monitoring dashboards)
- **9090** - Prometheus

## Directory Structure

```
personal-dashboard/
├── src/              # React frontend (single-page app)
│   ├── App.tsx       # Main component with all UI and state
│   └── App.css       # Styling
├── server/           # Backend servers and modules
│   ├── index.ts                       # Express server + all REST endpoints
│   ├── claude-code.ts                 # Claude CLI process manager
│   ├── webcam-server.ts               # Webcam WebSocket server
│   ├── webcam-manager.ts              # FFmpeg webcam streaming
│   ├── todo.ts                        # Todo list CRUD
│   ├── recitations.ts                 # Recitations CRUD
│   ├── research.ts                    # Research topics + article generation
│   ├── notebook.ts                    # Notebook notes CRUD
│   ├── google-calendar.ts             # Google Calendar integration
│   ├── google-contacts.ts             # Google OAuth + Contacts API
│   ├── google-drive-notifications.ts  # Google Drive change monitoring
│   ├── daily-email.ts                 # Daily briefing email scheduler
│   ├── telemetry.ts                   # Prometheus metrics
│   ├── feature-flags.ts               # Feature flag management
│   ├── db.ts                          # SQLite database singleton
│   └── restart-watcher.ts             # Graceful server restart watcher
├── grafana/          # Grafana provisioning configs and dashboard JSON
├── tests/server/     # Server-side tests
└── CLAUDE.md         # Detailed technical documentation
```

## License

MIT

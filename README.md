# Personal Dashboard

A web-based terminal interface for Claude Code CLI with multi-webcam streaming support. Designed to run on a home server and be accessed remotely via Tailscale or local network.

## Features

- **Claude Code Terminal** - Interactive web terminal for the Claude Code CLI with session persistence and history
- **Multi-Webcam Streaming** - Stream multiple webcams simultaneously via FFmpeg with real-time MJPEG encoding
- **Fullscreen Mode** - True browser fullscreen with automatic HD resolution (1080p @ 30fps) switching
- **Server Logs** - Real-time server log streaming for debugging
- **Session Management** - Resume previous conversations, view session history

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

## Ports

- **5173** - Vite dev server (frontend)
- **3001** - Main WebSocket server (Claude CLI)
- **3002** - Webcam WebSocket server

## Directory Structure

```
personal-dashboard/
├── src/           # React frontend (single-page app)
│   ├── App.tsx    # Main component with all UI and state
│   └── App.css    # Styling
├── server/        # Backend servers
│   ├── index.ts           # Express + WebSocket server
│   ├── claude-code.ts     # Claude CLI process manager
│   ├── webcam-server.ts   # Webcam WebSocket server
│   └── webcam-manager.ts  # FFmpeg webcam streaming
└── CLAUDE.md      # Detailed technical documentation
```

## Webcam Features

- Auto-detect connected webcams via FFmpeg DirectShow
- Multiple simultaneous streams in grid layout
- Click to fullscreen with HD mode (1920x1080 @ 30fps)
- Auto-reconnect on connection loss
- Resolution switching (640x480 for grid, 1080p for fullscreen)

## License

MIT

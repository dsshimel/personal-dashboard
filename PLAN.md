# Webcam Streaming Feature - Implementation Plan

## Overview
Add a new feature to stream webcam video to the personal dashboard. This will involve:
1. Backend: Detect connected webcams and stream frames via WebSocket
2. Frontend: Display webcam feeds in a new "Webcams" tab

## Architecture Decision

### Approach: Server-side webcam capture with frame streaming

**Why server-side (not browser-based)?**
- The dashboard runs on a server (potentially headless/remote via Tailscale)
- Browser `getUserMedia()` only works for cameras attached to the client device
- Server-side allows capturing webcams connected to the server machine
- Consistent with the existing architecture pattern (server does the work, streams to client)

**Streaming method: Base64 JPEG frames over WebSocket**
- Leverages existing WebSocket infrastructure
- Simple to implement - send frames as base64-encoded JPEGs
- Client displays frames in an `<img>` tag, updating the `src` on each frame
- Trade-off: Higher bandwidth than raw video, but simpler and more compatible

### Alternative considered: WebRTC
- More efficient for video streaming
- Much more complex to implement (STUN/TURN servers, signaling, etc.)
- Overkill for a local dashboard use case

## Technology Choices

### Windows Webcam Capture
Since this runs on Windows (MSYS_NT-10.0-19045), we need a library that works with Windows webcams:

**Option 1: `node-webcam`** (npm package)
- Cross-platform webcam capture
- Captures still frames as JPEG/PNG
- Simple API, no native compilation required on Windows
- Limitation: Frame-by-frame capture, not continuous streaming

**Option 2: FFmpeg via command line**
- Industry standard, highly reliable
- Can list devices, capture continuous video
- Already works on Windows with proper setup
- Can output to stdout as raw frames or MJPEG

**Recommended: FFmpeg approach**
- More reliable device detection
- Better performance for continuous streaming
- Can control frame rate, resolution, quality
- Bun can spawn FFmpeg and read stdout stream

## Implementation Steps

### Phase 1: Backend - Webcam Detection

1. **Create `server/webcam-manager.ts`**
   - Use FFmpeg to list available webcam devices
   - Windows command: `ffmpeg -list_devices true -f dshow -i dummy`
   - Parse output to extract device names
   - Expose `GET /webcams` endpoint returning device list

### Phase 2: Backend - Frame Streaming

2. **Add webcam streaming to WebSocket**
   - New message types: `webcam-start`, `webcam-stop`, `webcam-frame`
   - Spawn FFmpeg process to capture from selected device
   - FFmpeg command: `ffmpeg -f dshow -i video="DeviceName" -f mjpeg -q:v 5 -r 15 -`
   - Read stdout, extract JPEG frames, base64 encode, send via WebSocket
   - Track active streams per WebSocket connection

3. **Frame extraction logic**
   - MJPEG stream: Each frame starts with `0xFFD8` (JPEG SOI) and ends with `0xFFD9` (EOI)
   - Buffer incoming data, extract complete frames
   - Send frames at controlled rate (e.g., 15 FPS max)

### Phase 3: Frontend - Webcam Tab

4. **Add "Webcams" tab to App.tsx**
   - New tab alongside Terminal and Server Logs
   - State for available webcams and active streams
   - Request webcam list on tab activation

5. **Webcam list UI**
   - Display available webcams with "Start" button
   - Show device name and status (streaming/stopped)

6. **Video display component**
   - `<img>` tag with dynamically updated `src`
   - On `webcam-frame` message: `img.src = 'data:image/jpeg;base64,' + frameData`
   - Stop button to end streaming
   - Basic styling (responsive, aspect ratio)

### Phase 4: Polish

7. **Error handling**
   - Handle FFmpeg not found
   - Handle device in use by another application
   - Handle disconnection during streaming
   - Clean up FFmpeg processes on WebSocket close

8. **Multi-webcam support**
   - Allow streaming multiple webcams simultaneously
   - Grid layout for multiple feeds

## File Changes Summary

### New Files
- `server/webcam-manager.ts` - Webcam detection and streaming logic

### Modified Files
- `server/index.ts` - Add webcam endpoints and WebSocket handlers
- `src/App.tsx` - Add Webcams tab and video display UI
- `src/App.css` - Styling for webcam components

## WebSocket Protocol Additions

### Client → Server
```json
{ "type": "webcam-list" }                    // Request available webcams
{ "type": "webcam-start", "deviceId": "..." } // Start streaming from device
{ "type": "webcam-stop", "deviceId": "..." }  // Stop streaming from device
```

### Server → Client
```json
{ "type": "webcam-devices", "devices": [...] }           // List of available webcams
{ "type": "webcam-frame", "deviceId": "...", "data": "base64..." } // Video frame
{ "type": "webcam-error", "deviceId": "...", "error": "..." }      // Error message
{ "type": "webcam-started", "deviceId": "..." }          // Stream started confirmation
{ "type": "webcam-stopped", "deviceId": "..." }          // Stream stopped confirmation
```

## Prerequisites

- FFmpeg must be installed and available in PATH
- Will add instructions/check for FFmpeg availability

## Estimated Scope

- ~300 lines for `webcam-manager.ts`
- ~50 lines added to `server/index.ts`
- ~150 lines added to `App.tsx`
- ~50 lines added to `App.css`

## Questions for User

1. **Frame rate preference?** Default 15 FPS is a good balance of smoothness vs bandwidth.
2. **Resolution preference?** Could use 640x480 (lower bandwidth) or camera default.
3. **Should webcam streams persist across page reloads?** (Currently: no, streams stop on disconnect)

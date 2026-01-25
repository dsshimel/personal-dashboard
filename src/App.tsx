import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

// Generate unique ID (crypto.randomUUID requires HTTPS on mobile)
let idCounter = 0
const generateId = () => `msg-${Date.now()}-${++idCounter}`

interface Message {
  id: string
  type: 'input' | 'output' | 'error' | 'status'
  content: string
  timestamp: Date
}

interface LogMessage {
  id: string
  level: 'info' | 'warn' | 'error'
  content: string
  timestamp: Date
}

interface Session {
  id: string
  name: string
  lastModified: string
  project: string
}

interface WebcamDevice {
  id: string
  name: string
  type: 'video' | 'audio'
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'processing' | 'restarting'
type ActiveTab = 'terminal' | 'logs' | 'webcams'

interface BufferedMessage {
  id: number
  type: 'output' | 'error' | 'status' | 'complete'
  content: string
  timestamp: string
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [logMessages, setLogMessages] = useState<LogMessage[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeTab, setActiveTab] = useState<ActiveTab>('terminal')
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null)
  const [webcamDevices, setWebcamDevices] = useState<WebcamDevice[]>([])
  const [activeWebcams, setActiveWebcams] = useState<Set<string>>(new Set())
  const [webcamFrames, setWebcamFrames] = useState<Map<string, string>>(new Map())
  const [loadingWebcams, setLoadingWebcams] = useState(false)
  const [webcamConnected, setWebcamConnected] = useState(false)
  const isRestartingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const webcamWsRef = useRef<WebSocket | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const logsOutputRef = useRef<HTMLDivElement>(null)
  const webcamsContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const lastMessageIdRef = useRef<number>(0)
  const sessionIdRef = useRef<string | null>(null)

  const addMessage = useCallback((type: Message['type'], content: string) => {
    const message: Message = {
      id: generateId(),
      type,
      content,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, message])
  }, [])

  const addLogMessage = useCallback((level: LogMessage['level'], content: string, timestamp: string) => {
    const logMessage: LogMessage = {
      id: generateId(),
      level,
      content,
      timestamp: new Date(timestamp),
    }
    setLogMessages(prev => [...prev, logMessage])
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    setStatus('connecting')

    // Use current hostname for Tailscale compatibility
    const wsUrl = `ws://${window.location.hostname}:3001`
    console.log('[WS] Connecting to:', wsUrl)
    addMessage('status', `Connecting to ${wsUrl}...`)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = async () => {
      console.log('[WS] Connected')
      setStatus('connected')

      // Check for existing session: first from ref, then from localStorage
      // Also check restartSessionId for page reload after server restart
      const restartSessionId = localStorage.getItem('restartSessionId')
      const currentSession = sessionIdRef.current || localStorage.getItem('currentSessionId') || restartSessionId
      const lastId = lastMessageIdRef.current
      const needsHistoryReload = !!restartSessionId || lastId === 0

      // Clear restart session ID if present
      if (restartSessionId) {
        localStorage.removeItem('restartSessionId')
      }

      if (currentSession) {
        console.log(`[WS] Reconnecting to session ${currentSession}, last message ID: ${lastId}, needsHistoryReload: ${needsHistoryReload}`)

        // Resume the session on the server
        ws.send(JSON.stringify({ type: 'resume', sessionId: currentSession }))
        setSessionId(currentSession)
        sessionIdRef.current = currentSession
        localStorage.setItem('currentSessionId', currentSession)

        // If page was reloaded or no message ID, fetch full conversation history
        if (needsHistoryReload) {
          try {
            const res = await fetch(`http://${window.location.hostname}:3001/sessions/${currentSession}/history`)
            const history: Array<{ type: 'input' | 'output' | 'error' | 'status'; content: string; timestamp: string }> = await res.json()
            const restoredMessages: Message[] = history.map(msg => ({
              id: generateId(),
              type: msg.type,
              content: msg.content,
              timestamp: new Date(msg.timestamp),
            }))
            setMessages(restoredMessages)
            addMessage('status', `Restored session with ${history.length} messages`)
          } catch (err) {
            console.error('Failed to fetch session history:', err)
            addMessage('status', `Resumed session: ${currentSession.slice(0, 8)}...`)
          }
        } else {
          // We have a last message ID, fetch any missed messages
          try {
            const res = await fetch(
              `http://${window.location.hostname}:3001/sessions/${currentSession}/messages?since=${lastId}`
            )
            const data: { messages: BufferedMessage[]; latestId: number } = await res.json()

            if (data.messages.length > 0) {
              console.log(`[WS] Fetched ${data.messages.length} missed messages`)
              // Add missed messages to the UI
              data.messages.forEach(msg => {
                if (msg.type === 'output' || msg.type === 'error') {
                  addMessage(msg.type, msg.content)
                } else if (msg.type === 'status') {
                  if (msg.content === 'processing') {
                    setStatus('processing')
                  } else if (msg.content === 'connected') {
                    setStatus('connected')
                  }
                } else if (msg.type === 'complete') {
                  setStatus('connected')
                }
              })
              // Update the last message ID
              lastMessageIdRef.current = data.latestId
              addMessage('status', `Reconnected and fetched ${data.messages.length} missed message(s)`)
            } else {
              addMessage('status', 'Reconnected to Claude Code server')
            }
          } catch (err) {
            console.error('Failed to fetch missed messages:', err)
            addMessage('status', 'Reconnected to Claude Code server')
          }
        }
      } else {
        addMessage('status', 'Connected to Claude Code server')
      }
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // Track message ID if present (for reconnection support)
        if (data.id && typeof data.id === 'number') {
          lastMessageIdRef.current = data.id
        }

        switch (data.type) {
          case 'output':
            addMessage('output', data.content)
            break
          case 'error':
            addMessage('error', data.content)
            break
          case 'status':
            if (data.content === 'processing') {
              setStatus('processing')
            } else if (data.content === 'connected') {
              setStatus('connected')
            } else if (data.content === 'restarting') {
              setStatus('restarting')
              addMessage('status', 'Server is restarting...')
            } else if (data.content === 'clear') {
              setMessages([])
            }
            break
          case 'complete':
            setStatus('connected')
            break
          case 'session':
            setSessionId(data.content)
            sessionIdRef.current = data.content
            localStorage.setItem('currentSessionId', data.content)
            addMessage('status', `Session: ${data.content}`)
            break
          case 'log':
            addLogMessage(data.level, data.content, data.timestamp)
            break
        }
      } catch {
        addMessage('output', event.data)
      }
    }

    ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason)
      wsRef.current = null

      // Don't auto-reconnect if we're restarting - the page will reload
      if (isRestartingRef.current) {
        console.log('[WS] Skipping auto-reconnect during restart')
        return
      }

      setStatus('disconnected')
      addMessage('status', `Disconnected (code: ${event.code}). Reconnecting in 3s...`)

      // Auto-reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect()
      }, 3000)
    }

    ws.onerror = (event) => {
      console.error('[WS] Error:', event)
      addMessage('error', `WebSocket error connecting to ${wsUrl}`)
    }
  }, [addMessage, addLogMessage])

  // Connect to webcam server (separate port)
  const connectWebcam = useCallback(() => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) return

    const wsUrl = `ws://${window.location.hostname}:3002`
    console.log('[Webcam WS] Connecting to:', wsUrl)

    const ws = new WebSocket(wsUrl)
    webcamWsRef.current = ws

    ws.onopen = () => {
      console.log('[Webcam WS] Connected')
      setWebcamConnected(true)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'webcam-devices':
            setWebcamDevices(data.devices)
            setLoadingWebcams(false)
            break
          case 'webcam-frame':
            setWebcamFrames(prev => new Map(prev).set(data.deviceId, data.data))
            break
          case 'webcam-started':
            setActiveWebcams(prev => new Set(prev).add(data.deviceId))
            break
          case 'webcam-stopped':
            setActiveWebcams(prev => {
              const next = new Set(prev)
              next.delete(data.deviceId)
              return next
            })
            setWebcamFrames(prev => {
              const next = new Map(prev)
              next.delete(data.deviceId)
              return next
            })
            break
          case 'webcam-error':
            console.error('[Webcam]', data.error)
            break
        }
      } catch {
        // Ignore parse errors
      }
    }

    ws.onclose = () => {
      console.log('[Webcam WS] Closed')
      webcamWsRef.current = null
      setWebcamConnected(false)
      setActiveWebcams(new Set())
      setWebcamFrames(new Map())
    }

    ws.onerror = (event) => {
      console.error('[Webcam WS] Error:', event)
    }
  }, [])

  // Fetch sessions from API
  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const apiUrl = `http://${window.location.hostname}:3001/sessions`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setSessions(data)
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error)
    } finally {
      setLoadingSessions(false)
    }
  }, [])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  // Fetch sessions when sidebar opens
  useEffect(() => {
    if (sidebarOpen) {
      fetchSessions()
    }
  }, [sidebarOpen, fetchSessions])

  // Auto-scroll to bottom for terminal messages
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [messages])

  // Auto-scroll to bottom for log messages
  useEffect(() => {
    if (logsOutputRef.current) {
      logsOutputRef.current.scrollTop = logsOutputRef.current.scrollHeight
    }
  }, [logMessages])

  // Focus input on load
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Handle mobile keyboard - resize terminal to fit visual viewport
  useEffect(() => {
    const updateHeight = () => {
      const vh = window.visualViewport?.height || window.innerHeight
      document.documentElement.style.setProperty('--vh', `${vh}px`)

      // Scroll to bottom after resize
      setTimeout(() => {
        if (outputRef.current) {
          outputRef.current.scrollTop = outputRef.current.scrollHeight
        }
      }, 50)
    }

    // Initial set
    updateHeight()

    // Update on viewport resize (keyboard open/close)
    window.visualViewport?.addEventListener('resize', updateHeight)
    window.visualViewport?.addEventListener('scroll', updateHeight)
    window.addEventListener('resize', updateHeight)

    return () => {
      window.visualViewport?.removeEventListener('resize', updateHeight)
      window.visualViewport?.removeEventListener('scroll', updateHeight)
      window.removeEventListener('resize', updateHeight)
    }
  }, [])

  const sendCommand = () => {
    if (!input.trim()) return

    const command = input.trim()
    addMessage('input', command)
    setInput('')

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'command',
        content: command
      }))
    } else {
      addMessage('error', 'Not connected to server. Retrying connection...')
      connect()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendCommand()
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      wsRef.current?.send(JSON.stringify({ type: 'abort' }))
      addMessage('status', 'Aborting...')
    }
  }

  const handleReset = () => {
    wsRef.current?.send(JSON.stringify({ type: 'reset' }))
    setSessionId(null)
    sessionIdRef.current = null
    lastMessageIdRef.current = 0
    localStorage.removeItem('currentSessionId')
    setMessages([])
  }

  const handleNewChat = () => {
    handleReset()
    setSidebarOpen(false)
  }

  const handleSelectSession = async (session: Session) => {
    // Reset current session and set new session ID
    wsRef.current?.send(JSON.stringify({ type: 'resume', sessionId: session.id }))
    setSessionId(session.id)
    sessionIdRef.current = session.id
    lastMessageIdRef.current = 0  // Reset message ID for new session
    localStorage.setItem('currentSessionId', session.id)
    setMessages([])
    setSidebarOpen(false)

    // Fetch and restore conversation history
    try {
      const res = await fetch(`http://${window.location.hostname}:3001/sessions/${session.id}/history`)
      const history: Array<{ type: 'input' | 'output' | 'error' | 'status'; content: string; timestamp: string }> = await res.json()
      const restoredMessages: Message[] = history.map(msg => ({
        id: generateId(),
        type: msg.type,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
      }))
      setMessages(restoredMessages)
      addMessage('status', `Loaded ${history.length} messages from session`)
    } catch (err) {
      console.error('Failed to fetch session history:', err)
      addMessage('status', `Resumed session: ${session.name}`)
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case 'connected': return '#4ade80'
      case 'connecting': return '#facc15'
      case 'processing': return '#60a5fa'
      case 'restarting': return '#c084fc'
      case 'disconnected': return '#f87171'
    }
  }

  const handleRestart = async () => {
    try {
      const apiUrl = `http://${window.location.hostname}:3001/restart`
      addMessage('status', 'Requesting server restart...')
      const response = await fetch(apiUrl, { method: 'POST' })
      if (response.ok) {
        setStatus('restarting')
        isRestartingRef.current = true
        // Countdown and refresh
        setRestartCountdown(3)
        // Save current session ID to restore after reload
        if (sessionId) {
          localStorage.setItem('restartSessionId', sessionId)
        }
        const countdownInterval = setInterval(() => {
          setRestartCountdown(prev => {
            if (prev === null || prev <= 1) {
              clearInterval(countdownInterval)
              window.location.reload()
              return null
            }
            return prev - 1
          })
        }, 1000)
      } else {
        addMessage('error', 'Failed to restart server')
      }
    } catch (error) {
      console.error('Failed to restart server:', error)
      addMessage('error', 'Failed to restart server')
    }
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  const formatLogTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const handleClearLogs = () => {
    setLogMessages([])
  }

  const handleTabChange = useCallback((newTab: ActiveTab) => {
    setActiveTab(newTab)
  }, [])

  const requestWebcamList = useCallback(() => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      setLoadingWebcams(true)
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-list' }))
    }
  }, [])

  const startWebcam = useCallback((deviceId: string) => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-start', deviceId }))
    }
  }, [])

  const stopWebcam = useCallback((deviceId: string) => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-stop', deviceId }))
    }
  }, [])

  // Connect to webcam server and fetch list when webcams tab is activated
  useEffect(() => {
    if (activeTab === 'webcams') {
      connectWebcam()
    }
  }, [activeTab, connectWebcam])

  // Fetch webcam list when connected to webcam server
  useEffect(() => {
    if (activeTab === 'webcams' && webcamConnected) {
      requestWebcamList()
    }
  }, [activeTab, webcamConnected, requestWebcamList])

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2>Sessions</h2>
          <button className="close-sidebar" onClick={() => setSidebarOpen(false)}>
            &times;
          </button>
        </div>
        <button className="new-chat-button" onClick={handleNewChat}>
          + New Chat
        </button>
        <button
          className="restart-button"
          onClick={handleRestart}
          disabled={status === 'restarting'}
        >
          {restartCountdown !== null
            ? `Refreshing in ${restartCountdown}...`
            : status === 'restarting'
              ? 'Restarting...'
              : 'Restart Server'}
        </button>
        <div className="sessions-list">
          {loadingSessions ? (
            <div className="loading-sessions">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="no-sessions">No previous sessions</div>
          ) : (
            sessions.map(session => (
              <button
                key={session.id}
                className={`session-item ${sessionId === session.id ? 'active' : ''}`}
                onClick={() => handleSelectSession(session)}
              >
                <div className="session-name">{session.name}</div>
                <div className="session-uuid">({session.id})</div>
                <div className="session-meta">{formatDate(session.lastModified)}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Overlay for mobile */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Main terminal */}
      <div className="terminal">
        <div className="terminal-header">
          <div className="terminal-title">
            <button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <span></span>
              <span></span>
              <span></span>
            </button>
            <span className="terminal-dot" style={{ backgroundColor: getStatusColor() }} />
            {activeTab === 'terminal' ? 'Claude Code Terminal' : 'Server Logs'}
          </div>
          <div className="terminal-controls">
            {activeTab === 'terminal' && sessionId && <span className="session-id">Session: {sessionId.slice(0, 8)}...</span>}
            {activeTab === 'terminal' ? (
              <button onClick={handleReset} className="reset-button" title="Reset session">
                Reset
              </button>
            ) : (
              <button onClick={handleClearLogs} className="reset-button" title="Clear logs">
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div className="tab-bar">
          <button
            className={`tab ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => handleTabChange('terminal')}
          >
            Terminal
          </button>
          <button
            className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => handleTabChange('logs')}
          >
            Server Logs
            {logMessages.length > 0 && <span className="tab-badge">{logMessages.length}</span>}
          </button>
          <button
            className={`tab ${activeTab === 'webcams' ? 'active' : ''}`}
            onClick={() => handleTabChange('webcams')}
          >
            Webcams
            {activeWebcams.size > 0 && <span className="tab-badge">{activeWebcams.size}</span>}
          </button>
        </div>

        {/* Terminal output - always mounted, hidden when inactive */}
        <div className={`terminal-output ${activeTab !== 'terminal' ? 'tab-hidden' : ''}`} ref={outputRef}>
          {messages.length === 0 && (
            <div className="welcome-message">
              Welcome to Claude Code Terminal.
              <br />
              Type a message to start a conversation with Claude.
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`message message-${msg.type}`}>
              {msg.type === 'input' && <span className="prompt">&gt; </span>}
              {msg.type === 'error' && <span className="error-prefix">[ERROR] </span>}
              {msg.type === 'status' && <span className="status-prefix">[STATUS] </span>}
              <span className="message-content">{msg.content}</span>
            </div>
          ))}
          {status === 'processing' && (
            <div className="message message-status">
              <span className="processing-indicator">...</span>
            </div>
          )}
        </div>

        {/* Logs output - always mounted, hidden when inactive */}
        <div className={`logs-output ${activeTab !== 'logs' ? 'tab-hidden' : ''}`} ref={logsOutputRef}>
          {logMessages.length === 0 && (
            <div className="welcome-message">
              No server logs yet.
              <br />
              Logs will appear here as the server processes requests.
            </div>
          )}
          {logMessages.map(log => (
            <div key={log.id} className={`log-message log-${log.level}`}>
              <span className="log-timestamp">[{formatLogTime(log.timestamp)}]</span>
              <span className={`log-level log-level-${log.level}`}>[{log.level.toUpperCase()}]</span>
              <span className="log-content">{log.content}</span>
            </div>
          ))}
        </div>

        {/* Webcams output - always mounted, hidden when inactive */}
        <div className={`webcams-container ${activeTab !== 'webcams' ? 'tab-hidden' : ''}`} ref={webcamsContainerRef}>
            <div className="webcams-header">
              <h3>Available Webcams</h3>
              <button
                className="refresh-webcams-button"
                onClick={requestWebcamList}
                disabled={loadingWebcams}
              >
                {loadingWebcams ? 'Scanning...' : 'Refresh'}
              </button>
            </div>

            {loadingWebcams && webcamDevices.length === 0 && (
              <div className="welcome-message">Scanning for webcams...</div>
            )}

            {!loadingWebcams && webcamDevices.length === 0 && (
              <div className="welcome-message">
                No webcams detected.
                <br />
                Make sure your webcam is connected and click Refresh.
              </div>
            )}

            {webcamDevices.length > 0 && (
              <div className="webcam-devices-list">
                {webcamDevices.map(device => (
                  <div key={device.id} className="webcam-device-item">
                    <div className="webcam-device-info">
                      <span className="webcam-device-name">{device.name}</span>
                      <span className={`webcam-status ${activeWebcams.has(device.id) ? 'streaming' : 'stopped'}`}>
                        {activeWebcams.has(device.id) ? 'Streaming' : 'Stopped'}
                      </span>
                    </div>
                    <button
                      className={`webcam-toggle-button ${activeWebcams.has(device.id) ? 'stop' : 'start'}`}
                      onClick={() => activeWebcams.has(device.id) ? stopWebcam(device.id) : startWebcam(device.id)}
                    >
                      {activeWebcams.has(device.id) ? 'Stop' : 'Start'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {activeWebcams.size > 0 && (
              <div className="webcam-feeds">
                {Array.from(activeWebcams).map(deviceId => (
                  <div key={deviceId} className="webcam-feed">
                    <div className="webcam-feed-header">
                      <span>{webcamDevices.find(d => d.id === deviceId)?.name || deviceId}</span>
                      <button className="webcam-stop-button" onClick={() => stopWebcam(deviceId)}>
                        Stop
                      </button>
                    </div>
                    <div className="webcam-video-container">
                      {webcamFrames.has(deviceId) ? (
                        <img
                          src={`data:image/jpeg;base64,${webcamFrames.get(deviceId)}`}
                          alt={`Webcam feed: ${deviceId}`}
                          className="webcam-video"
                        />
                      ) : (
                        <div className="webcam-loading">Waiting for frames...</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>

        {/* Input container - only show on terminal tab */}
        {activeTab === 'terminal' && (
          <div className="terminal-input-container">
            <span className="input-prompt">&gt;</span>
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={status === 'connected' ? 'Type a message...' : `Status: ${status}...`}
            />
            <button
              className="send-button"
              onClick={sendCommand}
              disabled={!input.trim() || status === 'processing'}
              aria-label="Send message"
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default App

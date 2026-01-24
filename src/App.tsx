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

interface Session {
  id: string
  name: string
  lastModified: string
  project: string
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'processing'

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)

  const addMessage = useCallback((type: Message['type'], content: string) => {
    const message: Message = {
      id: generateId(),
      type,
      content,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, message])
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

    ws.onopen = () => {
      console.log('[WS] Connected')
      setStatus('connected')
      addMessage('status', 'Connected to Claude Code server')
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

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
            }
            break
          case 'complete':
            setStatus('connected')
            break
          case 'session':
            setSessionId(data.content)
            addMessage('status', `Session: ${data.content}`)
            break
        }
      } catch {
        addMessage('output', event.data)
      }
    }

    ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason)
      setStatus('disconnected')
      wsRef.current = null
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
  }, [addMessage])

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

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [messages])

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
    setMessages([])
  }

  const handleNewChat = () => {
    handleReset()
    setSidebarOpen(false)
  }

  const handleSelectSession = (session: Session) => {
    // Reset current session and set new session ID
    wsRef.current?.send(JSON.stringify({ type: 'resume', sessionId: session.id }))
    setSessionId(session.id)
    setMessages([])
    addMessage('status', `Resumed session: ${session.name}`)
    setSidebarOpen(false)
  }

  const getStatusColor = () => {
    switch (status) {
      case 'connected': return '#4ade80'
      case 'connecting': return '#facc15'
      case 'processing': return '#60a5fa'
      case 'disconnected': return '#f87171'
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
            Claude Code Terminal
          </div>
          <div className="terminal-controls">
            {sessionId && <span className="session-id">Session: {sessionId.slice(0, 8)}...</span>}
            <button onClick={handleReset} className="reset-button" title="Reset session">
              Reset
            </button>
          </div>
        </div>

        <div className="terminal-output" ref={outputRef}>
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
      </div>
    </div>
  )
}

export default App

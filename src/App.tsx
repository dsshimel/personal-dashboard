/**
 * @fileoverview Main React application component for the Claude Code web terminal.
 *
 * Provides a browser-based terminal interface to interact with Claude Code CLI,
 * with additional features for server log viewing and webcam streaming.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

/**
 * Counter for generating unique message IDs.
 * Uses timestamp + counter instead of crypto.randomUUID for mobile HTTPS compatibility.
 */
let idCounter = 0

/** Generates a unique message ID combining timestamp and incrementing counter. */
const generateId = () => `msg-${Date.now()}-${++idCounter}`

/** Represents a terminal message displayed in the output area. */
interface Message {
  /** Unique identifier for React key prop. */
  id: string
  /** Message type determines styling: input (user), output (Claude), error, or status. */
  type: 'input' | 'output' | 'error' | 'status'
  /** The text content of the message. */
  content: string
  /** When the message was created. */
  timestamp: Date
}

/** Represents a server log entry displayed in the logs tab. */
interface LogMessage {
  /** Unique identifier for React key prop. */
  id: string
  /** Log severity level. */
  level: 'info' | 'warn' | 'error'
  /** The log message text. */
  content: string
  /** When the log was created on the server. */
  timestamp: Date
}

/** Represents a Claude Code conversation session. */
interface Session {
  /** UUID of the session. */
  id: string
  /** Display name derived from slug or first message. */
  name: string
  /** ISO timestamp of last modification. */
  lastModified: string
  /** Project directory hash the session belongs to. */
  project: string
}

/** Represents a project with a directory and optional GitHub link. */
interface Project {
  /** Unique identifier (slugified directory name). */
  id: string
  /** Display name (directory basename). */
  name: string
  /** Absolute path to the project directory. */
  directory: string
  /** GitHub repository URL, if detected from git remote. */
  githubUrl: string | null
  /** Last used Claude conversation ID for quick resume. */
  lastConversationId: string | null
  /** Explicit list of conversation IDs associated with this project. */
  conversationIds: string[]
}

/** Represents a webcam device detected by FFmpeg. */
interface WebcamDevice {
  /** Device identifier (device name on Windows). */
  id: string
  /** Human-readable device name. */
  name: string
  /** Device type (only 'video' devices are shown). */
  type: 'video' | 'audio'
}

/** WebSocket connection and processing state. */
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'processing' | 'restarting'

/** Currently active UI tab. */
type ActiveTab = 'terminal' | 'logs' | 'webcams' | 'projects'

/** Message stored in server buffer for reconnection support. */
interface BufferedMessage {
  /** Sequential message ID for ordering. */
  id: number
  /** Message type. */
  type: 'output' | 'error' | 'status' | 'complete'
  /** Message content. */
  content: string
  /** ISO timestamp. */
  timestamp: string
}

/**
 * Main application component providing the terminal UI, session management,
 * server log viewing, and webcam streaming functionality.
 */
function App() {
  // Terminal state
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [currentTool, setCurrentTool] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Server logs state
  const [logMessages, setLogMessages] = useState<LogMessage[]>([])

  // Session sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

  // UI state
  const [activeTab, setActiveTab] = useState<ActiveTab>('terminal')
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)

  // Webcam state
  const [webcamDevices, setWebcamDevices] = useState<WebcamDevice[]>([])
  const [activeWebcams, setActiveWebcams] = useState<Set<string>>(new Set())
  const [webcamFrames, setWebcamFrames] = useState<Map<string, string>>(new Map())
  const [loadingWebcams, setLoadingWebcams] = useState(false)
  const [webcamConnected, setWebcamConnected] = useState(false)
  const [fullscreenWebcam, setFullscreenWebcam] = useState<string | null>(null)
  const [startingWebcams, setStartingWebcams] = useState<Set<string>>(new Set())
  const [stoppingWebcams, setStoppingWebcams] = useState<Set<string>>(new Set())
  const [changingResolution, setChangingResolution] = useState<Set<string>>(new Set())

  // Projects state
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectConversations, setProjectConversations] = useState<Session[]>([])
  const [loadingProjectConversations, setLoadingProjectConversations] = useState(false)

  // Refs for mutable values that shouldn't trigger re-renders
  const isRestartingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const webcamWsRef = useRef<WebSocket | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const logsOutputRef = useRef<HTMLDivElement>(null)
  const webcamsContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const webcamReconnectTimeoutRef = useRef<number | null>(null)
  const previousActiveWebcamsRef = useRef<Set<string>>(new Set())
  const changingResolutionRef = useRef<Set<string>>(new Set())
  const lastMessageIdRef = useRef<number>(0)
  const sessionIdRef = useRef<string | null>(null)
  const activeProjectRef = useRef<Project | null>(null)
  const fullscreenOverlayRef = useRef<HTMLDivElement>(null)

  /** Adds a new message to the terminal output. */
  const addMessage = useCallback((type: Message['type'], content: string) => {
    const message: Message = {
      id: generateId(),
      type,
      content,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, message])
  }, [])

  /** Adds a new log entry to the server logs tab. */
  const addLogMessage = useCallback((level: LogMessage['level'], content: string, timestamp: string) => {
    const logMessage: LogMessage = {
      id: generateId(),
      level,
      content,
      timestamp: new Date(timestamp),
    }
    setLogMessages(prev => [...prev, logMessage])
  }, [])

  /**
   * Establishes WebSocket connection to the main server.
   * Handles reconnection, session resumption, and message synchronization.
   */
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
        const resumeMsg: Record<string, string> = { type: 'resume', sessionId: currentSession }
        if (activeProjectRef.current) {
          resumeMsg.workingDirectory = activeProjectRef.current.directory
        }
        ws.send(JSON.stringify(resumeMsg))
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
            addMessage('status', `Restored conversation with ${history.length} messages`)
          } catch (err) {
            console.error('Failed to fetch session history:', err)
            addMessage('status', `Resumed conversation: ${currentSession.slice(0, 8)}...`)
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
            setCurrentTool(null)
            break
          case 'tool':
            setCurrentTool(data.content)
            break
          case 'session':
            setSessionId(data.content)
            sessionIdRef.current = data.content
            localStorage.setItem('currentSessionId', data.content)
            addMessage('status', `Conversation: ${data.content}`)
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

  /**
   * Establishes WebSocket connection to the webcam server (port 3002).
   * Handles frame reception and device list updates.
   */
  const connectWebcam = useCallback(() => {
    // Clear any pending reconnect timeout
    if (webcamReconnectTimeoutRef.current) {
      clearTimeout(webcamReconnectTimeoutRef.current)
      webcamReconnectTimeoutRef.current = null
    }

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
            // Skip frames while resolution is changing to avoid showing wrong aspect ratio
            if (changingResolutionRef.current.has(data.deviceId)) {
              break
            }
            setWebcamFrames(prev => new Map(prev).set(data.deviceId, data.data))
            break
          case 'webcam-started':
            console.log('[Webcam] Received webcam-started for:', data.deviceId)
            setActiveWebcams(prev => new Set(prev).add(data.deviceId))
            setStartingWebcams(prev => {
              const next = new Set(prev)
              next.delete(data.deviceId)
              return next
            })
            // Clear both ref and state
            changingResolutionRef.current.delete(data.deviceId)
            setChangingResolution(prev => {
              console.log('[Webcam] Clearing changingResolution for:', data.deviceId, 'prev:', Array.from(prev))
              const next = new Set(prev)
              next.delete(data.deviceId)
              return next
            })
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
            setStoppingWebcams(prev => {
              const next = new Set(prev)
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
      // Save active webcams before clearing so we can restore them on reconnect
      setActiveWebcams(prev => {
        if (prev.size > 0) {
          previousActiveWebcamsRef.current = new Set(prev)
        }
        return new Set()
      })
      setWebcamFrames(new Map())

      // Auto-reconnect after 3 seconds if on webcams tab
      webcamReconnectTimeoutRef.current = window.setTimeout(() => {
        connectWebcam()
      }, 3000)
    }

    ws.onerror = (event) => {
      console.error('[Webcam WS] Error:', event)
    }
  }, [])

  /** Fetches available sessions from the REST API for the sidebar. */
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

  /** Fetches all projects from the REST API. */
  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      const apiUrl = `http://${window.location.hostname}:3001/projects`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setProjects(data)
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error)
    } finally {
      setLoadingProjects(false)
    }
  }, [])

  /** Adds a new project by directory path. */
  const handleAddProject = useCallback(async () => {
    const dir = newProjectPath.trim()
    if (!dir) return

    try {
      const apiUrl = `http://${window.location.hostname}:3001/projects`
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: dir }),
      })
      if (response.ok) {
        setNewProjectPath('')
        await fetchProjects()
      } else {
        const err = await response.json()
        addMessage('error', `Failed to add project: ${err.error}`)
      }
    } catch (error) {
      console.error('Failed to add project:', error)
      addMessage('error', 'Failed to add project')
    }
  }, [newProjectPath, fetchProjects, addMessage])

  /** Removes a project by ID. */
  const handleRemoveProject = useCallback(async (projectId: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:3001/projects/${projectId}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        if (activeProject?.id === projectId) {
          setActiveProject(null)
          localStorage.removeItem('activeProjectId')
        }
        await fetchProjects()
      }
    } catch (error) {
      console.error('Failed to remove project:', error)
    }
  }, [activeProject, fetchProjects])

  /** Fetches conversations for a specific project. */
  const fetchProjectConversations = useCallback(async (projectId: string) => {
    setLoadingProjectConversations(true)
    try {
      const apiUrl = `http://${window.location.hostname}:3001/projects/${projectId}/conversations`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setProjectConversations(data)
      }
    } catch (error) {
      console.error('Failed to fetch project conversations:', error)
    } finally {
      setLoadingProjectConversations(false)
    }
  }, [])

  /** Switches to a project: sets it active and resumes its last conversation. */
  const handleSwitchProject = useCallback(async (project: Project) => {
    setActiveProject(project)
    localStorage.setItem('activeProjectId', project.id)

    // Reset current session state
    setMessages([])
    setSessionId(null)
    sessionIdRef.current = null
    lastMessageIdRef.current = 0
    localStorage.removeItem('currentSessionId')

    // If the project has a last conversation, resume it
    if (project.lastConversationId) {
      wsRef.current?.send(JSON.stringify({ type: 'resume', sessionId: project.lastConversationId, workingDirectory: project.directory }))
      setSessionId(project.lastConversationId)
      sessionIdRef.current = project.lastConversationId
      localStorage.setItem('currentSessionId', project.lastConversationId)

      // Fetch and restore conversation history
      try {
        const res = await fetch(`http://${window.location.hostname}:3001/sessions/${project.lastConversationId}/history`)
        const history: Array<{ type: 'input' | 'output' | 'error' | 'status'; content: string; timestamp: string }> = await res.json()
        const restoredMessages: Message[] = history.map(msg => ({
          id: generateId(),
          type: msg.type,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
        }))
        setMessages(restoredMessages)
        addMessage('status', `Switched to project: ${project.name}`)
      } catch (err) {
        console.error('Failed to fetch conversation history:', err)
        addMessage('status', `Switched to project: ${project.name}`)
      }
    } else {
      // No previous conversation, just reset
      wsRef.current?.send(JSON.stringify({ type: 'reset' }))
      addMessage('status', `Switched to project: ${project.name} (new conversation)`)
    }

    setActiveTab('terminal')
  }, [addMessage])

  /** Deactivates the current project so new conversations aren't associated with any project. */
  const handleDeactivateProject = useCallback(() => {
    setActiveProject(null)
    localStorage.removeItem('activeProjectId')

    // Reset session state
    setMessages([])
    setSessionId(null)
    sessionIdRef.current = null
    lastMessageIdRef.current = 0
    localStorage.removeItem('currentSessionId')

    wsRef.current?.send(JSON.stringify({ type: 'reset' }))
    addMessage('status', 'Project deactivated — new conversations will not be associated with any project')
    setActiveTab('terminal')
  }, [addMessage])

  // Keep activeProjectRef in sync with state for use in callbacks
  useEffect(() => {
    activeProjectRef.current = activeProject
  }, [activeProject])

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

  // Fetch projects on mount and restore active project from localStorage
  useEffect(() => {
    fetchProjects().then(async () => {
      const savedProjectId = localStorage.getItem('activeProjectId')
      if (savedProjectId) {
        try {
          const apiUrl = `http://${window.location.hostname}:3001/projects`
          const response = await fetch(apiUrl)
          if (response.ok) {
            const allProjects: Project[] = await response.json()
            const saved = allProjects.find(p => p.id === savedProjectId)
            if (saved) {
              setActiveProject(saved)
            }
          }
        } catch {
          // Ignore - projects will load normally
        }
      }
    })
  }, [fetchProjects])

  // Fetch projects and conversations when projects tab is active
  useEffect(() => {
    if (activeTab === 'projects') {
      fetchProjects()
    }
  }, [activeTab, fetchProjects])

  // Fetch conversations when active project changes and projects tab is open
  useEffect(() => {
    if (activeProject && activeTab === 'projects') {
      fetchProjectConversations(activeProject.id)
    }
  }, [activeProject, activeTab, fetchProjectConversations])

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

  /** Sends the current input as a command to Claude via WebSocket. */
  const sendCommand = () => {
    if (!input.trim()) return

    const command = input.trim()
    addMessage('input', command)
    setInput('')

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = {
        type: 'command',
        content: command,
      }
      if (activeProject) {
        msg.workingDirectory = activeProject.directory
        msg.projectId = activeProject.id
      }
      wsRef.current.send(JSON.stringify(msg))
    } else {
      addMessage('error', 'Not connected to server. Retrying connection...')
      connect()
    }
  }

  /** Handles keyboard events: Enter to send, Ctrl+C to abort. */
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

  /** Resets the current session and clears message history. */
  const handleReset = () => {
    wsRef.current?.send(JSON.stringify({ type: 'reset' }))
    setSessionId(null)
    sessionIdRef.current = null
    lastMessageIdRef.current = 0
    localStorage.removeItem('currentSessionId')
    setMessages([])
  }

  /** Starts a new chat session from the sidebar. */
  const handleNewChat = () => {
    handleReset()
    setSidebarOpen(false)
  }

  /** Resumes a previous session and loads its conversation history. */
  const handleSelectSession = async (session: Session) => {
    // Reset current session and set new session ID
    const resumeMsg: Record<string, string> = { type: 'resume', sessionId: session.id }
    if (activeProject) {
      resumeMsg.workingDirectory = activeProject.directory
    }
    wsRef.current?.send(JSON.stringify(resumeMsg))
    setSessionId(session.id)
    sessionIdRef.current = session.id
    lastMessageIdRef.current = 0  // Reset message ID for new session
    localStorage.setItem('currentSessionId', session.id)
    setMessages([])
    setSidebarOpen(false)
    setActiveTab('terminal')  // Switch to terminal tab when selecting a session

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
      addMessage('status', `Loaded ${history.length} messages from conversation`)
    } catch (err) {
      console.error('Failed to fetch session history:', err)
      addMessage('status', `Resumed conversation: ${session.name}`)
    }
  }

  /** Returns the status indicator color based on connection state. */
  const getStatusColor = () => {
    switch (status) {
      case 'connected': return '#4ade80'
      case 'connecting': return '#facc15'
      case 'processing': return '#60a5fa'
      case 'restarting': return '#c084fc'
      case 'disconnected': return '#f87171'
    }
  }

  /** Triggers server restart via REST API and handles page reload countdown. */
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

  /** Formats a date string as a relative time (e.g., "5m ago", "2d ago"). */
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

  /** Formats a Date as HH:MM:SS for log timestamps. */
  const formatLogTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  /** Clears all server log messages from the logs tab. */
  const handleClearLogs = () => {
    setLogMessages([])
  }

  /** Switches between terminal, logs, and webcams tabs. */
  const handleTabChange = useCallback((newTab: ActiveTab) => {
    setActiveTab(newTab)
  }, [])

  /** Requests the list of available webcam devices from the server. */
  const requestWebcamList = useCallback(() => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      setLoadingWebcams(true)
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-list' }))
    }
  }, [])

  /** Starts streaming from a specific webcam device. */
  const startWebcam = useCallback((deviceId: string) => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      setStartingWebcams(prev => new Set(prev).add(deviceId))
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-start', deviceId }))
    }
  }, [])

  /** Stops streaming from a specific webcam device. */
  const stopWebcam = useCallback((deviceId: string) => {
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      setStoppingWebcams(prev => new Set(prev).add(deviceId))
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-stop', deviceId }))
    }
  }, [])

  /** Scrolls the terminal output to the bottom. */
  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [])

  /** Handles scroll events to show/hide the scroll-to-bottom button. */
  const handleTerminalScroll = useCallback(() => {
    if (outputRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = outputRef.current
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100
      setShowScrollButton(!isNearBottom)
    }
  }, [])

  /** Sets the resolution and frame rate for a webcam stream. */
  const setWebcamResolution = useCallback((deviceId: string, resolution: string, frameRate?: number) => {
    console.log('[Webcam] setWebcamResolution called:', deviceId, resolution, frameRate ? `@ ${frameRate}fps` : '')
    if (webcamWsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[Webcam] Adding to changingResolution:', deviceId)
      // Update both state and ref (ref is used by websocket handler)
      changingResolutionRef.current.add(deviceId)
      setChangingResolution(prev => new Set(prev).add(deviceId))
      // Clear old frames so they don't display with wrong aspect ratio during transition
      setWebcamFrames(prev => {
        const next = new Map(prev)
        next.delete(deviceId)
        return next
      })
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-resolution', deviceId, resolution, frameRate }))
    }
  }, [])

  /** Toggles fullscreen mode for a webcam feed, with browser fullscreen and orientation lock. */
  const toggleFullscreenWebcam = useCallback((deviceId: string | null, previousDeviceId?: string | null) => {
    setFullscreenWebcam(deviceId)

    // Change resolution and frame rate based on fullscreen state
    if (deviceId) {
      // Entering fullscreen - request high resolution and higher frame rate
      setWebcamResolution(deviceId, '1920x1080', 30)

      // Request browser fullscreen after a short delay to ensure the overlay is rendered
      setTimeout(() => {
        if (fullscreenOverlayRef.current && document.fullscreenElement === null) {
          fullscreenOverlayRef.current.requestFullscreen().catch(() => {
            // Fullscreen not supported or denied - that's fine, we still have our overlay
          })
        }
      }, 50)
    } else if (previousDeviceId) {
      // Exiting fullscreen - request normal resolution and frame rate
      setWebcamResolution(previousDeviceId, '640x480', 15)

      // Exit browser fullscreen if active
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {
          // Ignore errors
        })
      }
    }

    // Try to lock screen orientation to landscape when entering fullscreen
    // Using type assertion because ScreenOrientation.lock() is not in all TS libs
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>
      unlock?: () => void
    }
    if (deviceId && orientation?.lock) {
      orientation.lock('landscape').catch(() => {
        // Orientation lock not supported or denied - that's fine
      })
    } else if (!deviceId && orientation?.unlock) {
      orientation.unlock()
    }
  }, [setWebcamResolution])

  // Handle escape key and browser fullscreen change to exit fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreenWebcam) {
        toggleFullscreenWebcam(null, fullscreenWebcam)
      }
    }

    // Sync our state when browser fullscreen changes (e.g., user pressed Escape in browser fullscreen)
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && fullscreenWebcam) {
        // Browser exited fullscreen, sync our state
        toggleFullscreenWebcam(null, fullscreenWebcam)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [fullscreenWebcam, toggleFullscreenWebcam])

  // Connect to webcam server and fetch list when webcams tab is activated
  useEffect(() => {
    if (activeTab === 'webcams') {
      connectWebcam()
    }

    return () => {
      if (webcamReconnectTimeoutRef.current) {
        clearTimeout(webcamReconnectTimeoutRef.current)
      }
    }
  }, [activeTab, connectWebcam])

  // Fetch webcam list when connected to webcam server
  useEffect(() => {
    if (activeTab === 'webcams' && webcamConnected) {
      requestWebcamList()
    }
  }, [activeTab, webcamConnected, requestWebcamList])

  // Restore previously active webcams after reconnection
  useEffect(() => {
    if (webcamConnected && webcamDevices.length > 0 && previousActiveWebcamsRef.current.size > 0) {
      const toRestore = previousActiveWebcamsRef.current
      previousActiveWebcamsRef.current = new Set()
      // Only restore webcams that still exist in the device list
      const validDeviceIds = new Set(webcamDevices.map(d => d.id))
      for (const deviceId of toRestore) {
        if (validDeviceIds.has(deviceId)) {
          startWebcam(deviceId)
        }
      }
    }
  }, [webcamConnected, webcamDevices, startWebcam])

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2>Conversations</h2>
          <button className="close-sidebar" onClick={() => setSidebarOpen(false)}>
            &times;
          </button>
        </div>
        {activeProject && (
          <div className="sidebar-project-badge">
            {activeProject.name}
          </div>
        )}
        <button className="new-chat-button" onClick={handleNewChat}>
          + New Conversation
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
            <div className="no-sessions">No previous conversations</div>
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
            {activeTab === 'terminal' ? (activeProject ? `${activeProject.name} — Terminal` : 'Claude Code Terminal')
              : activeTab === 'projects' ? 'Projects'
              : activeTab === 'webcams' ? 'Webcams'
              : 'Server Logs'}
          </div>
          <div className="terminal-controls">
            {activeTab === 'terminal' && sessionId && <span className="session-id">{sessionId.slice(0, 8)}...</span>}
            {activeTab === 'terminal' && (
              <button onClick={handleReset} className="reset-button" title="Reset conversation">
                Reset
              </button>
            )}
            {activeTab === 'logs' && (
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
          <button
            className={`tab ${activeTab === 'projects' ? 'active' : ''}`}
            onClick={() => handleTabChange('projects')}
          >
            Projects
            {projects.length > 0 && <span className="tab-badge">{projects.length}</span>}
          </button>
        </div>

        {/* Terminal output - always mounted, hidden when inactive */}
        <div
          className={`terminal-output ${activeTab !== 'terminal' ? 'tab-hidden' : ''}`}
          ref={outputRef}
          onScroll={handleTerminalScroll}
        >
          {messages.length === 0 && (
            <div className="welcome-message">
              Welcome to Claude Code Terminal.
              <br />
              Type a message to start a conversation with Claude.
            </div>
          )}
          {messages.map((msg, index) => {
            const isLastMessage = index === messages.length - 1
            const isReady = isLastMessage && status === 'connected' && messages.length > 0
            return (
              <div key={msg.id} className={`message message-${msg.type}${isReady ? ' message-ready' : ''}`}>
                {msg.type === 'input' && <span className="prompt">&gt; </span>}
                {msg.type === 'error' && <span className="error-prefix">[ERROR] </span>}
                {msg.type === 'status' && <span className="status-prefix">[STATUS] </span>}
                <span className="message-content">{msg.content}</span>
              </div>
            )
          })}
          {status === 'processing' && (
            <div className="message message-tool">
              <span className="tool-indicator">
                {currentTool || 'Processing...'}
              </span>
            </div>
          )}
        </div>

        {/* Scroll to bottom button */}
        {activeTab === 'terminal' && showScrollButton && (
          <button
            className="scroll-to-bottom-button"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        )}

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
                      disabled={(!webcamConnected && !activeWebcams.has(device.id)) || startingWebcams.has(device.id) || stoppingWebcams.has(device.id)}
                    >
                      {startingWebcams.has(device.id) ? 'Starting...' : stoppingWebcams.has(device.id) ? 'Stopping...' : activeWebcams.has(device.id) ? 'Stop' : 'Start'}
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
                      <div className="webcam-feed-buttons">
                        <button
                          className="webcam-fullscreen-button"
                          onClick={() => toggleFullscreenWebcam(deviceId)}
                          title="Fullscreen"
                        >
                          Fullscreen
                        </button>
                        <button
                          className="webcam-stop-button"
                          onClick={() => stopWebcam(deviceId)}
                          disabled={stoppingWebcams.has(deviceId)}
                        >
                          {stoppingWebcams.has(deviceId) ? 'Stopping...' : 'Stop'}
                        </button>
                      </div>
                    </div>
                    <div className="webcam-video-container" onClick={() => toggleFullscreenWebcam(deviceId)}>
                      {changingResolution.has(deviceId) ? (
                        <div className="webcam-loading">Switching resolution...</div>
                      ) : webcamFrames.has(deviceId) ? (
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

        {/* Projects tab - always mounted, hidden when inactive */}
        <div className={`projects-container ${activeTab !== 'projects' ? 'tab-hidden' : ''}`}>
          <div className="projects-add-form">
            <h3>Add Project</h3>
            <div className="projects-add-row">
              <input
                type="text"
                className="projects-path-input"
                value={newProjectPath}
                onChange={(e) => setNewProjectPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddProject() }}
                placeholder="Enter project directory path..."
              />
              <button
                className="projects-add-button"
                onClick={handleAddProject}
                disabled={!newProjectPath.trim()}
              >
                Add
              </button>
            </div>
          </div>

          {loadingProjects && projects.length === 0 && (
            <div className="welcome-message">Loading projects...</div>
          )}

          {!loadingProjects && projects.length === 0 && (
            <div className="welcome-message">
              No projects yet.
              <br />
              Add a project directory above to get started.
            </div>
          )}

          {projects.length > 0 && (
            <div className="projects-list">
              {projects.map(project => (
                <div
                  key={project.id}
                  className={`project-card ${activeProject?.id === project.id ? 'active' : ''}`}
                >
                  <div className="project-card-header">
                    <div className="project-card-name">{project.name}</div>
                    <div className="project-card-actions">
                      {activeProject?.id === project.id ? (
                        <button
                          className="project-deactivate-button"
                          onClick={handleDeactivateProject}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="project-switch-button"
                          onClick={() => handleSwitchProject(project)}
                        >
                          Switch
                        </button>
                      )}
                      <button
                        className="project-remove-button"
                        onClick={() => handleRemoveProject(project.id)}
                        title="Remove project"
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                  <div className="project-card-directory">{project.directory}</div>
                  {project.githubUrl && (
                    <a
                      className="project-card-github"
                      href={project.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {project.githubUrl.replace('https://github.com/', '')}
                    </a>
                  )}
                  {project.lastConversationId && (
                    <div className="project-card-conversation">
                      Last conversation: {project.lastConversationId.slice(0, 8)}...
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeProject && (
            <div className="project-conversations">
              <h3>Conversations for {activeProject.name}</h3>
              {loadingProjectConversations ? (
                <div className="welcome-message">Loading conversations...</div>
              ) : projectConversations.length === 0 ? (
                <div className="welcome-message">No conversations yet for this project.</div>
              ) : (
                <div className="project-conversations-list">
                  {projectConversations.map(conv => (
                    <button
                      key={conv.id}
                      className={`session-item ${sessionId === conv.id ? 'active' : ''}`}
                      onClick={() => handleSelectSession(conv)}
                    >
                      <div className="session-name">{conv.name}</div>
                      <div className="session-meta">{formatDate(conv.lastModified)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fullscreen webcam overlay */}
        {fullscreenWebcam && (
          <div ref={fullscreenOverlayRef} className="webcam-fullscreen-overlay" onClick={() => toggleFullscreenWebcam(null, fullscreenWebcam)}>
            <div className="webcam-fullscreen-header">
              <span>{webcamDevices.find(d => d.id === fullscreenWebcam)?.name || fullscreenWebcam}</span>
              <button
                className="webcam-exit-fullscreen-button"
                onClick={(e) => { e.stopPropagation(); toggleFullscreenWebcam(null, fullscreenWebcam); }}
              >
                Exit Fullscreen
              </button>
            </div>
            {changingResolution.has(fullscreenWebcam) || !webcamFrames.has(fullscreenWebcam) ? (
              <div className="webcam-fullscreen-loading" onClick={(e) => e.stopPropagation()}>
                <div className="webcam-loading-spinner"></div>
                <span>Switching to HD...</span>
              </div>
            ) : (
              <img
                src={`data:image/jpeg;base64,${webcamFrames.get(fullscreenWebcam)}`}
                alt={`Webcam feed: ${fullscreenWebcam}`}
                className="webcam-fullscreen-video"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )}

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

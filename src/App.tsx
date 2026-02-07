/**
 * @fileoverview Main React application component for the Claude Code web terminal.
 *
 * Provides a browser-based terminal interface to interact with Claude Code CLI,
 * with additional features for server log viewing and webcam streaming.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import { initClientTelemetry, reportWsReconnect } from './telemetry'

/**
 * Counter for generating unique message IDs.
 * Uses timestamp + counter instead of crypto.randomUUID for mobile HTTPS compatibility.
 */
let idCounter = 0

/** Generates a unique message ID combining timestamp and incrementing counter. */
const generateId = () => `msg-${Date.now()}-${++idCounter}`

/** Custom component overrides for ReactMarkdown to open links in new tabs. */
const markdownComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="terminal-link" {...props}>
      {children}
    </a>
  ),
}

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
  /** Dashboard project ID, if matched to a known project. */
  projectId: string | null
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

/** An image pending upload alongside a command. */
interface PendingImage {
  id: string
  data: string  // base64 data (without data URL prefix)
  name: string  // generated filename
  preview: string  // data URL for display
}

/** State for a single terminal tab (one per active project). */
interface TerminalTabState {
  id: string                    // unique tab ID, e.g. `tab-${projectId}`
  projectId: string
  projectName: string
  workingDirectory: string
  messages: Message[]
  sessionId: string | null
  lastMessageId: number
  status: ConnectionStatus
  currentTool: string | null
  pendingImages: PendingImage[]
}

/** Serializable subset of TerminalTabState for localStorage persistence. */
interface StoredTerminalTab {
  id: string
  projectId: string
  projectName: string
  workingDirectory: string
  sessionId: string | null
}

/** WebSocket connection and processing state. */
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'processing' | 'restarting'

/** Currently active UI tab. */
type Section = 'briefing' | 'crm' | 'diagnostics' | 'hardware' | 'recitations' | 'research' | 'terminal' | 'todo'
type TerminalTab = 'terminal' | 'projects' | 'conversations'
type HardwareTab = 'webcams'
type DiagnosticsTab = 'logs' | 'client-perf' | 'server-perf'
type CrmTab = 'contacts'
type TodoTab = 'todos'
type BriefingTab = 'briefing-editor'
type RecitationsTab = 'recitations-editor'
type ResearchTab = 'topics'
type SubTab = TerminalTab | HardwareTab | DiagnosticsTab | CrmTab | TodoTab | BriefingTab | RecitationsTab | ResearchTab

// Keep alphabetized by section key
const SECTION_TABS: Record<Section, SubTab[]> = {
  briefing: ['briefing-editor'],
  crm: ['contacts'],
  diagnostics: ['logs', 'client-perf', 'server-perf'],
  hardware: ['webcams'],
  recitations: ['recitations-editor'],
  research: ['topics'],
  terminal: ['terminal', 'projects', 'conversations'],
  todo: ['todos'],
}

// Keep alphabetized by display label
const SUB_TAB_LABELS: Record<SubTab, string> = {
  'client-perf': 'Client Performance',
  contacts: 'Contacts',
  conversations: 'Conversations',
  'briefing-editor': 'Prompt Editor',
  projects: 'Projects',
  'recitations-editor': 'Recitations',
  'server-perf': 'Server Performance',
  topics: 'Topics',
  logs: 'Server Logs',
  terminal: 'Terminal',
  todos: 'Todos',
  webcams: 'Webcams',
}

// Keep sidebar sections alphabetized by display label
const SECTION_LABELS: Record<Section, string> = {
  briefing: 'Daily Briefing',
  diagnostics: 'Diagnostics',
  crm: 'Friend CRM',
  hardware: 'Hardware',
  recitations: 'Recitations',
  research: 'Research',
  terminal: 'Terminal',
  todo: 'TODO List',
}

/** Represents a CRM contact. */
interface CrmContact {
  id: string
  name: string
  email: string | null
  phone: string | null
  socialHandles: string | null
  createdAt: string
  updatedAt: string
  lastInteraction: string | null
  interactionCount: number
}

/** Represents a CRM interaction log entry. */
interface CrmInteraction {
  id: string
  contactId: string
  note: string
  occurredAt: string
  createdAt: string
}

/** Represents a todo item. */
interface TodoItem {
  id: string
  description: string
  createdAt: string
  done: boolean
}

/** Represents a recitation item. */
interface RecitationItem {
  id: string
  title: string
  content: string | null
  createdAt: string
}

/** A research topic. */
interface ResearchTopic {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

/** A research article belonging to a topic. */
interface ResearchArticle {
  id: string
  topicId: string
  title: string
  content: string
  createdAt: string
}

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
  // Multi-terminal tab state
  const [terminalTabs, setTerminalTabs] = useState<TerminalTabState[]>([])
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [wsConnected, setWsConnected] = useState(false)

  // Server logs state
  const [logMessages, setLogMessages] = useState<LogMessage[]>([])
  const [logLevelFilter, setLogLevelFilter] = useState<'error' | 'warn' | 'info'>('error')

  // Session sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [filterByProject, setFilterByProject] = useState(true)

  // UI state
  const [activeSection, setActiveSection] = useState<Section>('terminal')
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('terminal')
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [showLogsScrollButton, setShowLogsScrollButton] = useState(false)

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
  const [newProjectPath, setNewProjectPath] = useState('')
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectConversations, setProjectConversations] = useState<Session[]>([])
  const [loadingProjectConversations, setLoadingProjectConversations] = useState(false)

  // CRM state
  const [crmContacts, setCrmContacts] = useState<CrmContact[]>([])
  const [selectedContact, setSelectedContact] = useState<CrmContact | null>(null)
  const [contactInteractions, setContactInteractions] = useState<CrmInteraction[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [loadingInteractions, setLoadingInteractions] = useState(false)
  const [showAddContact, setShowAddContact] = useState(false)
  const [editingContact, setEditingContact] = useState<CrmContact | null>(null)
  const [newContactName, setNewContactName] = useState('')
  const [newContactEmail, setNewContactEmail] = useState('')
  const [newContactPhone, setNewContactPhone] = useState('')
  const [newContactSocial, setNewContactSocial] = useState('')
  const [newInteractionNote, setNewInteractionNote] = useState('')
  const [newInteractionDate, setNewInteractionDate] = useState(() => new Date().toISOString().split('T')[0])

  // Todo state
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [newTodoDescription, setNewTodoDescription] = useState('')
  const [loadingTodos, setLoadingTodos] = useState(false)

  // Recitations state
  const [recitations, setRecitations] = useState<RecitationItem[]>([])
  const [newRecitationTitle, setNewRecitationTitle] = useState('')
  const [newRecitationContent, setNewRecitationContent] = useState('')
  const [editingRecitation, setEditingRecitation] = useState<RecitationItem | null>(null)
  const [editRecitationTitle, setEditRecitationTitle] = useState('')
  const [editRecitationContent, setEditRecitationContent] = useState('')
  const [loadingRecitations, setLoadingRecitations] = useState(false)

  // Research state
  const [topics, setTopics] = useState<ResearchTopic[]>([])
  const [newTopicName, setNewTopicName] = useState('')
  const [newTopicDescription, setNewTopicDescription] = useState('')
  const [editingTopic, setEditingTopic] = useState<ResearchTopic | null>(null)
  const [editTopicName, setEditTopicName] = useState('')
  const [editTopicDescription, setEditTopicDescription] = useState('')
  const [loadingTopics, setLoadingTopics] = useState(false)
  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(null)
  const [topicArticles, setTopicArticles] = useState<Record<string, ResearchArticle[]>>({})

  // Daily briefing state
  const [briefingPrompt, setBriefingPrompt] = useState('')
  const [briefingPromptDraft, setBriefingPromptDraft] = useState('')
  const [loadingBriefingPrompt, setLoadingBriefingPrompt] = useState(false)
  const [savingBriefingPrompt, setSavingBriefingPrompt] = useState(false)
  const [sendingTestBriefing, setSendingTestBriefing] = useState(false)
  const [briefingStatus, setBriefingStatus] = useState<string | null>(null)
  const [briefingPreviewHtml, setBriefingPreviewHtml] = useState<string | null>(null)
  const [briefingPreviewGeneratedAt, setBriefingPreviewGeneratedAt] = useState<string | null>(null)
  const [generatingPreview, setGeneratingPreview] = useState(false)
  const [briefingProgressSteps, setBriefingProgressSteps] = useState<string[]>([])

  // Refs for mutable values that shouldn't trigger re-renders
  const isRestartingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const webcamWsRef = useRef<WebSocket | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const logsOutputRef = useRef<HTMLDivElement>(null)
  const webcamsContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const webcamReconnectTimeoutRef = useRef<number | null>(null)
  const previousActiveWebcamsRef = useRef<Set<string>>(new Set())
  const changingResolutionRef = useRef<Set<string>>(new Set())
  const terminalTabsRef = useRef<TerminalTabState[]>([])
  const activeTerminalTabIdRef = useRef<string | null>(null)
  const fullscreenOverlayRef = useRef<HTMLDivElement>(null)
  const fullscreenImgRef = useRef<HTMLImageElement>(null)
  const pinchStateRef = useRef({
    startDist: 0, startScale: 1, lastScale: 1,
    translateX: 0, translateY: 0,
    startMidX: 0, startMidY: 0,
    isPinching: false, isPanning: false,
    panStartX: 0, panStartY: 0,
  })

  // Keep refs in sync
  useEffect(() => {
    terminalTabsRef.current = terminalTabs
  }, [terminalTabs])
  useEffect(() => {
    activeTerminalTabIdRef.current = activeTerminalTabId
  }, [activeTerminalTabId])

  /** Derived: the currently active terminal tab. */
  const activeTerminalTab = useMemo(() =>
    terminalTabs.find(t => t.id === activeTerminalTabId) || null,
    [terminalTabs, activeTerminalTabId]
  )

  /** Persists current terminal tabs to localStorage. */
  const persistTabs = useCallback((tabs: TerminalTabState[], activeId: string | null) => {
    const stored: StoredTerminalTab[] = tabs.map(t => ({
      id: t.id,
      projectId: t.projectId,
      projectName: t.projectName,
      workingDirectory: t.workingDirectory,
      sessionId: t.sessionId,
    }))
    localStorage.setItem('terminalTabs', JSON.stringify(stored))
    if (activeId) {
      localStorage.setItem('activeTerminalTabId', activeId)
    } else {
      localStorage.removeItem('activeTerminalTabId')
    }
  }, [])

  /** Updates a specific tab's state by ID. */
  const updateTab = useCallback((tabId: string, updates: Partial<TerminalTabState>) => {
    setTerminalTabs(prev => {
      const next = prev.map(tab =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
      return next
    })
  }, [])

  /** Appends a message to a specific tab. */
  const addTabMessage = useCallback((tabId: string, type: Message['type'], content: string) => {
    const message: Message = {
      id: generateId(),
      type,
      content,
      timestamp: new Date(),
    }
    setTerminalTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, messages: [...tab.messages, message] } : tab
    ))
  }, [])

  /** Adds a new message to the terminal output (legacy - adds to active tab). */
  const addMessage = useCallback((type: Message['type'], content: string) => {
    // Used by non-tab-specific code (sidebar grafana restart, etc.)
    // These status messages are logged to console but don't go to a specific tab
    console.log(`[App] ${type}: ${content}`)
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
   * Handles reconnection and session resumption for all open tabs.
   */
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    setWsConnected(false)

    // Use current hostname for Tailscale compatibility
    const wsUrl = `ws://${window.location.hostname}:4001`
    console.log('[WS] Connecting to:', wsUrl)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = async () => {
      console.log('[WS] Connected')
      setWsConnected(true)

      // Resume all open tabs' sessions
      const tabs = terminalTabsRef.current
      for (const tab of tabs) {
        if (tab.sessionId) {
          console.log(`[WS] Resuming tab ${tab.id} session ${tab.sessionId}`)
          ws.send(JSON.stringify({
            type: 'resume',
            sessionId: tab.sessionId,
            workingDirectory: tab.workingDirectory,
            tabId: tab.id,
          }))

          // Fetch full conversation history for each tab
          const needsHistoryReload = tab.lastMessageId === 0
          if (needsHistoryReload) {
            try {
              const res = await fetch(`http://${window.location.hostname}:4001/sessions/${tab.sessionId}/history`)
              const history: Array<{ type: 'input' | 'output' | 'error' | 'status'; content: string; timestamp: string }> = await res.json()
              const restoredMessages: Message[] = history.map(msg => ({
                id: generateId(),
                type: msg.type,
                content: msg.content,
                timestamp: new Date(msg.timestamp),
              }))
              updateTab(tab.id, { messages: restoredMessages, status: 'connected' })
              addTabMessage(tab.id, 'status', `Restored conversation with ${history.length} messages`)
            } catch (err) {
              console.error(`Failed to fetch history for tab ${tab.id}:`, err)
              addTabMessage(tab.id, 'status', `Resumed conversation: ${tab.sessionId!.slice(0, 8)}...`)
            }
          } else {
            // Fetch missed messages
            try {
              const res = await fetch(
                `http://${window.location.hostname}:4001/sessions/${tab.sessionId}/messages?since=${tab.lastMessageId}`
              )
              const data: { messages: BufferedMessage[]; latestId: number } = await res.json()
              if (data.messages.length > 0) {
                for (const msg of data.messages) {
                  if (msg.type === 'output' || msg.type === 'error') {
                    addTabMessage(tab.id, msg.type, msg.content)
                  } else if (msg.type === 'complete') {
                    updateTab(tab.id, { status: 'connected', currentTool: null })
                  }
                }
                updateTab(tab.id, { lastMessageId: data.latestId })
                addTabMessage(tab.id, 'status', `Reconnected and fetched ${data.messages.length} missed message(s)`)
              }
            } catch (err) {
              console.error(`Failed to fetch missed messages for tab ${tab.id}:`, err)
            }
          }
        }
      }
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // Global messages (no tabId) - logs, briefing-progress, global status
        if (!data.tabId) {
          switch (data.type) {
            case 'log':
              addLogMessage(data.level, data.content, data.timestamp)
              break
            case 'briefing-progress':
              setBriefingProgressSteps(prev => [...prev, data.content])
              break
            case 'status':
              if (data.content === 'connected') {
                setWsConnected(true)
              } else if (data.content === 'restarting') {
                // Mark all tabs as restarting
                setTerminalTabs(prev => prev.map(tab => ({ ...tab, status: 'restarting' as ConnectionStatus })))
              }
              break
          }
          return
        }

        // Per-tab messages
        const tabId = data.tabId as string

        // Track message ID if present (for reconnection support)
        if (data.id && typeof data.id === 'number') {
          updateTab(tabId, { lastMessageId: data.id })
        }

        switch (data.type) {
          case 'output':
            addTabMessage(tabId, 'output', data.content)
            break
          case 'error':
            addTabMessage(tabId, 'error', data.content)
            break
          case 'status':
            if (data.content === 'processing') {
              updateTab(tabId, { status: 'processing' })
            } else if (data.content === 'connected' || data.content === 'resumed') {
              updateTab(tabId, { status: 'connected' })
            } else if (data.content === 'clear') {
              updateTab(tabId, { messages: [] })
            } else if (data.content === 'reset') {
              updateTab(tabId, { messages: [], sessionId: null, lastMessageId: 0, currentTool: null, status: 'connected' })
            }
            break
          case 'complete':
            updateTab(tabId, { status: 'connected', currentTool: null })
            break
          case 'tool':
            updateTab(tabId, { currentTool: data.content })
            break
          case 'session':
            updateTab(tabId, { sessionId: data.content })
            // Persist updated tabs to localStorage
            setTerminalTabs(prev => {
              const updated = prev.map(tab =>
                tab.id === tabId ? { ...tab, sessionId: data.content } : tab
              )
              persistTabs(updated, activeTerminalTabIdRef.current)
              return updated
            })
            addTabMessage(tabId, 'status', `Conversation: ${data.content}`)
            break
        }
      } catch {
        console.error('[WS] Failed to parse message:', event.data)
      }
    }

    ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason)
      wsRef.current = null
      setWsConnected(false)

      // Don't auto-reconnect if we're restarting - the page will reload
      if (isRestartingRef.current) {
        console.log('[WS] Skipping auto-reconnect during restart')
        return
      }

      // Mark all tabs as disconnected
      setTerminalTabs(prev => prev.map(tab => ({ ...tab, status: 'disconnected' as ConnectionStatus })))

      // Auto-reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        reportWsReconnect()
        connect()
      }, 3000)
    }

    ws.onerror = (event) => {
      console.error('[WS] Error:', event)
    }
  }, [addLogMessage, updateTab, addTabMessage, persistTabs])

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

    const wsUrl = `ws://${window.location.hostname}:4002`
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
          case 'webcam-log':
            addLogMessage(data.level, `[Webcam] ${data.content}`, data.timestamp)
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
  }, [addLogMessage])

  /** Fetches available sessions from the REST API for the sidebar. */
  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/sessions`
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
      const apiUrl = `http://${window.location.hostname}:4001/projects`
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
      const apiUrl = `http://${window.location.hostname}:4001/projects`
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
      const apiUrl = `http://${window.location.hostname}:4001/projects/${projectId}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        // Close the terminal tab if this project is open
        const tabId = `tab-${projectId}`
        if (terminalTabsRef.current.some(t => t.id === tabId)) {
          wsRef.current?.send(JSON.stringify({ type: 'tab-close', tabId }))
          setTerminalTabs(prev => {
            const next = prev.filter(t => t.id !== tabId)
            setActiveTerminalTabId(current => {
              if (current === tabId) {
                if (next.length > 0) {
                  persistTabs(next, next[next.length - 1].id)
                  return next[next.length - 1].id
                }
                persistTabs(next, null)
                setActiveSubTab('projects')
                return null
              }
              persistTabs(next, current)
              return current
            })
            return next
          })
        }
        await fetchProjects()
      }
    } catch (error) {
      console.error('Failed to remove project:', error)
    }
  }, [fetchProjects, persistTabs])

  /** Fetches conversations for a specific project. */
  const fetchProjectConversations = useCallback(async (projectId: string) => {
    setLoadingProjectConversations(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/projects/${projectId}/conversations`
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

  // --- Todo data fetching ---

  /** Fetches all todos from the API. */
  const fetchTodos = useCallback(async () => {
    setLoadingTodos(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/todos`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setTodos(data)
      }
    } catch (error) {
      console.error('Failed to fetch todos:', error)
    } finally {
      setLoadingTodos(false)
    }
  }, [])

  /** Creates a new todo. */
  const handleCreateTodo = useCallback(async () => {
    if (!newTodoDescription.trim()) return
    try {
      const apiUrl = `http://${window.location.hostname}:4001/todos`
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: newTodoDescription.trim() }),
      })
      if (response.ok) {
        setNewTodoDescription('')
        fetchTodos()
      }
    } catch (error) {
      console.error('Failed to create todo:', error)
    }
  }, [newTodoDescription, fetchTodos])

  /** Toggles a todo's done status. */
  const handleToggleTodo = useCallback(async (id: string, done: boolean) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/todos/${id}`
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      })
      if (response.ok) {
        fetchTodos()
      }
    } catch (error) {
      console.error('Failed to toggle todo:', error)
    }
  }, [fetchTodos])

  /** Deletes a todo. */
  const handleDeleteTodo = useCallback(async (id: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/todos/${id}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        fetchTodos()
      }
    } catch (error) {
      console.error('Failed to delete todo:', error)
    }
  }, [fetchTodos])

  // --- Recitations data fetching ---

  /** Fetches all recitations from the server. */
  const fetchRecitations = useCallback(async () => {
    setLoadingRecitations(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/recitations`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setRecitations(data)
      }
    } catch (error) {
      console.error('Failed to fetch recitations:', error)
    } finally {
      setLoadingRecitations(false)
    }
  }, [])

  /** Creates a new recitation. */
  const handleCreateRecitation = useCallback(async () => {
    if (!newRecitationTitle.trim()) return
    try {
      const apiUrl = `http://${window.location.hostname}:4001/recitations`
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newRecitationTitle.trim(),
          content: newRecitationContent.trim() || undefined,
        }),
      })
      if (response.ok) {
        setNewRecitationTitle('')
        setNewRecitationContent('')
        fetchRecitations()
      }
    } catch (error) {
      console.error('Failed to create recitation:', error)
    }
  }, [newRecitationTitle, newRecitationContent, fetchRecitations])

  /** Saves edits to an existing recitation. */
  const handleUpdateRecitation = useCallback(async () => {
    if (!editingRecitation || !editRecitationTitle.trim()) return
    try {
      const apiUrl = `http://${window.location.hostname}:4001/recitations/${editingRecitation.id}`
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editRecitationTitle.trim(),
          content: editRecitationContent.trim() || null,
        }),
      })
      if (response.ok) {
        setEditingRecitation(null)
        setEditRecitationTitle('')
        setEditRecitationContent('')
        fetchRecitations()
      }
    } catch (error) {
      console.error('Failed to update recitation:', error)
    }
  }, [editingRecitation, editRecitationTitle, editRecitationContent, fetchRecitations])

  /** Deletes a recitation. */
  const handleDeleteRecitation = useCallback(async (id: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/recitations/${id}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        if (editingRecitation?.id === id) {
          setEditingRecitation(null)
        }
        fetchRecitations()
      }
    } catch (error) {
      console.error('Failed to delete recitation:', error)
    }
  }, [editingRecitation, fetchRecitations])

  /** Starts editing a recitation. */
  const handleStartEditRecitation = useCallback((recitation: RecitationItem) => {
    setEditingRecitation(recitation)
    setEditRecitationTitle(recitation.title)
    setEditRecitationContent(recitation.content || '')
  }, [])

  /** Cancels editing a recitation. */
  const handleCancelEditRecitation = useCallback(() => {
    setEditingRecitation(null)
    setEditRecitationTitle('')
    setEditRecitationContent('')
  }, [])

  // --- Research data fetching ---

  const fetchTopics = useCallback(async () => {
    setLoadingTopics(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/research/topics`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setTopics(data)
      }
    } catch (error) {
      console.error('Failed to fetch topics:', error)
    } finally {
      setLoadingTopics(false)
    }
  }, [])

  const fetchArticlesForTopic = useCallback(async (topicId: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/research/topics/${topicId}/articles`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setTopicArticles(prev => ({ ...prev, [topicId]: data }))
      }
    } catch (error) {
      console.error('Failed to fetch articles:', error)
    }
  }, [])

  const handleCreateTopic = useCallback(async () => {
    if (!newTopicName.trim()) return
    try {
      const apiUrl = `http://${window.location.hostname}:4001/research/topics`
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTopicName.trim(),
          description: newTopicDescription.trim() || undefined,
        }),
      })
      if (response.ok) {
        setNewTopicName('')
        setNewTopicDescription('')
        fetchTopics()
      }
    } catch (error) {
      console.error('Failed to create topic:', error)
    }
  }, [newTopicName, newTopicDescription, fetchTopics])

  const handleUpdateTopic = useCallback(async () => {
    if (!editingTopic || !editTopicName.trim()) return
    try {
      const apiUrl = `http://${window.location.hostname}:4001/research/topics/${editingTopic.id}`
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editTopicName.trim(),
          description: editTopicDescription.trim() || null,
        }),
      })
      if (response.ok) {
        setEditingTopic(null)
        setEditTopicName('')
        setEditTopicDescription('')
        fetchTopics()
      }
    } catch (error) {
      console.error('Failed to update topic:', error)
    }
  }, [editingTopic, editTopicName, editTopicDescription, fetchTopics])

  const handleDeleteTopic = useCallback(async (id: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/research/topics/${id}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        if (editingTopic?.id === id) {
          setEditingTopic(null)
        }
        if (expandedTopicId === id) {
          setExpandedTopicId(null)
        }
        fetchTopics()
      }
    } catch (error) {
      console.error('Failed to delete topic:', error)
    }
  }, [editingTopic, expandedTopicId, fetchTopics])

  const handleStartEditTopic = useCallback((topic: ResearchTopic) => {
    setEditingTopic(topic)
    setEditTopicName(topic.name)
    setEditTopicDescription(topic.description || '')
  }, [])

  const handleCancelEditTopic = useCallback(() => {
    setEditingTopic(null)
    setEditTopicName('')
    setEditTopicDescription('')
  }, [])

  const handleToggleTopicArticles = useCallback(async (topicId: string) => {
    if (expandedTopicId === topicId) {
      setExpandedTopicId(null)
    } else {
      setExpandedTopicId(topicId)
      await fetchArticlesForTopic(topicId)
    }
  }, [expandedTopicId, fetchArticlesForTopic])

  const handleDeleteArticle = useCallback(async (articleId: string, topicId: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/research/articles/${articleId}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        await fetchArticlesForTopic(topicId)
      }
    } catch (error) {
      console.error('Failed to delete article:', error)
    }
  }, [fetchArticlesForTopic])

  // --- Daily briefing data fetching ---

  /** Fetches the current briefing prompt. */
  const fetchBriefingPrompt = useCallback(async () => {
    setLoadingBriefingPrompt(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/briefing/prompt`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setBriefingPrompt(data.prompt)
        setBriefingPromptDraft(data.prompt)
      }
    } catch (error) {
      console.error('Failed to fetch briefing prompt:', error)
    } finally {
      setLoadingBriefingPrompt(false)
    }
  }, [])

  /** Fetches the latest saved briefing (if any). */
  const fetchLatestBriefing = useCallback(async () => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/briefing/latest`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setBriefingPreviewHtml(data.html)
        setBriefingPreviewGeneratedAt(data.createdAt)
      }
    } catch {
      // No saved briefing, that's fine
    }
  }, [])

  /** Saves the briefing prompt. */
  const handleSaveBriefingPrompt = useCallback(async () => {
    setSavingBriefingPrompt(true)
    setBriefingStatus(null)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/briefing/prompt`
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: briefingPromptDraft }),
      })
      if (response.ok) {
        setBriefingPrompt(briefingPromptDraft)
        setBriefingStatus('Prompt saved')
        setTimeout(() => setBriefingStatus(null), 3000)
      }
    } catch (error) {
      console.error('Failed to save briefing prompt:', error)
      setBriefingStatus('Failed to save')
      setTimeout(() => setBriefingStatus(null), 3000)
    } finally {
      setSavingBriefingPrompt(false)
    }
  }, [briefingPromptDraft])

  /** Sends a test briefing email. */
  const handleSendTestBriefing = useCallback(async () => {
    setSendingTestBriefing(true)
    setBriefingStatus(null)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/briefing/send-test`
      const response = await fetch(apiUrl, { method: 'POST' })
      if (response.ok) {
        setBriefingStatus('Test email sent')
        setTimeout(() => setBriefingStatus(null), 3000)
      } else {
        setBriefingStatus('Failed to send test email')
        setTimeout(() => setBriefingStatus(null), 3000)
      }
    } catch (error) {
      console.error('Failed to send test briefing:', error)
      setBriefingStatus('Failed to send test email')
      setTimeout(() => setBriefingStatus(null), 3000)
    } finally {
      setSendingTestBriefing(false)
    }
  }, [])

  /** Generates a briefing preview without sending email. */
  const handleGeneratePreview = useCallback(async () => {
    setGeneratingPreview(true)
    setBriefingStatus(null)
    setBriefingPreviewHtml(null)
    setBriefingProgressSteps([])
    try {
      const apiUrl = `http://${window.location.hostname}:4001/briefing/generate`
      const response = await fetch(apiUrl, { method: 'POST' })
      if (response.ok) {
        const data = await response.json()
        setBriefingPreviewHtml(data.html)
        setBriefingPreviewGeneratedAt(data.createdAt)
      } else {
        setBriefingStatus('Failed to generate preview')
        setTimeout(() => setBriefingStatus(null), 3000)
      }
    } catch (error) {
      console.error('Failed to generate briefing preview:', error)
      setBriefingStatus('Failed to generate preview')
      setTimeout(() => setBriefingStatus(null), 3000)
    } finally {
      setGeneratingPreview(false)
    }
  }, [])

  // --- CRM data fetching ---

  /** Fetches all contacts from the CRM API. */
  const fetchContacts = useCallback(async () => {
    setLoadingContacts(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/contacts`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setCrmContacts(data)
      }
    } catch (error) {
      console.error('Failed to fetch contacts:', error)
    } finally {
      setLoadingContacts(false)
    }
  }, [])

  /** Fetches interactions for a specific contact. */
  const fetchInteractions = useCallback(async (contactId: string) => {
    setLoadingInteractions(true)
    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/contacts/${contactId}/interactions`
      const response = await fetch(apiUrl)
      if (response.ok) {
        const data = await response.json()
        setContactInteractions(data)
      }
    } catch (error) {
      console.error('Failed to fetch interactions:', error)
    } finally {
      setLoadingInteractions(false)
    }
  }, [])

  /** Creates a new contact. */
  const handleCreateContact = useCallback(async () => {
    const name = newContactName.trim()
    if (!name) return

    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/contacts`
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email: newContactEmail.trim() || null,
          phone: newContactPhone.trim() || null,
          socialHandles: newContactSocial.trim() || null,
        }),
      })
      if (response.ok) {
        setNewContactName('')
        setNewContactEmail('')
        setNewContactPhone('')
        setNewContactSocial('')
        setShowAddContact(false)
        await fetchContacts()
      }
    } catch (error) {
      console.error('Failed to create contact:', error)
    }
  }, [newContactName, newContactEmail, newContactPhone, newContactSocial, fetchContacts])

  /** Updates an existing contact. */
  const handleUpdateContact = useCallback(async () => {
    if (!editingContact) return
    const name = newContactName.trim()
    if (!name) return

    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/contacts/${editingContact.id}`
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email: newContactEmail.trim() || null,
          phone: newContactPhone.trim() || null,
          socialHandles: newContactSocial.trim() || null,
        }),
      })
      if (response.ok) {
        const updated = await response.json()
        setSelectedContact(updated)
        setEditingContact(null)
        setNewContactName('')
        setNewContactEmail('')
        setNewContactPhone('')
        setNewContactSocial('')
        await fetchContacts()
      }
    } catch (error) {
      console.error('Failed to update contact:', error)
    }
  }, [editingContact, newContactName, newContactEmail, newContactPhone, newContactSocial, fetchContacts])

  /** Deletes a contact. */
  const handleDeleteContact = useCallback(async (contactId: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/contacts/${contactId}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        setSelectedContact(null)
        await fetchContacts()
      }
    } catch (error) {
      console.error('Failed to delete contact:', error)
    }
  }, [fetchContacts])

  /** Logs a new interaction for a contact. */
  const handleLogInteraction = useCallback(async (contactId: string) => {
    const note = newInteractionNote.trim()
    if (!note) return

    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/contacts/${contactId}/interactions`
      const body: { note: string; occurredAt?: string } = { note }
      if (newInteractionDate) body.occurredAt = new Date(newInteractionDate).toISOString()
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        setNewInteractionNote('')
        setNewInteractionDate(new Date().toISOString().split('T')[0])
        await fetchInteractions(contactId)
        await fetchContacts() // Refresh staleness info
      }
    } catch (error) {
      console.error('Failed to log interaction:', error)
    }
  }, [newInteractionNote, newInteractionDate, fetchInteractions, fetchContacts])

  /** Deletes an interaction. */
  const handleDeleteInteraction = useCallback(async (interactionId: string, contactId: string) => {
    try {
      const apiUrl = `http://${window.location.hostname}:4001/crm/interactions/${interactionId}`
      const response = await fetch(apiUrl, { method: 'DELETE' })
      if (response.ok) {
        await fetchInteractions(contactId)
        await fetchContacts() // Refresh staleness info
      }
    } catch (error) {
      console.error('Failed to delete interaction:', error)
    }
  }, [fetchInteractions, fetchContacts])

  /** Opens the edit form for a contact. */
  const handleStartEdit = useCallback((contact: CrmContact) => {
    setEditingContact(contact)
    setNewContactName(contact.name)
    setNewContactEmail(contact.email || '')
    setNewContactPhone(contact.phone || '')
    setNewContactSocial(contact.socialHandles || '')
  }, [])

  /** Cancels editing or adding a contact. */
  const handleCancelContactForm = useCallback(() => {
    setShowAddContact(false)
    setEditingContact(null)
    setNewContactName('')
    setNewContactEmail('')
    setNewContactPhone('')
    setNewContactSocial('')
  }, [])

  /** Returns staleness level based on last interaction date. */
  const getStaleness = useCallback((lastInteraction: string | null): 'fresh' | 'stale' | 'very-stale' => {
    if (!lastInteraction) return 'very-stale'
    const daysSince = Math.floor((Date.now() - new Date(lastInteraction).getTime()) / 86400000)
    if (daysSince < 7) return 'fresh'
    if (daysSince < 30) return 'stale'
    return 'very-stale'
  }, [])

  /** Activates a project: opens a new terminal tab for it (or switches to existing). */
  const handleActivateProject = useCallback(async (project: Project) => {
    const tabId = `tab-${project.id}`

    // Check if tab already exists - just switch to it
    const existing = terminalTabsRef.current.find(t => t.id === tabId)
    if (existing) {
      setActiveTerminalTabId(tabId)
      setActiveSubTab('terminal')
      return
    }

    // Create new tab
    const newTab: TerminalTabState = {
      id: tabId,
      projectId: project.id,
      projectName: project.name,
      workingDirectory: project.directory,
      messages: [],
      sessionId: project.lastConversationId || null,
      lastMessageId: 0,
      status: 'connected',
      currentTool: null,
      pendingImages: [],
    }

    setTerminalTabs(prev => {
      const next = [...prev, newTab]
      persistTabs(next, tabId)
      return next
    })
    setActiveTerminalTabId(tabId)
    setActiveSubTab('terminal')

    // Resume last conversation if exists
    if (project.lastConversationId) {
      wsRef.current?.send(JSON.stringify({
        type: 'resume',
        sessionId: project.lastConversationId,
        workingDirectory: project.directory,
        tabId,
      }))

      // Fetch and restore conversation history
      try {
        const res = await fetch(`http://${window.location.hostname}:4001/sessions/${project.lastConversationId}/history`)
        const history: Array<{ type: 'input' | 'output' | 'error' | 'status'; content: string; timestamp: string }> = await res.json()
        const restoredMessages: Message[] = history.map(msg => ({
          id: generateId(),
          type: msg.type,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
        }))
        updateTab(tabId, { messages: restoredMessages })
        addTabMessage(tabId, 'status', `Opened project: ${project.name}`)
      } catch (err) {
        console.error('Failed to fetch conversation history:', err)
        addTabMessage(tabId, 'status', `Opened project: ${project.name}`)
      }
    } else {
      addTabMessage(tabId, 'status', `Opened project: ${project.name} (new conversation)`)
    }
  }, [updateTab, addTabMessage, persistTabs])

  /** Closes a terminal tab and cleans up server resources. */
  const closeTerminalTab = useCallback((tabId: string) => {
    // Send tab-close to server
    wsRef.current?.send(JSON.stringify({ type: 'tab-close', tabId }))

    setTerminalTabs(prev => {
      const next = prev.filter(t => t.id !== tabId)
      // If this was the active tab, switch to another or go to projects
      setActiveTerminalTabId(current => {
        if (current === tabId) {
          if (next.length > 0) {
            const newActive = next[next.length - 1].id
            persistTabs(next, newActive)
            return newActive
          }
          persistTabs(next, null)
          setActiveSubTab('projects')
          return null
        }
        persistTabs(next, current)
        return current
      })
      return next
    })
  }, [persistTabs])

  useEffect(() => {
    initClientTelemetry()
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

  // Fetch sessions when conversations tab is active
  useEffect(() => {
    if (activeSubTab === 'conversations') {
      fetchSessions()
    }
  }, [activeSubTab, fetchSessions])

  // Restore terminal tabs from localStorage on mount
  useEffect(() => {
    const storedJson = localStorage.getItem('terminalTabs')
    const storedActiveId = localStorage.getItem('activeTerminalTabId')
    if (storedJson) {
      try {
        const stored: StoredTerminalTab[] = JSON.parse(storedJson)
        const restored: TerminalTabState[] = stored.map(s => ({
          id: s.id,
          projectId: s.projectId,
          projectName: s.projectName,
          workingDirectory: s.workingDirectory,
          messages: [],
          sessionId: s.sessionId,
          lastMessageId: 0,
          status: 'connected' as ConnectionStatus,
          currentTool: null,
          pendingImages: [],
        }))
        setTerminalTabs(restored)
        terminalTabsRef.current = restored
        if (storedActiveId && restored.find(t => t.id === storedActiveId)) {
          setActiveTerminalTabId(storedActiveId)
          setActiveSubTab('terminal')
        } else if (restored.length > 0) {
          setActiveTerminalTabId(restored[0].id)
          setActiveSubTab('terminal')
        }
      } catch {
        // Ignore invalid stored data
      }
    } else {
      // Migration: check for old activeProjectId format
      const oldProjectId = localStorage.getItem('activeProjectId')
      if (oldProjectId) {
        localStorage.removeItem('activeProjectId')
        localStorage.removeItem('currentSessionId')
        // Will be restored when projects load via fetchProjects
      }
    }
  }, [])

  // Fetch projects on mount
  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // Fetch projects and conversations when projects tab is active
  useEffect(() => {
    if (activeSubTab === 'projects') {
      fetchProjects()
    }
  }, [activeSubTab, fetchProjects])

  // Fetch conversations when viewing projects tab and a project tab is selected
  useEffect(() => {
    if (activeTerminalTab && activeSubTab === 'projects') {
      fetchProjectConversations(activeTerminalTab.projectId)
    }
  }, [activeTerminalTab, activeSubTab, fetchProjectConversations])

  // Fetch briefing prompt and saved preview when briefing tab is active
  useEffect(() => {
    if (activeSubTab === 'briefing-editor') {
      fetchBriefingPrompt()
      fetchLatestBriefing()
    }
  }, [activeSubTab, fetchBriefingPrompt, fetchLatestBriefing])

  // Fetch todos when todo tab is active
  useEffect(() => {
    if (activeSubTab === 'todos') {
      fetchTodos()
    }
  }, [activeSubTab, fetchTodos])

  // Fetch recitations when recitations tab is active
  useEffect(() => {
    if (activeSubTab === 'recitations-editor') {
      fetchRecitations()
    }
  }, [activeSubTab, fetchRecitations])

  // Fetch topics when research tab is active
  useEffect(() => {
    if (activeSubTab === 'topics') {
      fetchTopics()
    }
  }, [activeSubTab, fetchTopics])

  // Fetch contacts when CRM tab is active
  useEffect(() => {
    if (activeSubTab === 'contacts') {
      fetchContacts()
    }
  }, [activeSubTab, fetchContacts])

  // Keep selectedContact in sync with the contacts list (e.g. after interaction count changes)
  useEffect(() => {
    if (selectedContact) {
      const updated = crmContacts.find(c => c.id === selectedContact.id)
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedContact)) {
        setSelectedContact(updated)
      }
    }
  }, [crmContacts])

  // Fetch interactions when a contact is selected
  useEffect(() => {
    if (selectedContact) {
      fetchInteractions(selectedContact.id)
    } else {
      setContactInteractions([])
    }
  }, [selectedContact, fetchInteractions])

  // Active tab's messages for convenience
  const activeTabMessages = activeTerminalTab?.messages || []

  // Index of the message that should get the gold "ready" highlight.
  const readyMessageIndex = useMemo(() => {
    const lastOutput = activeTabMessages.findLastIndex(m => m.type === 'output')
    if (lastOutput !== -1) return lastOutput
    for (let i = activeTabMessages.length - 1; i >= 0; i--) {
      if (activeTabMessages[i].type !== 'status') return i
    }
    return activeTabMessages.length - 1
  }, [activeTabMessages])

  // Auto-scroll to bottom for terminal messages
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [activeTabMessages])

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
    if (!activeTerminalTab) return
    const tabImages = activeTerminalTab.pendingImages
    if (!input.trim() && tabImages.length === 0) return

    const command = input.trim()
    const images = tabImages.map(img => ({
      data: img.data,
      name: img.name
    }))

    // Display user message with image indicators
    const displayContent = images.length > 0
      ? `${command}${command ? '\n' : ''}[${images.length} image${images.length > 1 ? 's' : ''} attached]`
      : command
    addTabMessage(activeTerminalTab.id, 'input', displayContent)

    setInput('')
    updateTab(activeTerminalTab.id, { pendingImages: [] })
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = {
        type: 'command',
        content: command,
        tabId: activeTerminalTab.id,
        workingDirectory: activeTerminalTab.workingDirectory,
        projectId: activeTerminalTab.projectId,
      }
      if (images.length > 0) {
        msg.images = images
      }
      wsRef.current.send(JSON.stringify(msg))
    } else {
      addTabMessage(activeTerminalTab.id, 'error', 'Not connected to server. Retrying connection...')
      connect()
    }
  }

  /** Handles keyboard events: Enter to send, Ctrl+C to abort. */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendCommand()
    } else if (e.key === 'c' && e.ctrlKey && activeTerminalTab) {
      e.preventDefault()
      wsRef.current?.send(JSON.stringify({ type: 'abort', tabId: activeTerminalTab.id }))
      addTabMessage(activeTerminalTab.id, 'status', 'Aborting...')
    }
  }

  /** Handles paste events to detect and capture images from clipboard. */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!activeTerminalTab) return
    const items = e.clipboardData?.items
    if (!items) return

    const imageItems = Array.from(items).filter(item =>
      item.type.startsWith('image/')
    )

    if (imageItems.length === 0) return

    e.preventDefault() // Prevent default paste of image data
    const tabId = activeTerminalTab.id

    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue

      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]

        setTerminalTabs(prev => prev.map(tab =>
          tab.id === tabId ? { ...tab, pendingImages: [...tab.pendingImages, {
            id: generateId(),
            data: base64,
            name: `paste-${Date.now()}-${tab.pendingImages.length}.png`,
            preview: dataUrl
          }] } : tab
        ))
      }
      reader.readAsDataURL(file)
    }
  }, [activeTerminalTab])

  /** Handles file selection from the image picker. */
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeTerminalTab) return
    const files = e.target.files
    if (!files) return
    const tabId = activeTerminalTab.id

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue

      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]

        setTerminalTabs(prev => prev.map(tab =>
          tab.id === tabId ? { ...tab, pendingImages: [...tab.pendingImages, {
            id: generateId(),
            data: base64,
            name: file.name || `image-${Date.now()}.png`,
            preview: dataUrl
          }] } : tab
        ))
      }
      reader.readAsDataURL(file)
    }

    // Reset the input so the same file can be selected again
    e.target.value = ''
  }, [activeTerminalTab])

  /** Resets the current tab's session and clears message history. */
  const handleReset = () => {
    if (!activeTerminalTab) return
    const tabId = activeTerminalTab.id
    wsRef.current?.send(JSON.stringify({ type: 'reset', tabId }))
    updateTab(tabId, {
      sessionId: null,
      lastMessageId: 0,
      messages: [],
      currentTool: null,
    })
    setTerminalTabs(prev => {
      persistTabs(prev.map(t => t.id === tabId ? { ...t, sessionId: null } : t), activeTerminalTabId)
      return prev
    })
  }

  /** Starts a new chat session on the active terminal tab. */
  const handleNewChat = () => {
    handleReset()
    setSidebarOpen(false)
    if (activeTerminalTab) {
      setActiveSubTab('terminal')
    }
  }

  /** Resumes a previous session and loads its conversation history, switching tabs if needed. */
  const handleSelectSession = async (session: Session) => {
    if (!activeTerminalTab) return

    // If the session belongs to a different project, switch to (or create) that project's tab
    let tabId = activeTerminalTab.id
    let workingDirectory = activeTerminalTab.workingDirectory
    if (session.projectId && session.projectId !== activeTerminalTab.projectId) {
      const targetProject = projects.find(p => p.id === session.projectId)
      if (targetProject) {
        const targetTabId = `tab-${targetProject.id}`
        const existingTab = terminalTabsRef.current.find(t => t.id === targetTabId)
        if (existingTab) {
          // Switch to existing tab
          setActiveTerminalTabId(targetTabId)
          tabId = targetTabId
          workingDirectory = existingTab.workingDirectory
        } else {
          // Create new tab for the project
          const newTab: TerminalTabState = {
            id: targetTabId,
            projectId: targetProject.id,
            projectName: targetProject.name,
            workingDirectory: targetProject.directory,
            messages: [],
            sessionId: null,
            lastMessageId: 0,
            status: 'connected',
            currentTool: null,
            pendingImages: [],
          }
          setTerminalTabs(prev => {
            const next = [...prev, newTab]
            persistTabs(next, targetTabId)
            return next
          })
          setActiveTerminalTabId(targetTabId)
          tabId = targetTabId
          workingDirectory = targetProject.directory
        }
      }
    }

    wsRef.current?.send(JSON.stringify({
      type: 'resume',
      sessionId: session.id,
      workingDirectory,
      tabId,
    }))
    updateTab(tabId, {
      sessionId: session.id,
      lastMessageId: 0,
      messages: [],
    })
    setSidebarOpen(false)
    setActiveSubTab('terminal')

    // Fetch and restore conversation history
    try {
      const res = await fetch(`http://${window.location.hostname}:4001/sessions/${session.id}/history`)
      const history: Array<{ type: 'input' | 'output' | 'error' | 'status'; content: string; timestamp: string }> = await res.json()
      const restoredMessages: Message[] = history.map(msg => ({
        id: generateId(),
        type: msg.type,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
      }))
      updateTab(tabId, { messages: restoredMessages })
      addTabMessage(tabId, 'status', `Loaded ${history.length} messages from conversation`)
    } catch (err) {
      console.error('Failed to fetch session history:', err)
      addTabMessage(tabId, 'status', `Resumed conversation: ${session.name}`)
    }
    // Persist the new session ID
    setTerminalTabs(prev => {
      const updated = prev.map(t => t.id === tabId ? { ...t, sessionId: session.id } : t)
      persistTabs(updated, activeTerminalTabId)
      return updated
    })
  }

  /** Returns the status indicator color based on connection state. */
  const getStatusColor = () => {
    const tabStatus = activeTerminalTab?.status
    if (!wsConnected) return '#f87171' // disconnected
    if (!tabStatus) return wsConnected ? '#4ade80' : '#f87171'
    switch (tabStatus) {
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
      const apiUrl = `http://${window.location.hostname}:4001/restart`
      const response = await fetch(apiUrl, { method: 'POST' })
      if (response.ok) {
        setTerminalTabs(prev => prev.map(tab => ({ ...tab, status: 'restarting' as ConnectionStatus })))
        isRestartingRef.current = true
        setRestartCountdown(3)
        // Tabs are already persisted in localStorage for rehydration after reload
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
      }
    } catch (error) {
      console.error('Failed to restart server:', error)
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

  const LOG_LEVEL_PRIORITY = { error: 0, warn: 1, info: 2 } as const
  const filteredLogMessages = logMessages.filter(
    log => LOG_LEVEL_PRIORITY[log.level] <= LOG_LEVEL_PRIORITY[logLevelFilter]
  )

  /** Clears all server log messages from the logs tab. */
  const handleClearLogs = () => {
    setLogMessages([])
  }

  /** Switches between sections (Terminal, Hardware, Diagnostics). */
  const handleSectionChange = useCallback((section: Section) => {
    setActiveSection(section)
    if (section === 'terminal' && terminalTabs.length > 0 && activeTerminalTabId) {
      setActiveSubTab('terminal')
    } else {
      setActiveSubTab(SECTION_TABS[section][0])
    }
    setSidebarOpen(false)
  }, [terminalTabs.length, activeTerminalTabId])

  /** Switches between sub-tabs within the current section. */
  const handleSubTabChange = useCallback((tab: SubTab) => {
    setActiveSubTab(tab)
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

  /** Scrolls the logs output to the bottom. */
  const scrollLogsToBottom = useCallback(() => {
    if (logsOutputRef.current) {
      logsOutputRef.current.scrollTop = logsOutputRef.current.scrollHeight
    }
  }, [])

  /** Handles scroll events to show/hide the logs scroll-to-bottom button. */
  const handleLogsScroll = useCallback(() => {
    if (logsOutputRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logsOutputRef.current
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100
      setShowLogsScrollButton(!isNearBottom)
    }
  }, [])

  /** Sets the output mode (grid/fullscreen) for a webcam stream. */
  const setWebcamMode = useCallback((deviceId: string, mode: 'grid' | 'fullscreen') => {
    console.log('[Webcam] setWebcamMode called:', deviceId, mode)
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
      webcamWsRef.current.send(JSON.stringify({ type: 'webcam-mode', deviceId, mode }))
    }
  }, [])

  // Pinch-to-zoom handlers for fullscreen webcam
  const resetPinchZoom = useCallback(() => {
    const state = pinchStateRef.current
    state.lastScale = 1
    state.translateX = 0
    state.translateY = 0
    state.isPinching = false
    state.isPanning = false
    if (fullscreenImgRef.current) {
      fullscreenImgRef.current.style.transform = ''
    }
  }, [])

  const getTouchDistance = (t1: React.Touch, t2: React.Touch) =>
    Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)

  const applyTransform = useCallback((tx: number, ty: number, scale: number) => {
    if (fullscreenImgRef.current) {
      fullscreenImgRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    }
  }, [])

  const handleFullscreenTouchStart = useCallback((e: React.TouchEvent) => {
    const state = pinchStateRef.current
    if (e.touches.length === 2) {
      e.preventDefault()
      state.isPanning = false
      state.startDist = getTouchDistance(e.touches[0], e.touches[1])
      state.startScale = state.lastScale
      state.startMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2
      state.startMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2
      state.isPinching = true
    } else if (e.touches.length === 1 && state.lastScale > 1.1) {
      // Single-finger pan when zoomed in
      state.isPanning = true
      state.panStartX = e.touches[0].clientX
      state.panStartY = e.touches[0].clientY
    }
  }, [])

  const handleFullscreenTouchMove = useCallback((e: React.TouchEvent) => {
    const state = pinchStateRef.current
    if (e.touches.length === 2 && state.isPinching) {
      e.preventDefault()
      const currentDist = getTouchDistance(e.touches[0], e.touches[1])
      const scale = Math.min(Math.max(state.startScale * (currentDist / state.startDist), 1), 5)

      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
      state.translateX += midX - state.startMidX
      state.translateY += midY - state.startMidY
      state.startMidX = midX
      state.startMidY = midY
      state.lastScale = scale

      applyTransform(state.translateX, state.translateY, scale)
    } else if (e.touches.length === 1 && state.isPanning) {
      e.preventDefault()
      const dx = e.touches[0].clientX - state.panStartX
      const dy = e.touches[0].clientY - state.panStartY
      state.panStartX = e.touches[0].clientX
      state.panStartY = e.touches[0].clientY
      state.translateX += dx
      state.translateY += dy

      applyTransform(state.translateX, state.translateY, state.lastScale)
    }
  }, [applyTransform])

  const handleFullscreenTouchEnd = useCallback((e: React.TouchEvent) => {
    const state = pinchStateRef.current
    if (state.isPinching && e.touches.length < 2) {
      state.isPinching = false
      // If one finger remains, start panning
      if (e.touches.length === 1 && state.lastScale > 1.1) {
        state.isPanning = true
        state.panStartX = e.touches[0].clientX
        state.panStartY = e.touches[0].clientY
      }
      // Snap back to 1x if close
      if (state.lastScale < 1.1) {
        resetPinchZoom()
      }
    }
    if (e.touches.length === 0) {
      state.isPanning = false
      // Snap back if nearly unzoomed
      if (state.lastScale < 1.1) {
        resetPinchZoom()
      }
    }
  }, [resetPinchZoom])

  /** Toggles fullscreen mode for a webcam feed, with browser fullscreen and orientation lock. */
  const toggleFullscreenWebcam = useCallback((deviceId: string | null, previousDeviceId?: string | null) => {
    setFullscreenWebcam(deviceId)

    // Change output mode based on fullscreen state
    if (deviceId) {
      // Entering fullscreen - switch to native resolution pass-through
      setWebcamMode(deviceId, 'fullscreen')

      // Request browser fullscreen after a short delay to ensure the overlay is rendered
      setTimeout(() => {
        if (fullscreenOverlayRef.current && document.fullscreenElement === null) {
          fullscreenOverlayRef.current.requestFullscreen().catch(() => {
            // Fullscreen not supported or denied - that's fine, we still have our overlay
          })
        }
      }, 50)
    } else if (previousDeviceId) {
      // Exiting fullscreen - switch back to grid downscale
      setWebcamMode(previousDeviceId, 'grid')
      resetPinchZoom()

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
  }, [setWebcamMode, resetPinchZoom])

  const handleFullscreenOverlayClick = useCallback(() => {
    // Don't exit if zoomed in — require the exit button instead
    if (pinchStateRef.current.lastScale > 1.1) return
    if (fullscreenWebcam) toggleFullscreenWebcam(null, fullscreenWebcam)
  }, [fullscreenWebcam, toggleFullscreenWebcam])

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
    if (activeSubTab === 'webcams') {
      connectWebcam()
    }

    return () => {
      if (webcamReconnectTimeoutRef.current) {
        clearTimeout(webcamReconnectTimeoutRef.current)
      }
    }
  }, [activeSubTab, connectWebcam])

  // Fetch webcam list when connected to webcam server
  useEffect(() => {
    if (activeSubTab === 'webcams' && webcamConnected) {
      requestWebcamList()
    }
  }, [activeSubTab, webcamConnected, requestWebcamList])

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
      {/* Sidebar — section navigation */}
      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2>Dashboard</h2>
          <button className="close-sidebar" onClick={() => setSidebarOpen(false)}>
            &times;
          </button>
        </div>
        <nav className="section-nav">
          {(Object.keys(SECTION_LABELS) as Section[]).map(section => (
            <button
              key={section}
              className={`section-nav-item ${activeSection === section ? 'active' : ''}`}
              onClick={() => handleSectionChange(section)}
            >
              {SECTION_LABELS[section]}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            onClick={async () => {
              try {
                const apiUrl = `http://${window.location.hostname}:4001/grafana/restart`
                const response = await fetch(apiUrl, { method: 'POST' })
                if (response.ok) {
                  console.log('Grafana container restarted')
                } else {
                  const data = await response.json()
                  console.error(`Failed to restart Grafana: ${data.error}`)
                }
              } catch (error) {
                console.error('Failed to restart Grafana')
              }
              setSidebarOpen(false)
            }}
            className="restart-button"
            title="Restart Grafana Docker container"
          >
            Restart Grafana
          </button>
          <button
            onClick={() => { handleRestart(); setSidebarOpen(false) }}
            className="restart-button"
            title="Restart server"
            disabled={restartCountdown !== null}
          >
            {restartCountdown !== null
              ? `Refreshing in ${restartCountdown}...`
              : 'Restart Server'}
          </button>
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
            {activeSubTab === 'terminal' && activeTerminalTab ? `${activeTerminalTab.projectName} — Terminal`
              : activeSubTab === 'terminal' ? 'Terminal — No project open'
              : SECTION_TABS[activeSection].length === 1
                ? SECTION_LABELS[activeSection]
                : `${SECTION_LABELS[activeSection]} — ${SUB_TAB_LABELS[activeSubTab]}`}
          </div>
          <div className="terminal-controls">
            {activeSubTab === 'terminal' && activeTerminalTab?.sessionId && <span className="session-id">{activeTerminalTab.sessionId.slice(0, 8)}...</span>}
            {activeSubTab === 'logs' && (
              <>
                <select
                  className="log-level-select"
                  value={logLevelFilter}
                  onChange={(e) => setLogLevelFilter(e.target.value as 'error' | 'warn' | 'info')}
                  title="Minimum log level to display"
                >
                  <option value="error">Errors only</option>
                  <option value="warn">Warn+</option>
                  <option value="info">All</option>
                </select>
                <button onClick={handleClearLogs} className="reset-button" title="Clear logs">
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

        {/* Tab bar — sub-tabs for active section */}
        <div className="tab-bar">
          {activeSection === 'terminal' ? (
            <>
              {/* Dynamic terminal tabs */}
              {terminalTabs.map(tab => (
                <button
                  key={tab.id}
                  className={`tab ${activeTerminalTabId === tab.id && activeSubTab === 'terminal' ? 'active' : ''} ${tab.status === 'processing' ? 'tab-processing' : ''}`}
                  onClick={() => { setActiveTerminalTabId(tab.id); setActiveSubTab('terminal') }}
                >
                  {tab.projectName}
                  {tab.status === 'processing' && <span className="tab-processing-dot" />}
                  <span
                    className="tab-close-button"
                    onClick={(e) => { e.stopPropagation(); closeTerminalTab(tab.id) }}
                  >
                    &times;
                  </span>
                </button>
              ))}

              {/* Separator between terminal tabs and management tabs */}
              {terminalTabs.length > 0 && <span className="tab-separator" />}

              {/* Static management tabs */}
              <button
                className={`tab ${activeSubTab === 'projects' ? 'active' : ''}`}
                onClick={() => handleSubTabChange('projects')}
              >
                Projects
                {projects.length > 0 && <span className="tab-badge">{projects.length}</span>}
              </button>
              <button
                className={`tab ${activeSubTab === 'conversations' ? 'active' : ''}`}
                onClick={() => handleSubTabChange('conversations')}
              >
                Conversations
                {sessions.length > 0 && <span className="tab-badge">{sessions.length}</span>}
              </button>
            </>
          ) : (
            SECTION_TABS[activeSection].map(tab => (
              <button
                key={tab}
                className={`tab ${activeSubTab === tab ? 'active' : ''}`}
                onClick={() => handleSubTabChange(tab)}
              >
                {SUB_TAB_LABELS[tab]}
                {tab === 'webcams' && activeWebcams.size > 0 && <span className="tab-badge">{activeWebcams.size}</span>}
                {tab === 'logs' && filteredLogMessages.length > 0 && <span className="tab-badge">{filteredLogMessages.length}</span>}
              </button>
            ))
          )}
        </div>

        {/* Terminal output - one div per tab, hidden when not active */}
        {terminalTabs.map(tab => (
          <div
            key={tab.id}
            className={`terminal-output ${(activeTerminalTabId !== tab.id || activeSubTab !== 'terminal') ? 'tab-hidden' : ''}`}
            ref={activeTerminalTabId === tab.id ? outputRef : undefined}
            onScroll={activeTerminalTabId === tab.id ? handleTerminalScroll : undefined}
          >
            {tab.messages.length === 0 && (
              <div className="welcome-message">
                Terminal for {tab.projectName}.
                <br />
                Type a message to start a conversation with Claude.
              </div>
            )}
            {tab.messages.map((msg, index) => {
              const isReady = activeTerminalTabId === tab.id && index === readyMessageIndex && tab.status === 'connected'
              return (
                <div key={msg.id} className={`message message-${msg.type}${isReady ? ' message-ready' : ''}`}>
                  {msg.type === 'input' && <span className="prompt">&gt; </span>}
                  {msg.type === 'error' && <span className="error-prefix">[ERROR] </span>}
                  {msg.type === 'status' && <span className="status-prefix">[STATUS] </span>}
                  {msg.type === 'output' ? (
                    <div className="message-content markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <span className="message-content">{msg.content}</span>
                  )}
                </div>
              )
            })}
            {tab.status === 'processing' && (
              <div className="message message-tool">
                <span className="tool-indicator">
                  {tab.currentTool || 'Processing...'}
                </span>
              </div>
            )}
          </div>
        ))}

        {/* Show welcome when no tabs are open and terminal sub-tab is selected */}
        {terminalTabs.length === 0 && activeSubTab === 'terminal' && (
          <div className="terminal-output">
            <div className="welcome-message">
              No projects open.
              <br />
              Open a project from the Projects tab to start a terminal.
            </div>
          </div>
        )}

        {/* Scroll to bottom button */}
        {activeSubTab === 'terminal' && showScrollButton && (
          <button
            className="scroll-to-bottom-button"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        )}

        {/* Logs output - always mounted, hidden when inactive */}
        <div className={`logs-output ${activeSubTab !== 'logs' ? 'tab-hidden' : ''}`} ref={logsOutputRef} onScroll={handleLogsScroll}>
          {filteredLogMessages.length === 0 && (
            <div className="welcome-message">
              {logMessages.length === 0
                ? <>No server logs yet.<br />Logs will appear here as the server processes requests.</>
                : <>No logs at this level. Try changing the filter to see more.</>
              }
            </div>
          )}
          {filteredLogMessages.map(log => (
            <div key={log.id} className={`log-message log-${log.level}`}>
              <span className="log-timestamp">[{formatLogTime(log.timestamp)}]</span>
              <span className={`log-level log-level-${log.level}`}>[{log.level.toUpperCase()}]</span>
              <span className="log-content">{log.content}</span>
            </div>
          ))}
        </div>

        {/* Scroll to bottom button for logs */}
        {activeSubTab === 'logs' && showLogsScrollButton && (
          <button
            className="scroll-to-bottom-button bottom-corner"
            onClick={scrollLogsToBottom}
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        )}

        {/* Client Performance - Grafana iframe */}
        <div className={`perf-container ${activeSubTab !== 'client-perf' ? 'tab-hidden' : ''}`}>
          <iframe
            src={`http://${window.location.hostname}:3000/d/client-perf/client-performance?orgId=1&kiosk`}
            className="grafana-iframe"
            title="Client Performance"
          />
        </div>

        {/* Server Performance - Grafana iframe */}
        <div className={`perf-container ${activeSubTab !== 'server-perf' ? 'tab-hidden' : ''}`}>
          <iframe
            src={`http://${window.location.hostname}:3000/d/server-perf/server-performance?orgId=1&kiosk`}
            className="grafana-iframe"
            title="Server Performance"
          />
        </div>

        {/* Webcams output - always mounted, hidden when inactive */}
        <div className={`webcams-container ${activeSubTab !== 'webcams' ? 'tab-hidden' : ''}`} ref={webcamsContainerRef}>
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
        <div className={`projects-container ${activeSubTab !== 'projects' ? 'tab-hidden' : ''}`}>
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
              {projects.map(project => {
                const isOpen = terminalTabs.some(t => t.projectId === project.id)
                return (
                  <div
                    key={project.id}
                    className={`project-card ${isOpen ? 'active' : ''}`}
                  >
                    <div className="project-card-header">
                      <div className="project-card-name">{project.name}</div>
                      <div className="project-card-actions">
                        {isOpen ? (
                          <button
                            className="project-deactivate-button"
                            onClick={() => closeTerminalTab(`tab-${project.id}`)}
                          >
                            Close
                          </button>
                        ) : (
                          <button
                            className="project-switch-button"
                            onClick={() => handleActivateProject(project)}
                          >
                            Open
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
                )
              })}
            </div>
          )}

          {activeTerminalTab && (
            <div className="project-conversations">
              <h3>Conversations for {activeTerminalTab.projectName}</h3>
              {loadingProjectConversations ? (
                <div className="welcome-message">Loading conversations...</div>
              ) : projectConversations.length === 0 ? (
                <div className="welcome-message">No conversations yet for this project.</div>
              ) : (
                <div className="project-conversations-list">
                  {projectConversations.map(conv => (
                    <button
                      key={conv.id}
                      className={`session-item ${activeTerminalTab.sessionId === conv.id ? 'active' : ''}`}
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

        {/* Conversations - always mounted, hidden when inactive */}
        <div className={`conversations-container ${activeSubTab !== 'conversations' ? 'tab-hidden' : ''}`}>
          <div className="conversations-header">
            <h3>Conversations</h3>
            <button
              className="new-chat-button"
              onClick={handleNewChat}
              disabled={!activeTerminalTab}
              title={!activeTerminalTab ? 'Open a project first' : 'Start a new conversation on the active terminal tab'}
            >
              + New Conversation
            </button>
          </div>
          {activeTerminalTab && (
            <label className="conversations-filter">
              <input
                type="checkbox"
                checked={filterByProject}
                onChange={(e) => setFilterByProject(e.target.checked)}
              />
              Project only
            </label>
          )}
          {(() => {
            const filteredSessions = filterByProject
              ? sessions.filter(s => s.projectId != null)
              : sessions
            return !activeTerminalTab ? (
              <div className="welcome-message">
                Open a project first to manage conversations.
              </div>
            ) : loadingSessions && sessions.length === 0 ? (
              <div className="welcome-message">Loading conversations...</div>
            ) : filteredSessions.length === 0 ? (
              <div className="welcome-message">
                No conversations yet.
                <br />
                Start a conversation from the Terminal tab.
              </div>
            ) : (
              <div className="conversations-list">
                {filteredSessions.map(session => (
                  <button
                    key={session.id}
                    className={`session-item ${activeTerminalTab.sessionId === session.id ? 'active' : ''}`}
                    onClick={() => handleSelectSession(session)}
                  >
                    <div className="session-name">{session.name}</div>
                    <div className="session-meta">
                      {session.projectId && (
                        <span className="session-project">{projects.find(p => p.id === session.projectId)?.name}</span>
                      )}
                      <span className="session-uuid">{session.id.slice(0, 8)}...</span>
                      <span className="session-date">{formatDate(session.lastModified)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )
          })()}
        </div>

        {/* Daily Briefing - always mounted, hidden when inactive */}
        <div className={`briefing-container ${activeSubTab !== 'briefing-editor' ? 'tab-hidden' : ''}`}>
          <div className="briefing-header">
            <h3>Briefing Prompt</h3>
            <p className="briefing-description">
              This prompt guides the daily briefing email sent at 8:00 AM.
              Edit it below and save, or send a test email to preview.
            </p>
          </div>

          {loadingBriefingPrompt ? (
            <div className="welcome-message">Loading prompt...</div>
          ) : (
            <>
              <textarea
                className="briefing-textarea"
                value={briefingPromptDraft}
                onChange={e => setBriefingPromptDraft(e.target.value)}
                rows={10}
                placeholder="Enter your briefing prompt..."
              />

              <div className="briefing-actions">
                <button
                  className="briefing-save-button"
                  onClick={handleSaveBriefingPrompt}
                  disabled={savingBriefingPrompt || briefingPromptDraft === briefingPrompt}
                >
                  {savingBriefingPrompt ? 'Saving...' : 'Save Prompt'}
                </button>
                <button
                  className="briefing-preview-button"
                  onClick={handleGeneratePreview}
                  disabled={generatingPreview}
                >
                  {generatingPreview ? 'Generating...' : 'Preview Briefing'}
                </button>
                <button
                  className="briefing-test-button"
                  onClick={handleSendTestBriefing}
                  disabled={sendingTestBriefing}
                >
                  {sendingTestBriefing ? 'Sending...' : 'Send Test Email'}
                </button>
                {briefingPromptDraft !== briefingPrompt && (
                  <button
                    className="briefing-discard-button"
                    onClick={() => setBriefingPromptDraft(briefingPrompt)}
                  >
                    Discard Changes
                  </button>
                )}
              </div>

              {briefingStatus && (
                <div className="briefing-status">{briefingStatus}</div>
              )}

              {briefingProgressSteps.length > 0 && generatingPreview && (
                <div className="briefing-progress-steps">
                  {briefingProgressSteps.map((step, i) => (
                    <div key={i} className={`briefing-progress-step ${i === briefingProgressSteps.length - 1 ? 'active' : 'done'}`}>
                      <span className="briefing-progress-icon">{i === briefingProgressSteps.length - 1 ? '⟳' : '✓'}</span>
                      {step}
                    </div>
                  ))}
                </div>
              )}

              {briefingPreviewHtml && (
                <div className="briefing-preview">
                  <div className="briefing-preview-header">
                    <h3>Briefing Preview</h3>
                    <div className="briefing-preview-meta">
                      {briefingPreviewGeneratedAt && (
                        <span className="briefing-preview-timestamp">
                          Generated {new Date(briefingPreviewGeneratedAt).toLocaleString()}
                        </span>
                      )}
                      <button
                        className="briefing-discard-button"
                        onClick={() => { setBriefingPreviewHtml(null); setBriefingProgressSteps([]); setBriefingPreviewGeneratedAt(null) }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <div
                    className="briefing-preview-content"
                    dangerouslySetInnerHTML={{ __html: briefingPreviewHtml }}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Todo List - always mounted, hidden when inactive */}
        <div className={`todo-container ${activeSubTab !== 'todos' ? 'tab-hidden' : ''}`}>
          <div className="todo-add-form">
            <input
              className="todo-input"
              type="text"
              placeholder="Add a new todo..."
              value={newTodoDescription}
              onChange={e => setNewTodoDescription(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateTodo()}
            />
            <button
              className="todo-add-button"
              onClick={handleCreateTodo}
              disabled={!newTodoDescription.trim()}
            >
              Add
            </button>
          </div>

          {loadingTodos && todos.length === 0 && (
            <div className="welcome-message">Loading todos...</div>
          )}

          {!loadingTodos && todos.length === 0 && (
            <div className="welcome-message">
              No todos yet.
              <br />
              Add one above to get started.
            </div>
          )}

          {todos.length > 0 && (
            <div className="todo-list">
              {todos.map(todo => (
                <div key={todo.id} className={`todo-item ${todo.done ? 'todo-done' : ''}`}>
                  <input
                    type="checkbox"
                    className="todo-checkbox"
                    checked={todo.done}
                    onChange={() => handleToggleTodo(todo.id, !todo.done)}
                    title={todo.done ? 'Mark as pending' : 'Mark as done'}
                  />
                  <div className="todo-item-content">
                    <span className="todo-description">{todo.description}</span>
                    <span className="todo-date">{formatDate(todo.createdAt)}</span>
                  </div>
                  <button
                    className="todo-delete-button"
                    onClick={() => handleDeleteTodo(todo.id)}
                    title="Delete todo"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recitations - always mounted, hidden when inactive */}
        <div className={`recitations-container ${activeSubTab !== 'recitations-editor' ? 'tab-hidden' : ''}`}>
          <div className="recitations-add-form">
            <input
              className="recitations-input"
              type="text"
              placeholder="Recitation title..."
              value={newRecitationTitle}
              onChange={e => setNewRecitationTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleCreateRecitation()}
            />
            <textarea
              className="recitations-textarea"
              placeholder="Content (optional)..."
              value={newRecitationContent}
              onChange={e => setNewRecitationContent(e.target.value)}
              rows={3}
            />
            <button
              className="recitations-add-button"
              onClick={handleCreateRecitation}
              disabled={!newRecitationTitle.trim()}
            >
              Add Recitation
            </button>
          </div>

          {loadingRecitations && recitations.length === 0 && (
            <div className="welcome-message">Loading recitations...</div>
          )}

          {!loadingRecitations && recitations.length === 0 && (
            <div className="welcome-message">
              No recitations yet.
              <br />
              Add one above to include in your daily briefing.
            </div>
          )}

          {recitations.length > 0 && (
            <div className="recitations-list">
              {recitations.map(recitation => (
                <div key={recitation.id} className="recitation-item">
                  {editingRecitation?.id === recitation.id ? (
                    <div className="recitation-edit-form">
                      <input
                        className="recitations-input"
                        type="text"
                        value={editRecitationTitle}
                        onChange={e => setEditRecitationTitle(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleUpdateRecitation()}
                      />
                      <textarea
                        className="recitations-textarea"
                        value={editRecitationContent}
                        onChange={e => setEditRecitationContent(e.target.value)}
                        rows={4}
                      />
                      <div className="recitation-edit-actions">
                        <button className="recitations-save-button" onClick={handleUpdateRecitation} disabled={!editRecitationTitle.trim()}>
                          Save
                        </button>
                        <button className="recitations-cancel-button" onClick={handleCancelEditRecitation}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="recitation-item-header">
                        <span className="recitation-title">{recitation.title}</span>
                        <span className="recitation-date">{formatDate(recitation.createdAt)}</span>
                      </div>
                      {recitation.content && (
                        <div className="recitation-content">{recitation.content}</div>
                      )}
                      <div className="recitation-actions">
                        <button
                          className="recitation-edit-button"
                          onClick={() => handleStartEditRecitation(recitation)}
                          title="Edit recitation"
                        >
                          Edit
                        </button>
                        <button
                          className="recitation-delete-button"
                          onClick={() => handleDeleteRecitation(recitation.id)}
                          title="Delete recitation"
                        >
                          &times;
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Research Topics - always mounted, hidden when inactive */}
        <div className={`recitations-container ${activeSubTab !== 'topics' ? 'tab-hidden' : ''}`}>
          <div className="recitations-add-form">
            <input
              className="recitations-input"
              type="text"
              placeholder="Topic name..."
              value={newTopicName}
              onChange={e => setNewTopicName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleCreateTopic()}
            />
            <textarea
              className="recitations-textarea"
              placeholder="Description (optional)..."
              value={newTopicDescription}
              onChange={e => setNewTopicDescription(e.target.value)}
              rows={3}
            />
            <button
              className="recitations-add-button"
              onClick={handleCreateTopic}
              disabled={!newTopicName.trim()}
            >
              Add Topic
            </button>
          </div>

          {loadingTopics && topics.length === 0 && (
            <div className="welcome-message">Loading topics...</div>
          )}

          {!loadingTopics && topics.length === 0 && (
            <div className="welcome-message">
              No research topics yet.
              <br />
              Add one above to start generating daily research articles.
            </div>
          )}

          {topics.length > 0 && (
            <div className="recitations-list">
              {topics.map(topic => (
                <div key={topic.id} className="recitation-item">
                  {editingTopic?.id === topic.id ? (
                    <div className="recitation-edit-form">
                      <input
                        className="recitations-input"
                        type="text"
                        value={editTopicName}
                        onChange={e => setEditTopicName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleUpdateTopic()}
                      />
                      <textarea
                        className="recitations-textarea"
                        value={editTopicDescription}
                        onChange={e => setEditTopicDescription(e.target.value)}
                        rows={4}
                      />
                      <div className="recitation-edit-actions">
                        <button className="recitations-save-button" onClick={handleUpdateTopic} disabled={!editTopicName.trim()}>
                          Save
                        </button>
                        <button className="recitations-cancel-button" onClick={handleCancelEditTopic}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="recitation-item-header">
                        <span className="recitation-title" style={{ cursor: 'pointer' }} onClick={() => handleToggleTopicArticles(topic.id)}>
                          {expandedTopicId === topic.id ? '▼' : '▶'} {topic.name}
                        </span>
                        <span className="recitation-date">{formatDate(topic.createdAt)}</span>
                      </div>
                      {topic.description && (
                        <div className="recitation-content">{topic.description}</div>
                      )}
                      <div className="recitation-actions">
                        <button
                          className="recitation-edit-button"
                          onClick={() => handleStartEditTopic(topic)}
                          title="Edit topic"
                        >
                          Edit
                        </button>
                        <button
                          className="recitation-delete-button"
                          onClick={() => handleDeleteTopic(topic.id)}
                          title="Delete topic"
                        >
                          &times;
                        </button>
                      </div>
                      {expandedTopicId === topic.id && (
                        <div className="topic-articles" style={{ marginTop: '8px', paddingLeft: '16px', borderLeft: '2px solid #333' }}>
                          {!topicArticles[topic.id] && (
                            <div style={{ color: '#888', fontSize: '12px' }}>Loading articles...</div>
                          )}
                          {topicArticles[topic.id]?.length === 0 && (
                            <div style={{ color: '#888', fontSize: '12px' }}>No articles yet. Articles are generated during the daily briefing.</div>
                          )}
                          {topicArticles[topic.id]?.map(article => (
                            <div key={article.id} style={{ marginBottom: '12px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <strong style={{ fontSize: '13px' }}>{article.title}</strong>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                  <span style={{ color: '#888', fontSize: '11px' }}>{formatDate(article.createdAt)}</span>
                                  <button
                                    className="recitation-delete-button"
                                    onClick={() => handleDeleteArticle(article.id, topic.id)}
                                    title="Delete article"
                                  >
                                    &times;
                                  </button>
                                </div>
                              </div>
                              <div
                                style={{ fontSize: '12px', color: '#ccc', marginTop: '4px', lineHeight: '1.5' }}
                                dangerouslySetInnerHTML={{ __html: article.content }}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* CRM Contacts - always mounted, hidden when inactive */}
        <div className={`crm-container ${activeSubTab !== 'contacts' ? 'tab-hidden' : ''}`}>
          {/* Add/Edit Contact Form */}
          {(showAddContact || editingContact) ? (
            <div className="crm-form">
              <h3>{editingContact ? 'Edit Contact' : 'Add Contact'}</h3>
              <div className="crm-form-fields">
                <input
                  className="crm-input"
                  type="text"
                  placeholder="Name (required)"
                  value={newContactName}
                  onChange={e => setNewContactName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (editingContact ? handleUpdateContact() : handleCreateContact())}
                  autoFocus
                />
                <input
                  className="crm-input"
                  type="email"
                  placeholder="Email"
                  value={newContactEmail}
                  onChange={e => setNewContactEmail(e.target.value)}
                />
                <input
                  className="crm-input"
                  type="tel"
                  placeholder="Phone"
                  value={newContactPhone}
                  onChange={e => setNewContactPhone(e.target.value)}
                />
                <input
                  className="crm-input"
                  type="text"
                  placeholder="Social handles (e.g. @twitter, linkedin.com/in/x)"
                  value={newContactSocial}
                  onChange={e => setNewContactSocial(e.target.value)}
                />
              </div>
              <div className="crm-form-actions">
                <button
                  className="crm-save-button"
                  onClick={editingContact ? handleUpdateContact : handleCreateContact}
                  disabled={!newContactName.trim()}
                >
                  {editingContact ? 'Save' : 'Add'}
                </button>
                <button className="crm-cancel-button" onClick={handleCancelContactForm}>
                  Cancel
                </button>
              </div>
            </div>
          ) : selectedContact ? (
            /* Contact Detail View */
            <div className="crm-detail">
              <div className="crm-detail-header">
                <button className="crm-back-button" onClick={() => setSelectedContact(null)}>
                  &larr; Back
                </button>
                <div className="crm-detail-actions">
                  <button className="crm-edit-button" onClick={() => handleStartEdit(selectedContact)}>
                    Edit
                  </button>
                  <button className="crm-delete-button" onClick={() => handleDeleteContact(selectedContact.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="crm-detail-info">
                <h3 className="crm-detail-name">{selectedContact.name}</h3>
                {selectedContact.email && (
                  <div className="crm-detail-field">
                    <span className="crm-field-label">Email:</span> {selectedContact.email}
                  </div>
                )}
                {selectedContact.phone && (
                  <div className="crm-detail-field">
                    <span className="crm-field-label">Phone:</span> {selectedContact.phone}
                  </div>
                )}
                {selectedContact.socialHandles && (
                  <div className="crm-detail-field">
                    <span className="crm-field-label">Social:</span> {selectedContact.socialHandles}
                  </div>
                )}
                <div className="crm-detail-field crm-detail-meta">
                  {selectedContact.interactionCount} interaction{selectedContact.interactionCount !== 1 ? 's' : ''}
                  {selectedContact.lastInteraction
                    ? ` — last ${formatDate(selectedContact.lastInteraction)}`
                    : ' — never contacted'}
                </div>
              </div>
              <div className="crm-interaction-form">
                <textarea
                  className="crm-interaction-input"
                  placeholder="Log an interaction... (what did you talk about?)"
                  value={newInteractionNote}
                  onChange={e => setNewInteractionNote(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleLogInteraction(selectedContact.id)
                    }
                  }}
                  rows={2}
                />
                <div className="crm-interaction-actions">
                  <input
                    type="date"
                    className="crm-interaction-date"
                    value={newInteractionDate}
                    onChange={e => setNewInteractionDate(e.target.value)}
                    title="Date of interaction (leave blank for today)"
                  />
                  <button
                    className="crm-log-button"
                    onClick={() => handleLogInteraction(selectedContact.id)}
                    disabled={!newInteractionNote.trim()}
                  >
                    Log
                  </button>
                </div>
              </div>
              <div className="crm-interactions-list">
                <h4>Interaction History</h4>
                {loadingInteractions && contactInteractions.length === 0 && (
                  <div className="welcome-message">Loading interactions...</div>
                )}
                {!loadingInteractions && contactInteractions.length === 0 && (
                  <div className="welcome-message">No interactions logged yet.</div>
                )}
                {contactInteractions.map(interaction => (
                  <div key={interaction.id} className="crm-interaction-item">
                    <div className="crm-interaction-note">{interaction.note}</div>
                    <div className="crm-interaction-meta">
                      <span>{formatDate(interaction.occurredAt)}</span>
                      <button
                        className="crm-interaction-delete"
                        onClick={() => handleDeleteInteraction(interaction.id, selectedContact.id)}
                        title="Delete interaction"
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Contact List View */
            <>
              <div className="crm-list-header">
                <h3>Contacts</h3>
                <button className="crm-add-button" onClick={() => setShowAddContact(true)}>
                  + Add Contact
                </button>
              </div>
              {loadingContacts && crmContacts.length === 0 && (
                <div className="welcome-message">Loading contacts...</div>
              )}
              {!loadingContacts && crmContacts.length === 0 && (
                <div className="welcome-message">
                  No contacts yet.
                  <br />
                  Add someone to start tracking your relationships.
                </div>
              )}
              {crmContacts.length > 0 && (
                <div className="crm-contacts-list">
                  {crmContacts.map(contact => (
                    <button
                      key={contact.id}
                      className="crm-contact-card"
                      onClick={() => setSelectedContact(contact)}
                    >
                      <div className="crm-contact-name">
                        <span className={`crm-staleness-dot ${getStaleness(contact.lastInteraction)}`} />
                        {contact.name}
                      </div>
                      <div className="crm-contact-meta">
                        <span className="crm-contact-last">
                          {contact.lastInteraction
                            ? formatDate(contact.lastInteraction)
                            : 'Never contacted'}
                        </span>
                        <span className="crm-contact-count">
                          {contact.interactionCount} interaction{contact.interactionCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Fullscreen webcam overlay */}
        {fullscreenWebcam && (
          <div ref={fullscreenOverlayRef} className="webcam-fullscreen-overlay" onClick={handleFullscreenOverlayClick}>
            <div className="webcam-fullscreen-header">
              <span>{webcamDevices.find(d => d.id === fullscreenWebcam)?.name || fullscreenWebcam}</span>
              <button
                className="webcam-exit-fullscreen-button"
                onClick={(e) => { e.stopPropagation(); resetPinchZoom(); toggleFullscreenWebcam(null, fullscreenWebcam); }}
              >
                Exit Fullscreen
              </button>
            </div>
            {changingResolution.has(fullscreenWebcam) || !webcamFrames.has(fullscreenWebcam) ? (
              <div className="webcam-fullscreen-loading" onClick={(e) => e.stopPropagation()}>
                <div className="webcam-loading-spinner"></div>
                <span>Switching to fullscreen...</span>
              </div>
            ) : (
              <img
                ref={fullscreenImgRef}
                src={`data:image/jpeg;base64,${webcamFrames.get(fullscreenWebcam)}`}
                alt={`Webcam feed: ${fullscreenWebcam}`}
                className="webcam-fullscreen-video"
                onClick={(e) => e.stopPropagation()}
                onTouchStart={handleFullscreenTouchStart}
                onTouchMove={handleFullscreenTouchMove}
                onTouchEnd={handleFullscreenTouchEnd}
              />
            )}
          </div>
        )}

        {/* Input container - only show on terminal tab when a tab is active */}
        {activeSubTab === 'terminal' && activeTerminalTab && (
          <>
            {/* Image preview area */}
            {activeTerminalTab.pendingImages.length > 0 && (
              <div className="image-preview-container">
                {activeTerminalTab.pendingImages.map(img => (
                  <div key={img.id} className="image-preview">
                    <img src={img.preview} alt="Pending upload" />
                    <button
                      className="image-remove-button"
                      onClick={() => {
                        const tabId = activeTerminalTab.id
                        setTerminalTabs(prev => prev.map(tab =>
                          tab.id === tabId ? { ...tab, pendingImages: tab.pendingImages.filter(i => i.id !== img.id) } : tab
                        ))
                      }}
                      aria-label="Remove image"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="terminal-input-container">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
              <button
                className="image-attach-button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach image"
                title="Attach image"
              >
                +
              </button>
              <span className="input-prompt">&gt;</span>
              <textarea
                ref={inputRef}
                className="terminal-input"
                value={input}
                rows={1}
                onChange={(e) => {
                  setInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = e.target.scrollHeight + 'px'
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={activeTerminalTab.status === 'connected' ? 'Type a message or paste an image...' : `Status: ${activeTerminalTab.status}...`}
              />
              <button
                className="send-button"
                onClick={sendCommand}
                disabled={(!input.trim() && activeTerminalTab.pendingImages.length === 0) || activeTerminalTab.status === 'processing'}
                aria-label="Send message"
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App

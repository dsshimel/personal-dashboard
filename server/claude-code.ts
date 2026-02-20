/**
 * @fileoverview Claude Code CLI process manager.
 *
 * Manages spawning and communication with the Claude Code CLI, handling
 * streaming JSON output, session management, and process lifecycle.
 */

import { EventEmitter } from 'events';

const CLAUDE_PATH = Bun.which('claude') || 'claude';

/**
 * Message format from Claude CLI's stream-json output.
 * Different types indicate different stages of the conversation.
 */
export interface ClaudeMessage {
  /** Message type from Claude CLI. */
  type: 'init' | 'assistant' | 'user' | 'result' | 'system' | 'error';
  /** Session ID assigned by Claude CLI. */
  session_id?: string;
  /** Message content with text blocks and tool use blocks. */
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  /** Direct content for error messages. */
  content?: string;
  /** Result text for result type messages. */
  result?: string;
  /** Message subtype. */
  subtype?: string;
}

/**
 * Image attachment for sending to Claude.
 */
export interface ImageAttachment {
  /** Base64-encoded image data (without data URL prefix). */
  data: string;
  /** Filename for the image. */
  name: string;
  /** MIME type (defaults to image/png). */
  mimeType?: string;
}

/**
 * Event signatures emitted by ClaudeCodeManager.
 */
export interface ManagerEvents {
  /** Emitted for output, error, status changes, tool use, and completion. */
  output: (data: { type: 'output' | 'error' | 'status' | 'complete' | 'tool'; content: string }) => void;
  /** Emitted when a new session ID is assigned. */
  sessionId: (sessionId: string) => void;
  /** Emitted on process errors. */
  error: (error: Error) => void;
}

/**
 * Manages Claude Code CLI process spawning and communication.
 *
 * Handles stdin/stdout streaming, session management, and process lifecycle.
 * Emits events for output, errors, and session changes.
 */
export class ClaudeCodeManager extends EventEmitter {
  /** Current session ID for conversation continuity. */
  private sessionId: string | null = null;
  /** Currently running Claude CLI process. */
  private currentProcess: ReturnType<typeof Bun.spawn> | null = null;
  /** Directory where Claude CLI runs. */
  private workingDirectory: string;
  /** Whether a command is currently being processed. */
  private isProcessing = false;
  /** Whether the current process was intentionally aborted. */
  private wasAborted = false;

  /**
   * Creates a new ClaudeCodeManager.
   *
   * @param workingDirectory - Directory for Claude CLI execution. Defaults to cwd.
   */
  constructor(workingDirectory?: string) {
    super();
    this.workingDirectory = workingDirectory || process.cwd();
  }

  /** Returns the current session ID or null if no session. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Returns the working directory for this manager. */
  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  /**
   * Sets the session ID for resuming a previous conversation.
   *
   * @param sessionId - The session ID to resume.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    console.log('[ClaudeCode] Session ID set to:', sessionId);
  }

  /** Returns true if a command is currently being processed. */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Sends a command to Claude CLI and streams the response.
   *
   * Handles slash commands locally, spawns Claude CLI for regular prompts.
   * Emits 'output' events for responses and 'complete' when done.
   *
   * @param message - The user's prompt or slash command.
   * @param images - Optional array of image attachments.
   */
  async sendCommand(message: string, images?: ImageAttachment[]): Promise<void> {
    console.log('[ClaudeCode] sendCommand called with:', message.substring(0, 100));
    console.log('[ClaudeCode] Current sessionId:', this.sessionId);
    console.log('[ClaudeCode] isProcessing:', this.isProcessing);
    console.log('[ClaudeCode] Images attached:', images?.length || 0);

    // Handle slash commands
    if (message.startsWith('/')) {
      this.handleSlashCommand(message);
      return;
    }

    if (this.isProcessing) {
      console.log('[ClaudeCode] Already processing, rejecting command');
      this.emit('output', { type: 'error', content: 'Already processing a command' });
      return;
    }

    this.isProcessing = true;
    this.wasAborted = false;
    this.emit('output', { type: 'status', content: 'processing' });

    const args = this.buildArgs(message, images);
    console.log('[ClaudeCode] Built args:', args);

    try {
      await this.spawnClaude(args, message, images);
      console.log('[ClaudeCode] spawnClaude completed successfully');
    } catch (error) {
      console.error('[ClaudeCode] spawnClaude error:', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isProcessing = false;
      this.emit('output', { type: 'complete', content: '' });
      console.log('[ClaudeCode] Command processing finished');
    }
  }

  /**
   * Builds command-line arguments for Claude CLI.
   *
   * @param message - The user's prompt.
   * @param images - Optional array of image attachments.
   * @returns Array of CLI arguments.
   */
  private buildArgs(message: string, images?: ImageAttachment[]): string[] {
    // If we have images, use stream-json input format
    if (images && images.length > 0) {
      const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch',
      ];

      if (this.sessionId) {
        args.unshift('--resume', this.sessionId);
      }

      return args;
    }

    // No images - use simple -p flag with message
    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch',
    ];

    if (this.sessionId) {
      args.unshift('--resume', this.sessionId);
    }

    return args;
  }

  /**
   * Builds the stream-json input message with optional images.
   *
   * @param message - The user's text message.
   * @param images - Optional array of image attachments.
   * @returns JSON string for stream-json input.
   */
  private buildStreamJsonInput(message: string, images?: ImageAttachment[]): string {
    const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];

    // Add images first
    if (images && images.length > 0) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType || 'image/png',
            data: img.data,
          },
        });
      }
    }

    // Add text message
    if (message) {
      content.push({
        type: 'text',
        text: message,
      });
    }

    const inputMessage = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    };

    return JSON.stringify(inputMessage);
  }

  /**
   * Spawns Claude CLI process and streams output.
   *
   * Uses Bun.spawn for Windows compatibility. Reads stdout as streaming JSON
   * and emits parsed messages as events.
   *
   * @param args - CLI arguments to pass to claude command.
   * @param message - The user's text message (for stream-json input).
   * @param images - Optional array of image attachments.
   */
  private async spawnClaude(args: string[], message?: string, images?: ImageAttachment[]): Promise<void> {
    console.log('[ClaudeCode] Spawning claude with args:', args);
    console.log('[ClaudeCode] Working directory:', this.workingDirectory);

    // Use Bun.spawn for better Windows compatibility
    this.currentProcess = Bun.spawn([CLAUDE_PATH, ...args], {
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    });

    console.log('[ClaudeCode] Process spawned, PID:', this.currentProcess.pid);

    // If we have images, write stream-json input to stdin
    if (images && images.length > 0 && message !== undefined) {
      const inputJson = this.buildStreamJsonInput(message, images);
      console.log('[ClaudeCode] Writing stream-json input with', images.length, 'image(s)');

      // Bun's stdin is a FileSink, use write() and end()
      const stdin = this.currentProcess.stdin as { write: (data: string) => void; end: () => void };
      stdin.write(inputJson + '\n');
      stdin.end();
    } else {
      // Close stdin immediately for non-image commands
      const stdin = this.currentProcess.stdin as { end: () => void };
      stdin.end();
    }

    // Read stdout/stderr as ReadableStreams
    const stdout = this.currentProcess.stdout as ReadableStream<Uint8Array>;
    const stderr = this.currentProcess.stderr as ReadableStream<Uint8Array>;
    const stdoutReader = stdout.getReader();
    const stderrReader = stderr.getReader();

    // Process stdout
    const readStdout = async () => {
      let buffer = '';
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          console.log('[ClaudeCode] stdout chunk:', chunk.substring(0, 200));
          buffer += chunk;

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim()) {
              this.handleJsonLine(line.trim());
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          this.handleJsonLine(buffer.trim());
        }
      } catch (error) {
        console.error('[ClaudeCode] stdout read error:', error);
      }
    };

    // Process stderr
    const readStderr = async () => {
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;

          const errorText = decoder.decode(value, { stream: true });
          console.log('[ClaudeCode] stderr:', errorText);
          this.emit('output', { type: 'error', content: errorText });
        }
      } catch (error) {
        console.error('[ClaudeCode] stderr read error:', error);
      }
    };

    // Start reading both streams
    const stdoutPromise = readStdout();
    const stderrPromise = readStderr();

    // Wait for process to exit
    const exitCode = await this.currentProcess.exited;
    console.log('[ClaudeCode] Process exited with code:', exitCode);

    // Wait for streams to be fully read
    await Promise.all([stdoutPromise, stderrPromise]);

    this.currentProcess = null;

    // Don't throw error if process was intentionally aborted (exit code 143 = SIGTERM)
    if (exitCode !== 0 && !this.wasAborted) {
      throw new Error(`Claude process exited with code ${exitCode}`);
    }
    this.wasAborted = false;
  }

  /**
   * Parses a JSON line from Claude CLI output and emits appropriate events.
   *
   * @param line - A single line of JSON output from Claude CLI.
   */
  private handleJsonLine(line: string): void {
    try {
      const parsed: ClaudeMessage = JSON.parse(line);

      switch (parsed.type) {
        case 'init':
        case 'system':
          if (parsed.session_id && !this.sessionId) {
            this.sessionId = parsed.session_id;
            this.emit('sessionId', this.sessionId);
          }
          break;

        case 'assistant':
          if (parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                this.emit('output', { type: 'output', content: block.text });
              } else if (block.type === 'tool_use' && block.name) {
                const toolDetail = this.formatToolDetail(block.name, block.input);
                this.emit('output', { type: 'tool', content: toolDetail });
              }
            }
          }
          break;

        case 'result':
          // Result contains the same text as assistant message, skip to avoid duplication
          // Just log for debugging
          console.log('[ClaudeCode] Result received, cost:', (parsed as { total_cost_usd?: number }).total_cost_usd);
          break;

        case 'error':
          if (parsed.content) {
            this.emit('output', { type: 'error', content: parsed.content });
          }
          break;
      }
    } catch {
      // Not valid JSON, emit as raw output
      if (line.trim()) {
        this.emit('output', { type: 'output', content: line });
      }
    }
  }

  /**
   * Formats a human-readable description of a tool invocation.
   */
  private formatToolDetail(name: string, input?: Record<string, unknown>): string {
    if (!input) return name;

    switch (name) {
      case 'Read':
        return `Read: ${input.file_path || 'file'}`;
      case 'Write':
        return `Write: ${input.file_path || 'file'}`;
      case 'Edit':
        return `Edit: ${input.file_path || 'file'}`;
      case 'Bash':
        if (input.command) {
          const cmd = String(input.command);
          const short = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
          return `Bash: ${short}`;
        }
        return 'Bash';
      case 'Glob':
        return `Glob: ${input.pattern || 'pattern'}`;
      case 'Grep':
        return `Grep: ${input.pattern || 'pattern'}`;
      case 'WebSearch':
        return `WebSearch: ${input.query || 'query'}`;
      case 'WebFetch':
        return `WebFetch: ${input.url || 'url'}`;
      case 'Task':
        if (input.description) {
          return `Task: ${input.description}`;
        }
        return 'Task';
      case 'TodoWrite':
        return 'TodoWrite';
      default:
        return name;
    }
  }

  /** Aborts the currently running Claude CLI process. */
  abort(): void {
    if (this.currentProcess) {
      this.wasAborted = true;
      this.currentProcess.kill();
      this.currentProcess = null;
      this.isProcessing = false;
      this.emit('output', { type: 'status', content: 'aborted' });
    }
  }

  /** Resets the manager by aborting any process and clearing the session. */
  reset(): void {
    this.abort();
    this.sessionId = null;
  }

  /**
   * Handles slash commands locally without spawning Claude CLI.
   *
   * @param command - The slash command (e.g., "/help", "/reset").
   */
  private handleSlashCommand(command: string): void {
    const cmd = command.toLowerCase().trim();
    console.log('[ClaudeCode] Handling slash command:', cmd);

    switch (cmd) {
      case '/help':
        this.emit('output', {
          type: 'output',
          content: `Available commands:
/help - Show this help message
/clear - Clear the terminal (handled by UI)
/session - Show current session ID
/reset - Reset the session

Note: Most slash commands from the Claude CLI interactive mode are not available in this web interface.`
        });
        break;

      case '/session':
        if (this.sessionId) {
          this.emit('output', { type: 'output', content: `Current session: ${this.sessionId}` });
        } else {
          this.emit('output', { type: 'output', content: 'No active session. Send a message to start one.' });
        }
        break;

      case '/clear':
        this.emit('output', { type: 'status', content: 'clear' });
        break;

      case '/reset':
        this.reset();
        this.emit('output', { type: 'output', content: 'Session reset. Send a message to start a new conversation.' });
        break;

      case '/usage':
      case '/cost':
        this.emit('output', {
          type: 'output',
          content: 'Usage/cost tracking is not available in this web interface. Check the Claude Code CLI directly for usage stats.'
        });
        break;

      default:
        this.emit('output', {
          type: 'error',
          content: `Unknown command: ${command}\nType /help for available commands.`
        });
    }
  }
}

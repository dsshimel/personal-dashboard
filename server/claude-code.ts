import { EventEmitter } from 'events';

export interface ClaudeMessage {
  type: 'init' | 'assistant' | 'user' | 'result' | 'system' | 'error';
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  content?: string;
  result?: string;
  subtype?: string;
}

export interface ManagerEvents {
  output: (data: { type: 'output' | 'error' | 'status' | 'complete'; content: string }) => void;
  sessionId: (sessionId: string) => void;
  error: (error: Error) => void;
}

export class ClaudeCodeManager extends EventEmitter {
  private sessionId: string | null = null;
  private currentProcess: ReturnType<typeof Bun.spawn> | null = null;
  private workingDirectory: string;
  private isProcessing = false;
  private wasAborted = false;

  constructor(workingDirectory?: string) {
    super();
    this.workingDirectory = workingDirectory || process.cwd();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    console.log('[ClaudeCode] Session ID set to:', sessionId);
  }

  isRunning(): boolean {
    return this.isProcessing;
  }

  async sendCommand(message: string): Promise<void> {
    console.log('[ClaudeCode] sendCommand called with:', message.substring(0, 100));
    console.log('[ClaudeCode] Current sessionId:', this.sessionId);
    console.log('[ClaudeCode] isProcessing:', this.isProcessing);

    if (this.isProcessing) {
      console.log('[ClaudeCode] Already processing, rejecting command');
      this.emit('output', { type: 'error', content: 'Already processing a command' });
      return;
    }

    this.isProcessing = true;
    this.wasAborted = false;
    this.emit('output', { type: 'status', content: 'processing' });

    const args = this.buildArgs(message);
    console.log('[ClaudeCode] Built args:', args);

    try {
      await this.spawnClaude(args);
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

  private buildArgs(message: string): string[] {
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

  private async spawnClaude(args: string[]): Promise<void> {
    console.log('[ClaudeCode] Spawning claude with args:', args);
    console.log('[ClaudeCode] Working directory:', this.workingDirectory);

    // Use Bun.spawn for better Windows compatibility
    this.currentProcess = Bun.spawn(['claude', ...args], {
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    });

    console.log('[ClaudeCode] Process spawned, PID:', this.currentProcess.pid);

    // Close stdin immediately
    const stdin = this.currentProcess.stdin as { end: () => void };
    stdin.end();

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

  abort(): void {
    if (this.currentProcess) {
      this.wasAborted = true;
      this.currentProcess.kill();
      this.currentProcess = null;
      this.isProcessing = false;
      this.emit('output', { type: 'status', content: 'aborted' });
    }
  }

  reset(): void {
    this.abort();
    this.sessionId = null;
  }
}

/**
 * @fileoverview Project manager for the personal dashboard.
 *
 * Handles CRUD operations for projects, auto-detection of GitHub URLs
 * from git remotes, and SQLite-based persistence. On first run, migrates
 * existing projects.json data into the database.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { Database } from 'bun:sqlite';
import { getDb, getConfigDir } from './db.js';

/** Represents a project with a directory and optional GitHub link. */
export interface Project {
  /** Unique identifier (slugified directory name). */
  id: string;
  /** Display name (directory basename). */
  name: string;
  /** Absolute path to the project directory. */
  directory: string;
  /** GitHub repository URL, if detected from git remote. */
  githubUrl: string | null;
  /** Last used Claude conversation ID for quick resume. */
  lastConversationId: string | null;
  /** Explicit list of conversation IDs associated with this project. */
  conversationIds: string[];
  /** Whether the project directory exists on this machine. */
  available: boolean;
}

/**
 * Initializes the projects tables in the database and runs JSON migration if needed.
 *
 * @param db - The SQLite database instance.
 */
export function initProjectsDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      directory TEXT NOT NULL UNIQUE,
      github_url TEXT,
      last_conversation_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS project_conversations (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      PRIMARY KEY (project_id, conversation_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // Migrate from projects.json if it exists
  migrateFromJson(db);
}

/**
 * One-time migration from projects.json to SQLite.
 * Imports data and renames the file to projects.json.bak.
 */
function migrateFromJson(db: Database): void {
  const jsonPath = join(getConfigDir(), 'projects.json');

  if (!existsSync(jsonPath)) return;

  try {
    // Read synchronously since this runs at startup
    const content = require('fs').readFileSync(jsonPath, 'utf-8');
    const projects: Array<{
      id: string;
      name: string;
      directory: string;
      githubUrl: string | null;
      lastConversationId: string | null;
      conversationIds?: string[];
    }> = JSON.parse(content);

    const insertProject = db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, directory, github_url, last_conversation_id) VALUES (?, ?, ?, ?, ?)'
    );
    const insertConv = db.prepare(
      'INSERT OR IGNORE INTO project_conversations (project_id, conversation_id) VALUES (?, ?)'
    );

    const migrate = db.transaction(() => {
      for (const p of projects) {
        insertProject.run(p.id, p.name, p.directory, p.githubUrl, p.lastConversationId);
        if (p.conversationIds) {
          for (const convId of p.conversationIds) {
            insertConv.run(p.id, convId);
          }
        }
      }
    });

    migrate();

    // Rename the old file so migration doesn't run again
    const bakPath = join(getConfigDir(), 'projects.json.bak');
    require('fs').renameSync(jsonPath, bakPath);
  } catch {
    // If migration fails, the file stays and we'll retry next startup
  }
}

/**
 * Generates a URL-safe slug from a string.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Row shape returned from the projects table. */
interface ProjectRow {
  id: string;
  name: string;
  directory: string;
  github_url: string | null;
  last_conversation_id: string | null;
}

/**
 * Converts a database row + conversation IDs into a Project object.
 */
function rowToProject(row: ProjectRow, conversationIds: string[]): Project {
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    githubUrl: row.github_url,
    lastConversationId: row.last_conversation_id,
    conversationIds,
    available: existsSync(row.directory),
  };
}

/**
 * Loads all projects from the database.
 *
 * @returns Array of projects.
 */
export async function loadProjects(): Promise<Project[]> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects').all() as ProjectRow[];

  return rows.map(row => {
    const convRows = db.prepare(
      'SELECT conversation_id FROM project_conversations WHERE project_id = ?'
    ).all(row.id) as Array<{ conversation_id: string }>;
    const conversationIds = convRows.map(c => c.conversation_id);
    return rowToProject(row, conversationIds);
  });
}

/**
 * Detects the GitHub URL from a git repository's origin remote.
 *
 * @param directory - Path to the directory to check.
 * @returns GitHub URL or null if not a git repo or no GitHub remote.
 */
export async function detectGitHubUrl(directory: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    let url = '';
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      url += decoder.decode(value, { stream: true });
    }

    url = url.trim();
    if (!url) return null;

    // Convert SSH URLs to HTTPS: git@github.com:user/repo.git -> https://github.com/user/repo
    if (url.startsWith('git@github.com:')) {
      url = url.replace('git@github.com:', 'https://github.com/');
    }

    // Remove .git suffix
    if (url.endsWith('.git')) {
      url = url.slice(0, -4);
    }

    // Only return if it's a GitHub URL
    if (url.includes('github.com')) {
      return url;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Adds a new project.
 *
 * @param directory - Absolute path to the project directory.
 * @returns The newly created project.
 * @throws If the directory is already registered as a project.
 */
export async function addProject(directory: string, options?: { skipGitDetection?: boolean }): Promise<Project> {
  const db = getDb();

  // Validate that the directory exists on this machine
  if (!existsSync(directory)) {
    throw new Error(`Directory does not exist: ${directory}`);
  }

  // Normalize path separators
  const normalizedDir = directory.replace(/\\/g, '/');

  // Check for duplicates (normalize stored paths too)
  const existing = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
  const allProjects = db.prepare('SELECT * FROM projects').all() as ProjectRow[];
  if (allProjects.some(p => p.directory.replace(/\\/g, '/') === normalizedDir)) {
    throw new Error(`Project already exists for directory: ${directory}`);
  }

  const name = basename(directory);
  const id = slugify(name) || 'project';

  // Ensure unique ID
  let uniqueId = id;
  let counter = 2;
  const existingIds = new Set(existing.map(e => e.id));
  while (existingIds.has(uniqueId)) {
    uniqueId = `${id}-${counter++}`;
  }

  const githubUrl = options?.skipGitDetection ? null : await detectGitHubUrl(directory);

  db.prepare(
    'INSERT INTO projects (id, name, directory, github_url, last_conversation_id) VALUES (?, ?, ?, ?, ?)'
  ).run(uniqueId, name, directory, githubUrl, null);

  return {
    id: uniqueId,
    name,
    directory,
    githubUrl,
    lastConversationId: null,
    conversationIds: [],
    available: true,
  };
}

/**
 * Removes a project by ID.
 *
 * @param id - The project ID to remove.
 * @throws If the project is not found.
 */
export async function removeProject(id: string): Promise<void> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);

  if (!existing) {
    throw new Error(`Project not found: ${id}`);
  }

  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/**
 * Updates the last conversation ID for a project.
 *
 * @param id - The project ID to update.
 * @param conversationId - The conversation ID to store.
 */
export async function updateProjectConversation(id: string, conversationId: string): Promise<void> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);

  if (existing) {
    db.prepare('UPDATE projects SET last_conversation_id = ? WHERE id = ?').run(conversationId, id);
    db.prepare(
      'INSERT OR IGNORE INTO project_conversations (project_id, conversation_id) VALUES (?, ?)'
    ).run(id, conversationId);
  }
}

/**
 * Manually adds a conversation ID to a project's list.
 *
 * @param projectId - The project ID to add the conversation to.
 * @param conversationId - The conversation ID to add.
 * @throws If the project is not found or conversation is already associated.
 */
export async function addConversationToProject(projectId: string, conversationId: string): Promise<void> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);

  if (!existing) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const existingConv = db.prepare(
    'SELECT conversation_id FROM project_conversations WHERE project_id = ? AND conversation_id = ?'
  ).get(projectId, conversationId);

  if (existingConv) {
    throw new Error(`Conversation ${conversationId} is already associated with project ${projectId}`);
  }

  db.prepare(
    'INSERT INTO project_conversations (project_id, conversation_id) VALUES (?, ?)'
  ).run(projectId, conversationId);
}

/**
 * Removes a conversation ID from a project's list.
 *
 * @param projectId - The project ID.
 * @param conversationId - The conversation ID to remove.
 * @throws If the project is not found.
 */
export async function removeConversationFromProject(projectId: string, conversationId: string): Promise<void> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);

  if (!existing) {
    throw new Error(`Project not found: ${projectId}`);
  }

  db.prepare(
    'DELETE FROM project_conversations WHERE project_id = ? AND conversation_id = ?'
  ).run(projectId, conversationId);

  // Update lastConversationId if we just removed it
  const project = db.prepare('SELECT last_conversation_id FROM projects WHERE id = ?').get(projectId) as { last_conversation_id: string | null } | null;
  if (project && project.last_conversation_id === conversationId) {
    // Set to the most recently added remaining conversation, or null
    const latest = db.prepare(
      'SELECT conversation_id FROM project_conversations WHERE project_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(projectId) as { conversation_id: string } | null;

    db.prepare('UPDATE projects SET last_conversation_id = ? WHERE id = ?').run(
      latest ? latest.conversation_id : null,
      projectId
    );
  }
}

/**
 * Extracts a display name from a JSONL conversation file.
 * Checks for slug first, then first user message text.
 */
async function extractConversationName(filePath: string, sessionId: string): Promise<string> {
  let name = sessionId.substring(0, 8) + '...';
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines.slice(0, 20)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (parsed.slug && typeof parsed.slug === 'string') {
          name = parsed.slug
            .split('-')
            .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          break;
        }

        if (parsed.type === 'user' && parsed.message) {
          let text = '';
          if (typeof parsed.message.content === 'string') {
            text = parsed.message.content;
          } else if (Array.isArray(parsed.message.content)) {
            const textBlock = parsed.message.content.find(
              (c: { type: string; text?: string }) => c.type === 'text' && c.text
            );
            text = textBlock?.text || '';
          }
          if (text) {
            name = text.replace(/\s+/g, ' ').trim().substring(0, 80);
            break;
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch {
    // Ignore file read errors
  }
  return name;
}

/**
 * Lists conversations explicitly associated with a project.
 *
 * Only returns conversations whose IDs are stored in the project's
 * conversationIds list. Looks up JSONL files in ~/.claude/projects/
 * for metadata (name, last modified).
 *
 * @param directory - The project directory to find conversations for.
 * @returns Array of conversation metadata.
 */
export async function listProjectConversations(directory: string): Promise<Array<{
  id: string;
  name: string;
  lastModified: Date;
  project: string;
}>> {
  const db = getDb();
  const normalizedDir = directory.replace(/\\/g, '/');

  // Find the project by directory
  const allProjects = db.prepare('SELECT * FROM projects').all() as ProjectRow[];
  const project = allProjects.find(p => p.directory.replace(/\\/g, '/') === normalizedDir);

  if (!project) return [];

  const convRows = db.prepare(
    'SELECT conversation_id FROM project_conversations WHERE project_id = ?'
  ).all(project.id) as Array<{ conversation_id: string }>;

  if (convRows.length === 0) return [];

  const conversationIds = convRows.map(c => c.conversation_id);
  const claudeDir = join(homedir(), '.claude', 'projects');
  const conversations: Array<{
    id: string;
    name: string;
    lastModified: Date;
    project: string;
  }> = [];

  try {
    const projectDirs = await readdir(claudeDir, { withFileTypes: true });

    for (const conversationId of conversationIds) {
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;

        const filePath = join(claudeDir, projectDir.name, `${conversationId}.jsonl`);
        try {
          const stats = await Bun.file(filePath).stat();
          if (!stats) continue;

          const name = await extractConversationName(filePath, conversationId);

          conversations.push({
            id: conversationId,
            name,
            lastModified: stats.mtime || new Date(),
            project: projectDir.name,
          });
          break; // Found the file, no need to check other directories
        } catch {
          // File not found in this directory, try next
        }
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist yet
  }

  conversations.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

  return conversations;
}

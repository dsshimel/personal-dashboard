/**
 * @fileoverview Project manager for the personal dashboard.
 *
 * Handles CRUD operations for projects, auto-detection of GitHub URLs
 * from git remotes, and file-based persistence of project data.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';

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
}

/** Default directory where dashboard config is stored. */
const DEFAULT_CONFIG_DIR = join(homedir(), '.personal-dashboard');

/** Returns the config directory, using override if set (for testing). */
let configDirOverride: string | null = null;

/** Returns the current config directory path. */
export function getConfigDir(): string {
  return configDirOverride || DEFAULT_CONFIG_DIR;
}

/** Returns the current projects file path. */
export function getProjectsFile(): string {
  return join(getConfigDir(), 'projects.json');
}

/**
 * Overrides the config directory path (for testing).
 * Pass null to reset to default.
 */
export function setConfigDir(dir: string | null): void {
  configDirOverride = dir;
}

/**
 * Ensures the config directory exists.
 */
async function ensureConfigDir(): Promise<void> {
  try {
    await mkdir(getConfigDir(), { recursive: true });
  } catch {
    // Directory already exists
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

/**
 * Loads all projects from disk.
 *
 * @returns Array of projects, or empty array if file doesn't exist.
 */
export async function loadProjects(): Promise<Project[]> {
  try {
    const content = await readFile(getProjectsFile(), 'utf-8');
    const raw: Array<Omit<Project, 'conversationIds'> & { conversationIds?: string[] }> = JSON.parse(content);
    return raw.map(p => ({
      ...p,
      conversationIds: p.conversationIds || [],
    }));
  } catch {
    return [];
  }
}

/**
 * Saves all projects to disk.
 *
 * @param projects - The full list of projects to persist.
 */
export async function saveProjects(projects: Project[]): Promise<void> {
  await ensureConfigDir();
  await writeFile(getProjectsFile(), JSON.stringify(projects, null, 2), 'utf-8');
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
export async function addProject(directory: string): Promise<Project> {
  const projects = await loadProjects();

  // Normalize path separators
  const normalizedDir = directory.replace(/\\/g, '/');

  // Check for duplicates
  if (projects.some(p => p.directory.replace(/\\/g, '/') === normalizedDir)) {
    throw new Error(`Project already exists for directory: ${directory}`);
  }

  const name = basename(directory);
  const id = slugify(name) || 'project';

  // Ensure unique ID
  let uniqueId = id;
  let counter = 2;
  while (projects.some(p => p.id === uniqueId)) {
    uniqueId = `${id}-${counter++}`;
  }

  const githubUrl = await detectGitHubUrl(directory);

  const project: Project = {
    id: uniqueId,
    name,
    directory,
    githubUrl,
    lastConversationId: null,
    conversationIds: [],
  };

  projects.push(project);
  await saveProjects(projects);

  return project;
}

/**
 * Removes a project by ID.
 *
 * @param id - The project ID to remove.
 * @throws If the project is not found.
 */
export async function removeProject(id: string): Promise<void> {
  const projects = await loadProjects();
  const index = projects.findIndex(p => p.id === id);

  if (index === -1) {
    throw new Error(`Project not found: ${id}`);
  }

  projects.splice(index, 1);
  await saveProjects(projects);
}

/**
 * Updates the last conversation ID for a project.
 *
 * @param id - The project ID to update.
 * @param conversationId - The conversation ID to store.
 */
export async function updateProjectConversation(id: string, conversationId: string): Promise<void> {
  const projects = await loadProjects();
  const project = projects.find(p => p.id === id);

  if (project) {
    project.lastConversationId = conversationId;
    if (!project.conversationIds.includes(conversationId)) {
      project.conversationIds.push(conversationId);
    }
    await saveProjects(projects);
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
  const projects = await loadProjects();
  const project = projects.find(p => p.id === projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  if (project.conversationIds.includes(conversationId)) {
    throw new Error(`Conversation ${conversationId} is already associated with project ${projectId}`);
  }

  project.conversationIds.push(conversationId);
  await saveProjects(projects);
}

/**
 * Removes a conversation ID from a project's list.
 *
 * @param projectId - The project ID.
 * @param conversationId - The conversation ID to remove.
 * @throws If the project is not found.
 */
export async function removeConversationFromProject(projectId: string, conversationId: string): Promise<void> {
  const projects = await loadProjects();
  const project = projects.find(p => p.id === projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const index = project.conversationIds.indexOf(conversationId);
  if (index !== -1) {
    project.conversationIds.splice(index, 1);
  }

  if (project.lastConversationId === conversationId) {
    project.lastConversationId = project.conversationIds.length > 0
      ? project.conversationIds[project.conversationIds.length - 1]
      : null;
  }

  await saveProjects(projects);
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
  const projects = await loadProjects();
  const normalizedDir = directory.replace(/\\/g, '/');
  const project = projects.find(p => p.directory.replace(/\\/g, '/') === normalizedDir);

  if (!project || project.conversationIds.length === 0) {
    return [];
  }

  const claudeDir = join(homedir(), '.claude', 'projects');
  const conversations: Array<{
    id: string;
    name: string;
    lastModified: Date;
    project: string;
  }> = [];

  try {
    const projectDirs = await readdir(claudeDir, { withFileTypes: true });

    for (const conversationId of project.conversationIds) {
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

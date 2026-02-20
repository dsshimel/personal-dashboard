/**
 * @fileoverview Unit tests for the projects module.
 *
 * Tests CRUD operations, slug generation, and SQLite-based persistence.
 * Git-related tests (detectGitHubUrl, ClaudeCodeManager) are in
 * projects-git.test.ts to avoid Bun Windows crash when bun:sqlite
 * and Bun.spawn coexist in the same process.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';
import {
  loadProjects,
  addProject,
  removeProject,
  updateProjectConversation,
  addConversationToProject,
  removeConversationFromProject,
  slugify,
  initProjectsDb,
} from '../../server/projects';
import { initDb, closeDb, setConfigDir } from '../../server/db';

describe('slugify', () => {
  test('converts text to lowercase slug', () => {
    expect(slugify('My Project')).toBe('my-project');
  });

  test('replaces special characters with hyphens', () => {
    expect(slugify('hello_world@2024')).toBe('hello-world-2024');
  });

  test('removes leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  test('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  test('handles string with only special characters', () => {
    expect(slugify('!@#$%')).toBe('');
  });

  test('collapses multiple hyphens', () => {
    expect(slugify('a   b   c')).toBe('a-b-c');
  });
});

describe('Projects Module - SQLite CRUD', () => {
  /** Temporary directory for test database files. */
  let testDir: string;

  /** Set up a temp database before each test. */
  beforeEach(async () => {
    testDir = join(tmpdir(), `projects-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    setConfigDir(testDir);
    const dbPath = join(testDir, 'test.db');
    const db = initDb(dbPath);
    initProjectsDb(db);
  });

  /** Close the database and clean up after each test. */
  afterEach(async () => {
    closeDb();
    setConfigDir(null);
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadProjects', () => {
    test('returns empty array when no projects exist', async () => {
      const projects = await loadProjects();
      expect(projects).toEqual([]);
    });

    test('loads projects after adding them', async () => {
      const projectDir = join(testDir, 'test-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].directory).toBe(projectDir);
      expect(projects[0].conversationIds).toEqual([]);
      expect(projects[0].available).toBe(true);
    });

    test('marks projects with missing directories as unavailable', async () => {
      const projectDir = join(testDir, 'will-be-removed');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });
      await rm(projectDir, { recursive: true, force: true });

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].available).toBe(false);
    });
  });

  describe('addProject', () => {
    test('adds a new project and returns it', async () => {
      const project = await addProject(process.cwd(), { skipGitDetection: true });

      expect(project.id).toBeTruthy();
      expect(project.name).toBeTruthy();
      expect(project.directory).toBe(process.cwd());
      expect(project.lastConversationId).toBeNull();
      expect(project.available).toBe(true);
    });

    test('persists the project to the database', async () => {
      await addProject(process.cwd(), { skipGitDetection: true });

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].directory).toBe(process.cwd());
    });

    test('generates ID from directory basename', async () => {
      const projectDir = join(testDir, 'my-cool-project');
      await mkdir(projectDir, { recursive: true });
      const project = await addProject(projectDir, { skipGitDetection: true });

      expect(project.id).toBe('my-cool-project');
      expect(project.name).toBe('my-cool-project');
    });

    test('throws on duplicate directory', async () => {
      const projectDir = join(testDir, 'project-a');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      try {
        await addProject(projectDir, { skipGitDetection: true });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('already exists');
      }
    });

    test('throws when directory does not exist', async () => {
      try {
        await addProject('/nonexistent/path/my-project', { skipGitDetection: true });
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('does not exist');
      }
    });

    test('generates unique IDs for same-named directories', async () => {
      const dir1 = join(testDir, 'one', 'myproject');
      const dir2 = join(testDir, 'two', 'myproject');
      const dir3 = join(testDir, 'three', 'myproject');
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await mkdir(dir3, { recursive: true });

      await addProject(dir1, { skipGitDetection: true });
      const second = await addProject(dir2, { skipGitDetection: true });

      expect(second.id).toBe('myproject-2');

      const third = await addProject(dir3, { skipGitDetection: true });
      expect(third.id).toBe('myproject-3');
    });

    test('new project has empty conversationIds', async () => {
      const projectDir = join(testDir, 'new-project');
      await mkdir(projectDir, { recursive: true });
      const project = await addProject(projectDir, { skipGitDetection: true });

      expect(project.conversationIds).toEqual([]);
    });
  });

  describe('removeProject', () => {
    test('removes an existing project', async () => {
      const projectDir = join(testDir, 'project-to-remove');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      const before = await loadProjects();
      expect(before.length).toBe(1);

      await removeProject('project-to-remove');

      const after = await loadProjects();
      expect(after.length).toBe(0);
    });

    test('throws when project not found', async () => {
      try {
        await removeProject('nonexistent');
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('not found');
      }
    });

    test('preserves other projects when removing one', async () => {
      const dir1 = join(testDir, 'keep-this');
      const dir2 = join(testDir, 'remove-this');
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await addProject(dir1, { skipGitDetection: true });
      await addProject(dir2, { skipGitDetection: true });

      await removeProject('remove-this');

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].id).toBe('keep-this');
    });

    test('cascades deletion to project_conversations', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });
      await addConversationToProject('my-project', 'conv-1');
      await addConversationToProject('my-project', 'conv-2');

      await removeProject('my-project');

      const projects = await loadProjects();
      expect(projects.length).toBe(0);
    });
  });

  describe('updateProjectConversation', () => {
    test('updates the lastConversationId', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBe('conv-abc-123');
    });

    test('does nothing for nonexistent project ID', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      // Should not throw
      await updateProjectConversation('nonexistent', 'conv-xyz');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBeNull();
    });

    test('preserves other project fields', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-new');

      const projects = await loadProjects();
      expect(projects[0].id).toBe('my-project');
      expect(projects[0].name).toBe('my-project');
      expect(projects[0].directory).toBe(projectDir);
      expect(projects[0].lastConversationId).toBe('conv-new');
    });

    test('adds conversationId to conversationIds array', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toContain('conv-abc-123');
    });

    test('does not duplicate conversationId in conversationIds', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-abc-123');
      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].conversationIds.filter(id => id === 'conv-abc-123').length).toBe(1);
    });

    test('accumulates multiple conversation IDs', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-1');
      await updateProjectConversation('my-project', 'conv-2');
      await updateProjectConversation('my-project', 'conv-3');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toEqual(['conv-1', 'conv-2', 'conv-3']);
      expect(projects[0].lastConversationId).toBe('conv-3');
    });
  });

  describe('addConversationToProject', () => {
    test('adds a conversation ID to the project', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await addConversationToProject('my-project', 'conv-manual-1');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toContain('conv-manual-1');
    });

    test('throws for nonexistent project', async () => {
      try {
        await addConversationToProject('nonexistent', 'conv-1');
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('not found');
      }
    });

    test('throws for duplicate conversation', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });
      await addConversationToProject('my-project', 'conv-1');

      try {
        await addConversationToProject('my-project', 'conv-1');
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('already associated');
      }
    });
  });

  describe('removeConversationFromProject', () => {
    test('removes a conversation ID from the project', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });
      await addConversationToProject('my-project', 'conv-1');
      await addConversationToProject('my-project', 'conv-2');

      await removeConversationFromProject('my-project', 'conv-1');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toEqual(['conv-2']);
    });

    test('throws for nonexistent project', async () => {
      try {
        await removeConversationFromProject('nonexistent', 'conv-1');
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('not found');
      }
    });

    test('no-op for conversation not in list', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });

      await removeConversationFromProject('my-project', 'conv-not-there');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toEqual([]);
    });

    test('clears lastConversationId when removed conversation was last', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });
      await updateProjectConversation('my-project', 'conv-1');

      await removeConversationFromProject('my-project', 'conv-1');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBeNull();
      expect(projects[0].conversationIds).toEqual([]);
    });

    test('updates lastConversationId to latest remaining', async () => {
      const projectDir = join(testDir, 'my-project');
      await mkdir(projectDir, { recursive: true });
      await addProject(projectDir, { skipGitDetection: true });
      await updateProjectConversation('my-project', 'conv-1');
      await updateProjectConversation('my-project', 'conv-2');

      await removeConversationFromProject('my-project', 'conv-2');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBe('conv-1');
    });
  });
});


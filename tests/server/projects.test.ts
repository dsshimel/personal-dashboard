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
      await addProject('/home/user/test-project', { skipGitDetection: true });

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].directory).toBe('/home/user/test-project');
      expect(projects[0].conversationIds).toEqual([]);
    });
  });

  describe('addProject', () => {
    test('adds a new project and returns it', async () => {
      const project = await addProject(process.cwd(), { skipGitDetection: true });

      expect(project.id).toBeTruthy();
      expect(project.name).toBeTruthy();
      expect(project.directory).toBe(process.cwd());
      expect(project.lastConversationId).toBeNull();
    });

    test('persists the project to the database', async () => {
      await addProject(process.cwd(), { skipGitDetection: true });

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].directory).toBe(process.cwd());
    });

    test('generates ID from directory basename', async () => {
      const project = await addProject('/some/path/my-cool-project', { skipGitDetection: true });

      expect(project.id).toBe('my-cool-project');
      expect(project.name).toBe('my-cool-project');
    });

    test('throws on duplicate directory', async () => {
      await addProject('/test/dir/project-a', { skipGitDetection: true });

      try {
        await addProject('/test/dir/project-a', { skipGitDetection: true });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('already exists');
      }
    });

    test('normalizes path separators for duplicate detection', async () => {
      await addProject('/test/dir/project-a', { skipGitDetection: true });

      // Same path with different separators should be detected as duplicate
      try {
        await addProject('\\test\\dir\\project-a', { skipGitDetection: true });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('already exists');
      }
    });

    test('generates unique IDs for same-named directories', async () => {
      await addProject('/path/one/myproject', { skipGitDetection: true });
      const second = await addProject('/path/two/myproject', { skipGitDetection: true });

      expect(second.id).toBe('myproject-2');

      const third = await addProject('/path/three/myproject', { skipGitDetection: true });
      expect(third.id).toBe('myproject-3');
    });

    test('falls back to "project" ID for empty slug', async () => {
      // Directory name that slugifies to empty string
      const project = await addProject('/path/to/!@#$', { skipGitDetection: true });

      expect(project.id).toBe('project');
    });

    test('new project has empty conversationIds', async () => {
      const project = await addProject('/test/new-project', { skipGitDetection: true });

      expect(project.conversationIds).toEqual([]);
    });
  });

  describe('removeProject', () => {
    test('removes an existing project', async () => {
      await addProject('/test/project-to-remove', { skipGitDetection: true });

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
      await addProject('/test/keep-this', { skipGitDetection: true });
      await addProject('/test/remove-this', { skipGitDetection: true });

      await removeProject('remove-this');

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].id).toBe('keep-this');
    });

    test('cascades deletion to project_conversations', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });
      await addConversationToProject('my-project', 'conv-1');
      await addConversationToProject('my-project', 'conv-2');

      await removeProject('my-project');

      const projects = await loadProjects();
      expect(projects.length).toBe(0);
    });
  });

  describe('updateProjectConversation', () => {
    test('updates the lastConversationId', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBe('conv-abc-123');
    });

    test('does nothing for nonexistent project ID', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });

      // Should not throw
      await updateProjectConversation('nonexistent', 'conv-xyz');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBeNull();
    });

    test('preserves other project fields', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-new');

      const projects = await loadProjects();
      expect(projects[0].id).toBe('my-project');
      expect(projects[0].name).toBe('my-project');
      expect(projects[0].directory).toBe('/test/my-project');
      expect(projects[0].lastConversationId).toBe('conv-new');
    });

    test('adds conversationId to conversationIds array', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toContain('conv-abc-123');
    });

    test('does not duplicate conversationId in conversationIds', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });

      await updateProjectConversation('my-project', 'conv-abc-123');
      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].conversationIds.filter(id => id === 'conv-abc-123').length).toBe(1);
    });

    test('accumulates multiple conversation IDs', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });

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
      await addProject('/test/my-project', { skipGitDetection: true });

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
      await addProject('/test/my-project', { skipGitDetection: true });
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
      await addProject('/test/my-project', { skipGitDetection: true });
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
      await addProject('/test/my-project', { skipGitDetection: true });

      await removeConversationFromProject('my-project', 'conv-not-there');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toEqual([]);
    });

    test('clears lastConversationId when removed conversation was last', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });
      await updateProjectConversation('my-project', 'conv-1');

      await removeConversationFromProject('my-project', 'conv-1');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBeNull();
      expect(projects[0].conversationIds).toEqual([]);
    });

    test('updates lastConversationId to latest remaining', async () => {
      await addProject('/test/my-project', { skipGitDetection: true });
      await updateProjectConversation('my-project', 'conv-1');
      await updateProjectConversation('my-project', 'conv-2');

      await removeConversationFromProject('my-project', 'conv-2');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBe('conv-1');
    });
  });
});


/**
 * @fileoverview Unit tests for the projects module.
 *
 * Tests CRUD operations, slug generation, GitHub URL detection,
 * and file-based persistence of project data.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadProjects,
  saveProjects,
  addProject,
  removeProject,
  updateProjectConversation,
  addConversationToProject,
  removeConversationFromProject,
  detectGitHubUrl,
  slugify,
  setConfigDir,
  getProjectsFile,
  type Project,
} from '../../server/projects';

/** Temporary directory used for test isolation. */
let testDir: string;

/** Creates a unique temp directory for each test. */
async function createTestDir(): Promise<string> {
  const dir = join(tmpdir(), `projects-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('Projects Module', () => {
  beforeEach(async () => {
    testDir = await createTestDir();
    setConfigDir(testDir);
  });

  afterEach(async () => {
    setConfigDir(null);
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

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

  describe('loadProjects', () => {
    test('returns empty array when file does not exist', async () => {
      const projects = await loadProjects();
      expect(projects).toEqual([]);
    });

    test('loads projects from existing file', async () => {
      const data: Project[] = [
        {
          id: 'test-project',
          name: 'test-project',
          directory: '/home/user/test-project',
          githubUrl: null,
          lastConversationId: null,
          conversationIds: [],
        },
      ];
      await writeFile(getProjectsFile(), JSON.stringify(data), 'utf-8');

      const projects = await loadProjects();
      expect(projects).toEqual(data);
    });

    test('returns empty array on invalid JSON', async () => {
      await writeFile(getProjectsFile(), 'not valid json', 'utf-8');

      const projects = await loadProjects();
      expect(projects).toEqual([]);
    });
  });

  describe('saveProjects', () => {
    test('writes projects to file as formatted JSON', async () => {
      const data: Project[] = [
        {
          id: 'my-app',
          name: 'my-app',
          directory: '/home/user/my-app',
          githubUrl: 'https://github.com/user/my-app',
          lastConversationId: 'conv-123',
        },
      ];

      await saveProjects(data);

      const content = await readFile(getProjectsFile(), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(data);
    });

    test('creates config directory if it does not exist', async () => {
      // Use a nested directory that doesn't exist yet
      const nestedDir = join(testDir, 'nested', 'deep');
      setConfigDir(nestedDir);

      await saveProjects([]);

      const content = await readFile(join(nestedDir, 'projects.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual([]);
    });

    test('overwrites existing file', async () => {
      const first: Project[] = [
        { id: 'a', name: 'a', directory: '/a', githubUrl: null, lastConversationId: null, conversationIds: [] },
      ];
      const second: Project[] = [
        { id: 'b', name: 'b', directory: '/b', githubUrl: null, lastConversationId: null, conversationIds: [] },
      ];

      await saveProjects(first);
      await saveProjects(second);

      const projects = await loadProjects();
      expect(projects).toEqual(second);
    });
  });

  describe('addProject', () => {
    test('adds a new project and returns it', async () => {
      // Use current working directory since it exists
      const project = await addProject(process.cwd());

      expect(project.id).toBeTruthy();
      expect(project.name).toBeTruthy();
      expect(project.directory).toBe(process.cwd());
      expect(project.lastConversationId).toBeNull();
    });

    test('persists the project to disk', async () => {
      await addProject(process.cwd());

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].directory).toBe(process.cwd());
    });

    test('generates ID from directory basename', async () => {
      const project = await addProject('/some/path/my-cool-project');

      expect(project.id).toBe('my-cool-project');
      expect(project.name).toBe('my-cool-project');
    });

    test('throws on duplicate directory', async () => {
      await addProject('/test/dir/project-a');

      try {
        await addProject('/test/dir/project-a');
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('already exists');
      }
    });

    test('normalizes path separators for duplicate detection', async () => {
      await addProject('/test/dir/project-a');

      // Same path with different separators should be detected as duplicate
      try {
        await addProject('\\test\\dir\\project-a');
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('already exists');
      }
    });

    test('generates unique IDs for same-named directories', async () => {
      await addProject('/path/one/myproject');
      const second = await addProject('/path/two/myproject');

      expect(second.id).toBe('myproject-2');

      const third = await addProject('/path/three/myproject');
      expect(third.id).toBe('myproject-3');
    });

    test('falls back to "project" ID for empty slug', async () => {
      // Directory name that slugifies to empty string
      const project = await addProject('/path/to/!@#$');

      expect(project.id).toBe('project');
    });
  });

  describe('removeProject', () => {
    test('removes an existing project', async () => {
      await addProject('/test/project-to-remove');

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
      await addProject('/test/keep-this');
      await addProject('/test/remove-this');

      await removeProject('remove-this');

      const projects = await loadProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].id).toBe('keep-this');
    });
  });

  describe('updateProjectConversation', () => {
    test('updates the lastConversationId', async () => {
      await addProject('/test/my-project');

      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBe('conv-abc-123');
    });

    test('does nothing for nonexistent project ID', async () => {
      await addProject('/test/my-project');

      // Should not throw
      await updateProjectConversation('nonexistent', 'conv-xyz');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBeNull();
    });

    test('preserves other project fields', async () => {
      await addProject('/test/my-project');

      await updateProjectConversation('my-project', 'conv-new');

      const projects = await loadProjects();
      expect(projects[0].id).toBe('my-project');
      expect(projects[0].name).toBe('my-project');
      expect(projects[0].directory).toBe('/test/my-project');
      expect(projects[0].lastConversationId).toBe('conv-new');
    });

    test('adds conversationId to conversationIds array', async () => {
      await addProject('/test/my-project');

      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toContain('conv-abc-123');
    });

    test('does not duplicate conversationId in conversationIds', async () => {
      await addProject('/test/my-project');

      await updateProjectConversation('my-project', 'conv-abc-123');
      await updateProjectConversation('my-project', 'conv-abc-123');

      const projects = await loadProjects();
      expect(projects[0].conversationIds.filter(id => id === 'conv-abc-123').length).toBe(1);
    });

    test('accumulates multiple conversation IDs', async () => {
      await addProject('/test/my-project');

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
      await addProject('/test/my-project');

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
      await addProject('/test/my-project');
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
      await addProject('/test/my-project');
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
      await addProject('/test/my-project');

      await removeConversationFromProject('my-project', 'conv-not-there');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toEqual([]);
    });

    test('clears lastConversationId when removed conversation was last', async () => {
      await addProject('/test/my-project');
      await updateProjectConversation('my-project', 'conv-1');

      await removeConversationFromProject('my-project', 'conv-1');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBeNull();
      expect(projects[0].conversationIds).toEqual([]);
    });

    test('updates lastConversationId to latest remaining', async () => {
      await addProject('/test/my-project');
      await updateProjectConversation('my-project', 'conv-1');
      await updateProjectConversation('my-project', 'conv-2');

      await removeConversationFromProject('my-project', 'conv-2');

      const projects = await loadProjects();
      expect(projects[0].lastConversationId).toBe('conv-1');
    });
  });

  describe('loadProjects backward compatibility', () => {
    test('defaults conversationIds to empty array for old format', async () => {
      const oldData = [{
        id: 'old-project',
        name: 'old-project',
        directory: '/old/path',
        githubUrl: null,
        lastConversationId: 'conv-old',
      }];
      await writeFile(getProjectsFile(), JSON.stringify(oldData), 'utf-8');

      const projects = await loadProjects();
      expect(projects[0].conversationIds).toEqual([]);
      expect(projects[0].lastConversationId).toBe('conv-old');
    });
  });

  describe('addProject includes conversationIds', () => {
    test('new project has empty conversationIds', async () => {
      const project = await addProject('/test/new-project');

      expect(project.conversationIds).toEqual([]);
    });
  });

  describe('detectGitHubUrl', () => {
    test('detects GitHub URL from current repo', async () => {
      // This test runs inside the personal-dashboard repo, which should have a GitHub remote
      const url = await detectGitHubUrl(process.cwd());
      // May or may not have a GitHub remote depending on the repo setup
      // Just verify it returns string or null
      expect(url === null || typeof url === 'string').toBe(true);
      if (url) {
        expect(url).toContain('github.com');
        expect(url).not.toContain('.git');
      }
    });

    test('returns null for non-git directory', async () => {
      const url = await detectGitHubUrl(tmpdir());
      expect(url).toBeNull();
    });

    test('returns null for nonexistent directory', async () => {
      const url = await detectGitHubUrl('/nonexistent/directory/that/doesnt/exist');
      expect(url).toBeNull();
    });
  });
});

describe('Projects Module - ClaudeCodeManager integration', () => {
  // Test that getWorkingDirectory() was added to ClaudeCodeManager
  test('ClaudeCodeManager has getWorkingDirectory method', async () => {
    const { ClaudeCodeManager } = await import('../../server/claude-code');
    const manager = new ClaudeCodeManager('/test/directory');

    expect(manager.getWorkingDirectory()).toBe('/test/directory');
  });

  test('ClaudeCodeManager getWorkingDirectory returns default cwd when no arg', async () => {
    const { ClaudeCodeManager } = await import('../../server/claude-code');
    const manager = new ClaudeCodeManager();

    expect(manager.getWorkingDirectory()).toBe(process.cwd());
  });
});

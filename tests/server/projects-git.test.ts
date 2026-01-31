/**
 * @fileoverview Tests for git-related project functionality.
 *
 * Separated from projects.test.ts because Bun on Windows crashes when
 * bun:sqlite and Bun.spawn (used by detectGitHubUrl / ClaudeCodeManager)
 * are loaded in the same test process.
 */

import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { detectGitHubUrl } from '../../server/projects';

describe('detectGitHubUrl', () => {
  test('detects GitHub URL from current repo', async () => {
    const url = await detectGitHubUrl(process.cwd());
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

describe('ClaudeCodeManager integration', () => {
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

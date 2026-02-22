/**
 * @fileoverview Tests for git-related project functionality.
 *
 * Separated from projects.test.ts because Bun on Windows crashes when
 * bun:sqlite and Bun.spawn (used by detectGitHubUrl / ClaudeCodeManager)
 * are loaded in the same test process.
 */

import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { detectGitHubUrl, isValidGitHubUrl, parseGitHubRepoName } from '../../server/projects';

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

describe('isValidGitHubUrl', () => {
  test('accepts standard GitHub URL', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo')).toBe(true);
  });

  test('accepts URL with .git suffix', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo.git')).toBe(true);
  });

  test('accepts URL with hyphens and dots', () => {
    expect(isValidGitHubUrl('https://github.com/my-org/my.repo-name')).toBe(true);
  });

  test('rejects non-GitHub URL', () => {
    expect(isValidGitHubUrl('https://gitlab.com/owner/repo')).toBe(false);
  });

  test('rejects URL without repo path', () => {
    expect(isValidGitHubUrl('https://github.com/owner')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidGitHubUrl('')).toBe(false);
  });

  test('rejects SSH URL', () => {
    expect(isValidGitHubUrl('git@github.com:owner/repo.git')).toBe(false);
  });

  test('rejects URL with trailing slash', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo/')).toBe(false);
  });
});

describe('parseGitHubRepoName', () => {
  test('extracts repo name from standard URL', () => {
    expect(parseGitHubRepoName('https://github.com/owner/repo')).toBe('repo');
  });

  test('strips .git suffix', () => {
    expect(parseGitHubRepoName('https://github.com/owner/repo.git')).toBe('repo');
  });

  test('handles hyphenated repo names', () => {
    expect(parseGitHubRepoName('https://github.com/owner/my-cool-repo')).toBe('my-cool-repo');
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

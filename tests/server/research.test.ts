/**
 * @fileoverview Unit tests for the Research module.
 *
 * Tests topic CRUD, article CRUD, cascade deletion,
 * and article listing behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  initResearchDb,
  listTopics,
  getTopic,
  createTopic,
  updateTopic,
  deleteTopic,
  listArticles,
  getArticle,
  createArticle,
  deleteArticle,
} from '../../server/research';
import { initDb, closeDb, setConfigDir } from '../../server/db';

/** Temporary directory for test database files. */
let testDir: string;

/** Set up a temp database before each test. */
beforeEach(async () => {
  testDir = join(tmpdir(), `research-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  initResearchDb(db);
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

describe('Research Module', () => {
  describe('createTopic', () => {
    test('creates a topic with required name', () => {
      const topic = createTopic({ name: 'AI Safety' });

      expect(topic.id).toBeTruthy();
      expect(topic.name).toBe('AI Safety');
      expect(topic.description).toBeNull();
      expect(topic.createdAt).toBeTruthy();
      expect(topic.updatedAt).toBeTruthy();
    });

    test('creates a topic with description', () => {
      const topic = createTopic({
        name: 'Quantum Computing',
        description: 'Recent advances in quantum error correction',
      });

      expect(topic.name).toBe('Quantum Computing');
      expect(topic.description).toBe('Recent advances in quantum error correction');
    });

    test('generates unique IDs for each topic', () => {
      const a = createTopic({ name: 'Topic A' });
      const b = createTopic({ name: 'Topic B' });

      expect(a.id).not.toBe(b.id);
    });
  });

  describe('listTopics', () => {
    test('returns empty array when no topics exist', () => {
      const topics = listTopics();
      expect(topics).toEqual([]);
    });

    test('returns all topics', () => {
      createTopic({ name: 'A' });
      createTopic({ name: 'B' });
      createTopic({ name: 'C' });

      const topics = listTopics();
      expect(topics.length).toBe(3);
    });

    test('sorts newest first', () => {
      createTopic({ name: 'First' });
      createTopic({ name: 'Second' });
      createTopic({ name: 'Third' });

      const topics = listTopics();
      expect(topics[0].name).toBe('Third');
      expect(topics[2].name).toBe('First');
    });
  });

  describe('getTopic', () => {
    test('returns a topic by ID', () => {
      const created = createTopic({ name: 'AI Safety', description: 'Important stuff' });

      const topic = getTopic(created.id);
      expect(topic).not.toBeNull();
      expect(topic!.name).toBe('AI Safety');
      expect(topic!.description).toBe('Important stuff');
    });

    test('returns null for nonexistent ID', () => {
      const topic = getTopic('nonexistent-id');
      expect(topic).toBeNull();
    });
  });

  describe('updateTopic', () => {
    test('updates the name', () => {
      const created = createTopic({ name: 'Old Name' });

      const updated = updateTopic(created.id, { name: 'New Name' });

      expect(updated.name).toBe('New Name');
    });

    test('updates the description', () => {
      const created = createTopic({ name: 'Topic', description: 'Old desc' });

      const updated = updateTopic(created.id, { description: 'New desc' });

      expect(updated.description).toBe('New desc');
      expect(updated.name).toBe('Topic');
    });

    test('clears the description with null', () => {
      const created = createTopic({ name: 'Topic', description: 'Some desc' });

      const updated = updateTopic(created.id, { description: null });

      expect(updated.description).toBeNull();
    });

    test('updates updatedAt timestamp', () => {
      const created = createTopic({ name: 'Topic' });

      const updated = updateTopic(created.id, { name: 'Updated Topic' });

      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime()
      );
    });

    test('throws for nonexistent topic', () => {
      expect(() => updateTopic('nonexistent', { name: 'Nope' })).toThrow('Topic not found');
    });

    test('preserves fields not included in update', () => {
      const created = createTopic({ name: 'Topic', description: 'Keep this' });

      const updated = updateTopic(created.id, { name: 'New Name' });

      expect(updated.description).toBe('Keep this');
    });
  });

  describe('deleteTopic', () => {
    test('deletes an existing topic', () => {
      const created = createTopic({ name: 'Topic' });

      deleteTopic(created.id);

      const topics = listTopics();
      expect(topics.length).toBe(0);
    });

    test('throws for nonexistent topic', () => {
      expect(() => deleteTopic('nonexistent')).toThrow('Topic not found');
    });

    test('cascade deletes articles', () => {
      const topic = createTopic({ name: 'Topic' });
      createArticle(topic.id, { title: 'Article 1', content: '<p>Content</p>' });
      createArticle(topic.id, { title: 'Article 2', content: '<p>Content</p>' });

      deleteTopic(topic.id);

      expect(getTopic(topic.id)).toBeNull();
      // Articles should be gone — verify via listArticles on the deleted topic
      const articles = listArticles(topic.id);
      expect(articles.length).toBe(0);
    });

    test('does not affect other topics', () => {
      const a = createTopic({ name: 'Keep' });
      const b = createTopic({ name: 'Delete' });

      deleteTopic(b.id);

      const topics = listTopics();
      expect(topics.length).toBe(1);
      expect(topics[0].name).toBe('Keep');
    });
  });

  describe('createArticle', () => {
    test('creates an article under a topic', () => {
      const topic = createTopic({ name: 'AI Safety' });

      const article = createArticle(topic.id, {
        title: 'Daily Research — Jan 1',
        content: '<p>Research findings</p>',
      });

      expect(article.id).toBeTruthy();
      expect(article.topicId).toBe(topic.id);
      expect(article.title).toBe('Daily Research — Jan 1');
      expect(article.content).toBe('<p>Research findings</p>');
      expect(article.createdAt).toBeTruthy();
    });

    test('throws for nonexistent topic', () => {
      expect(() => createArticle('nonexistent', {
        title: 'Test',
        content: '<p>Nope</p>',
      })).toThrow('Topic not found');
    });

    test('generates unique IDs for each article', () => {
      const topic = createTopic({ name: 'Topic' });
      const a = createArticle(topic.id, { title: 'A', content: '<p>A</p>' });
      const b = createArticle(topic.id, { title: 'B', content: '<p>B</p>' });

      expect(a.id).not.toBe(b.id);
    });
  });

  describe('listArticles', () => {
    test('returns empty array for topic with no articles', () => {
      const topic = createTopic({ name: 'Empty Topic' });

      const articles = listArticles(topic.id);
      expect(articles).toEqual([]);
    });

    test('returns articles newest first', () => {
      const topic = createTopic({ name: 'Topic' });

      createArticle(topic.id, { title: 'First', content: '<p>1</p>' });
      createArticle(topic.id, { title: 'Second', content: '<p>2</p>' });
      createArticle(topic.id, { title: 'Third', content: '<p>3</p>' });

      const articles = listArticles(topic.id);
      expect(articles.length).toBe(3);
      expect(articles[0].title).toBe('Third');
      expect(articles[2].title).toBe('First');
    });

    test('only returns articles for the specified topic', () => {
      const topicA = createTopic({ name: 'A' });
      const topicB = createTopic({ name: 'B' });

      createArticle(topicA.id, { title: 'A Article', content: '<p>A</p>' });
      createArticle(topicB.id, { title: 'B Article', content: '<p>B</p>' });

      const articlesA = listArticles(topicA.id);
      expect(articlesA.length).toBe(1);
      expect(articlesA[0].title).toBe('A Article');
    });
  });

  describe('getArticle', () => {
    test('returns an article by ID', () => {
      const topic = createTopic({ name: 'Topic' });
      const created = createArticle(topic.id, { title: 'Test', content: '<p>Hi</p>' });

      const article = getArticle(created.id);
      expect(article).not.toBeNull();
      expect(article!.title).toBe('Test');
      expect(article!.content).toBe('<p>Hi</p>');
    });

    test('returns null for nonexistent ID', () => {
      const article = getArticle('nonexistent');
      expect(article).toBeNull();
    });
  });

  describe('deleteArticle', () => {
    test('deletes an existing article', () => {
      const topic = createTopic({ name: 'Topic' });
      const article = createArticle(topic.id, { title: 'Delete me', content: '<p>Gone</p>' });

      deleteArticle(article.id);

      const articles = listArticles(topic.id);
      expect(articles.length).toBe(0);
    });

    test('throws for nonexistent article', () => {
      expect(() => deleteArticle('nonexistent')).toThrow('Article not found');
    });

    test('does not affect other articles', () => {
      const topic = createTopic({ name: 'Topic' });
      const keep = createArticle(topic.id, { title: 'Keep', content: '<p>Keep</p>' });
      const remove = createArticle(topic.id, { title: 'Remove', content: '<p>Remove</p>' });

      deleteArticle(remove.id);

      const articles = listArticles(topic.id);
      expect(articles.length).toBe(1);
      expect(articles[0].title).toBe('Keep');
    });
  });
});

/**
 * @fileoverview Research module for the dashboard.
 *
 * Provides CRUD operations for research topics and their articles.
 * Topics have a name and description. Articles are generated daily
 * via Claude CLI deep research and stored under their parent topic.
 * Articles are included in the daily briefing email.
 */

import { Database } from 'bun:sqlite';
import { getDb } from './db.js';

/** A research topic. */
export interface Topic {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape from the research_topics table. */
interface TopicRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/** A research article belonging to a topic. */
export interface Article {
  id: string;
  topicId: string;
  title: string;
  content: string;
  createdAt: string;
}

/** Row shape from the research_articles table. */
interface ArticleRow {
  id: string;
  topic_id: string;
  title: string;
  content: string;
  created_at: string;
}

/**
 * Initializes the research tables in the database.
 *
 * @param db - The SQLite database instance.
 */
export function initResearchDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS research_topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS research_articles (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE
    )
  `);
}

/** Converts a TopicRow to a Topic. */
function rowToTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Converts an ArticleRow to an Article. */
function rowToArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Topic CRUD
// ---------------------------------------------------------------------------

/**
 * Lists all topics sorted by creation date (newest first).
 */
export function listTopics(): Topic[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM research_topics ORDER BY created_at DESC'
  ).all() as TopicRow[];
  return rows.map(rowToTopic);
}

/**
 * Gets a single topic by ID.
 *
 * @param id - The topic ID.
 * @returns The topic, or null if not found.
 */
export function getTopic(id: string): Topic | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM research_topics WHERE id = ?').get(id) as TopicRow | null;
  return row ? rowToTopic(row) : null;
}

/**
 * Creates a new topic.
 *
 * @param data - Topic fields (name required, description optional).
 * @returns The created topic.
 */
export function createTopic(data: { name: string; description?: string }): Topic {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO research_topics (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.name, data.description ?? null, now, now);

  return {
    id,
    name: data.name,
    description: data.description ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Updates a topic's name and/or description.
 *
 * @param id - The topic ID.
 * @param data - Fields to update.
 * @returns The updated topic.
 * @throws If the topic is not found.
 */
export function updateTopic(id: string, data: { name?: string; description?: string | null }): Topic {
  const db = getDb();
  const existing = getTopic(id);
  if (!existing) {
    throw new Error(`Topic not found: ${id}`);
  }

  const name = data.name !== undefined ? data.name : existing.name;
  const description = data.description !== undefined ? data.description : existing.description;
  const now = new Date().toISOString();

  db.prepare('UPDATE research_topics SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description, now, id);

  return { ...existing, name, description, updatedAt: now };
}

/**
 * Deletes a topic and all its articles (via cascade).
 *
 * @param id - The topic ID.
 * @throws If the topic is not found.
 */
export function deleteTopic(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM research_topics WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Topic not found: ${id}`);
  }

  db.prepare('DELETE FROM research_topics WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Article CRUD
// ---------------------------------------------------------------------------

/**
 * Lists articles for a topic, newest first.
 *
 * @param topicId - The topic ID.
 * @returns Array of articles.
 */
export function listArticles(topicId: string): Article[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM research_articles WHERE topic_id = ? ORDER BY created_at DESC'
  ).all(topicId) as ArticleRow[];
  return rows.map(rowToArticle);
}

/**
 * Gets a single article by ID.
 *
 * @param id - The article ID.
 * @returns The article, or null if not found.
 */
export function getArticle(id: string): Article | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM research_articles WHERE id = ?').get(id) as ArticleRow | null;
  return row ? rowToArticle(row) : null;
}

/**
 * Creates a new article under a topic.
 *
 * @param topicId - The parent topic ID.
 * @param data - Article fields.
 * @returns The created article.
 * @throws If the topic is not found.
 */
export function createArticle(topicId: string, data: { title: string; content: string }): Article {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM research_topics WHERE id = ?').get(topicId);
  if (!existing) {
    throw new Error(`Topic not found: ${topicId}`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO research_articles (id, topic_id, title, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, topicId, data.title, data.content, now);

  return {
    id,
    topicId,
    title: data.title,
    content: data.content,
    createdAt: now,
  };
}

/**
 * Deletes a single article.
 *
 * @param id - The article ID.
 * @throws If the article is not found.
 */
export function deleteArticle(id: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM research_articles WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Article not found: ${id}`);
  }

  db.prepare('DELETE FROM research_articles WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Research generation
// ---------------------------------------------------------------------------

/** Optional callback for reporting progress during research generation. */
export type ResearchProgressCallback = (step: string) => void;

/**
 * Generates a research article for a single topic via Claude CLI with web search.
 *
 * @param topic - The topic to research.
 * @returns The generated HTML content, or null if the CLI call fails.
 */
async function generateArticleForTopic(topic: Topic): Promise<string | null> {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const prompt = `You are a research assistant. Produce a detailed research article about the following topic.

Topic: ${topic.name}
${topic.description ? `Description: ${topic.description}` : ''}

Today's date is ${dateStr}.

Research this topic thoroughly using web search. Write a comprehensive article with:
- Key recent developments and news
- Important facts and analysis
- Relevant data points and statistics
- Sources where applicable

Format the output as HTML suitable for an email body (no <html>, <head>, or <body> tags — just content HTML like <p>, <ul>, <strong>, etc).`;

  try {
    const proc = Bun.spawn(['claude', '-p', prompt, '--allowedTools', 'mcp__fetch__fetch,WebSearch'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(`Claude CLI exited with code ${exitCode} for topic "${topic.name}": ${stderr}`);
      return null;
    }

    let output = stdout.trim();
    if (!output) {
      console.error(`Claude CLI returned empty output for topic "${topic.name}"`);
      return null;
    }

    // Strip markdown code fences that Claude sometimes wraps around HTML output
    output = output.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

    return output;
  } catch (error) {
    console.error(`Failed to spawn Claude CLI for topic "${topic.name}":`, error);
    return null;
  }
}

/**
 * Generates research articles for all topics. Spawns Claude CLI once per topic
 * with web search enabled. Saves each result as an Article in the database.
 *
 * @param onProgress - Optional callback invoked at each step.
 * @returns Array of newly created articles.
 */
export async function generateResearchArticles(onProgress?: ResearchProgressCallback): Promise<Article[]> {
  const topics = listTopics();
  if (topics.length === 0) {
    onProgress?.('No research topics configured, skipping research');
    return [];
  }

  onProgress?.(`Generating research for ${topics.length} topic${topics.length !== 1 ? 's' : ''}...`);
  const articles: Article[] = [];

  for (const topic of topics) {
    onProgress?.(`Researching: ${topic.name}...`);
    const content = await generateArticleForTopic(topic);
    if (content) {
      const dateStr = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const article = createArticle(topic.id, {
        title: `${topic.name} — ${dateStr}`,
        content,
      });
      articles.push(article);
      onProgress?.(`Article generated for "${topic.name}"`);
    } else {
      onProgress?.(`Failed to generate article for "${topic.name}", skipping`);
    }
  }

  onProgress?.(`Research complete: ${articles.length}/${topics.length} articles generated`);
  return articles;
}

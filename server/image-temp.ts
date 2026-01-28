/**
 * @fileoverview Temporary image file management for chat image uploads.
 *
 * Handles saving base64 images to temp files and cleanup to prevent accumulation.
 */

import { join } from 'path'
import { tmpdir } from 'os'
import { mkdir, rm, readdir, stat } from 'fs/promises'
import { randomUUID } from 'crypto'

/** Directory for all temp images */
const TEMP_IMAGE_DIR = join(tmpdir(), 'personal-dashboard-images')

/** Maps session IDs to their associated temp file paths */
const sessionImages = new Map<string, Set<string>>()

/** Cleanup orphaned files older than this (1 hour) */
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Ensures the temp directory exists.
 */
export async function initTempImageDir(): Promise<void> {
  await mkdir(TEMP_IMAGE_DIR, { recursive: true })
  // Run initial orphan cleanup
  await cleanupOrphanedFiles()
}

/**
 * Saves a base64 image to a temp file.
 *
 * @param sessionId - The session this image belongs to
 * @param base64Data - The image data (without data URL prefix)
 * @param filename - Suggested filename
 * @returns The absolute path to the saved file
 */
export async function saveImageToTemp(
  sessionId: string,
  base64Data: string,
  filename: string
): Promise<string> {
  const uniqueName = `${sessionId}-${randomUUID()}-${filename}`
  const filePath = join(TEMP_IMAGE_DIR, uniqueName)

  // Decode base64 and write
  const buffer = Buffer.from(base64Data, 'base64')
  await Bun.write(filePath, buffer)

  // Track the file for this session
  if (!sessionImages.has(sessionId)) {
    sessionImages.set(sessionId, new Set())
  }
  sessionImages.get(sessionId)!.add(filePath)

  console.log(
    `[TempImage] Saved ${filePath} (${buffer.length} bytes) for session ${sessionId}`
  )
  return filePath
}

/**
 * Cleans up all temp files for a session.
 * Call this after Claude finishes processing, on abort, or on disconnect.
 *
 * @param sessionId - The session to clean up
 */
export async function cleanupSessionImages(sessionId: string): Promise<void> {
  const files = sessionImages.get(sessionId)
  if (!files || files.size === 0) return

  const promises: Promise<void>[] = []
  for (const filePath of files) {
    promises.push(
      rm(filePath, { force: true })
        .then(() => console.log(`[TempImage] Cleaned up ${filePath}`))
        .catch((err) =>
          console.warn(
            `[TempImage] Failed to clean ${filePath}: ${err.message}`
          )
        )
    )
  }

  await Promise.all(promises)
  sessionImages.delete(sessionId)
}

/**
 * Cleans up orphaned files older than ORPHAN_MAX_AGE_MS.
 * Run periodically to catch files missed by normal cleanup.
 */
export async function cleanupOrphanedFiles(): Promise<void> {
  try {
    const files = await readdir(TEMP_IMAGE_DIR)
    const now = Date.now()

    for (const filename of files) {
      const filePath = join(TEMP_IMAGE_DIR, filename)
      try {
        const fileStat = await stat(filePath)
        const age = now - fileStat.mtimeMs

        if (age > ORPHAN_MAX_AGE_MS) {
          await rm(filePath, { force: true })
          console.log(
            `[TempImage] Cleaned up orphaned file ${filename} (age: ${Math.round(age / 60000)}min)`
          )
        }
      } catch {
        // File may have been deleted, ignore
      }
    }
  } catch (err) {
    // Directory may not exist yet, ignore
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[TempImage] Orphan cleanup failed:', err)
    }
  }
}

/**
 * Returns all tracked file paths for a session (for debugging/testing).
 */
export function getSessionImagePaths(sessionId: string): string[] {
  const files = sessionImages.get(sessionId)
  return files ? Array.from(files) : []
}

/**
 * Returns the temp image directory path (for testing).
 */
export function getTempImageDir(): string {
  return TEMP_IMAGE_DIR
}

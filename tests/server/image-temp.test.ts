import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { join } from 'path'
import {
  initTempImageDir,
  saveImageToTemp,
  cleanupSessionImages,
  getSessionImagePaths,
  getTempImageDir
} from '../../server/image-temp'

// Small 1x1 red PNG in base64
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

describe('Image Temp File Management', () => {
  const testSessionId = `test-session-${Date.now()}`

  beforeAll(async () => {
    await initTempImageDir()
  })

  afterEach(async () => {
    await cleanupSessionImages(testSessionId)
  })

  test('saves base64 image to temp file', async () => {
    const filePath = await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'test.png')

    expect(filePath).toContain('test.png')
    expect(filePath).toContain(testSessionId)
    expect(filePath).toContain(getTempImageDir())

    const file = Bun.file(filePath)
    expect(await file.exists()).toBe(true)

    // Verify it's a valid PNG (starts with PNG signature bytes)
    const bytes = await file.bytes()
    expect(bytes[0]).toBe(0x89) // PNG signature
    expect(bytes[1]).toBe(0x50) // 'P'
    expect(bytes[2]).toBe(0x4E) // 'N'
    expect(bytes[3]).toBe(0x47) // 'G'
  })

  test('tracks multiple images for session', async () => {
    await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'img1.png')
    await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'img2.png')
    await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'img3.png')

    const paths = getSessionImagePaths(testSessionId)
    expect(paths.length).toBe(3)
    expect(paths.every(p => p.includes(testSessionId))).toBe(true)
  })

  test('generates unique filenames for same input name', async () => {
    const path1 = await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'same.png')
    const path2 = await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'same.png')

    expect(path1).not.toBe(path2)

    const file1 = Bun.file(path1)
    const file2 = Bun.file(path2)
    expect(await file1.exists()).toBe(true)
    expect(await file2.exists()).toBe(true)
  })

  test('cleanupSessionImages removes all files', async () => {
    const path1 = await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'cleanup1.png')
    const path2 = await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'cleanup2.png')

    // Verify files exist
    expect(await Bun.file(path1).exists()).toBe(true)
    expect(await Bun.file(path2).exists()).toBe(true)

    await cleanupSessionImages(testSessionId)

    // Verify files are deleted
    expect(await Bun.file(path1).exists()).toBe(false)
    expect(await Bun.file(path2).exists()).toBe(false)
    expect(getSessionImagePaths(testSessionId).length).toBe(0)
  })

  test('cleanup is idempotent', async () => {
    await saveImageToTemp(testSessionId, TEST_IMAGE_BASE64, 'idem.png')
    await cleanupSessionImages(testSessionId)
    // Second cleanup should not throw
    await cleanupSessionImages(testSessionId)

    expect(getSessionImagePaths(testSessionId).length).toBe(0)
  })

  test('different sessions are isolated', async () => {
    const session1 = `session1-${Date.now()}`
    const session2 = `session2-${Date.now()}`

    try {
      await saveImageToTemp(session1, TEST_IMAGE_BASE64, 'file1.png')
      await saveImageToTemp(session2, TEST_IMAGE_BASE64, 'file2.png')

      expect(getSessionImagePaths(session1).length).toBe(1)
      expect(getSessionImagePaths(session2).length).toBe(1)

      await cleanupSessionImages(session1)

      expect(getSessionImagePaths(session1).length).toBe(0)
      expect(getSessionImagePaths(session2).length).toBe(1) // Still exists
    } finally {
      await cleanupSessionImages(session1)
      await cleanupSessionImages(session2)
    }
  })

  test('returns empty array for unknown session', () => {
    const paths = getSessionImagePaths('nonexistent-session')
    expect(paths).toEqual([])
  })
})

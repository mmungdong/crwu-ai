import { lstat, readdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import type { CleanupDirent, CleanupIo, CleanupStats } from './types.ts'

/**
 * 生产 IO：**本功能唯一**直接 import `node:fs/promises` 的地方。
 *
 * 为什么必须把它单独关起来：删除是不可逆动作，其它模块只能看到 `CleanupIo`。
 * 单测用内存替身（`tests/helpers/workspace-cleanup-fixture.mjs`），于是"删了什么"
 * 可以在断言里逐条核对，而不是去碰真实磁盘。
 */
export function nodeCleanupIo(): CleanupIo {
  return {
    async readdir(path): Promise<CleanupDirent[]> {
      const dirents = await readdir(path, { withFileTypes: true })
      return dirents.map((dirent) => ({
        name: dirent.name,
        isDirectory: () => dirent.isDirectory(),
        isFile: () => dirent.isFile(),
        isSymbolicLink: () => dirent.isSymbolicLink(),
      }))
    },
    async lstat(path): Promise<CleanupStats | undefined> {
      return await statsOf(() => lstat(path))
    },
    async stat(path): Promise<CleanupStats | undefined> {
      return await statsOf(() => stat(path))
    },
    async realpath(path): Promise<string> {
      return await realpath(path)
    },
    async removeTree(path): Promise<void> {
      // `force: false`：目标在扫描后消失应当报失败，而不是静默成功。
      await rm(path, { recursive: true, force: false })
    },
    async unlink(path): Promise<void> {
      await unlink(path)
    },
  }
}

async function statsOf(read: () => Promise<Awaited<ReturnType<typeof lstat>>>): Promise<CleanupStats | undefined> {
  try {
    const info = await read()
    return {
      isDirectory: () => info.isDirectory(),
      isFile: () => info.isFile(),
      isSymbolicLink: () => info.isSymbolicLink(),
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

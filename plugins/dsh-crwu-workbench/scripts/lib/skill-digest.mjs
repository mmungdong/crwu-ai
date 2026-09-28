/**
 * 技能目录摘要（两个同步脚本共用）。
 *
 * 为什么要有「摘要」而不是只比技能名：技能正文才是真东西。只比名字的话，改了正文却忘了
 * 同步会**静默放过**，而仓库里那份与包里那份从此不一致。
 *
 * 摘要算法就是「排序后的相对路径 + 文件字节」，逐文件累进一个 sha256：
 * - 排序让结果与文件系统枚举顺序无关；
 * - 目录本身也进摘要（`d <rel>`），这样空目录的有无同样能被发现；
 * - 不跟随符号链接（`readdir` 的 dirent 判定），避免把仓库外的东西算进来。
 *
 * 只比较不落盘，也不缓存：调用方每次现算。
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** 目录内容摘要（相对 `base` 的路径 + 字节；`base` 默认取 `dir` 自身）。 */
export async function digestDir(dir, base = dir) {
  const hash = createHash('sha256')
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    const rel = relative(base, path)
    if (entry.isDirectory()) {
      hash.update(`d ${rel}\n`)
      hash.update(await digestDir(path, base))
      continue
    }
    hash.update(`f ${rel}\n`)
    hash.update(await readFile(path))
  }
  return hash.digest('hex')
}

/** 单个文件的 sha256（给 LICENSE / NOTICE 这类根文件用）。 */
export async function digestFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** 目录下一级的技能名（跳过隐藏文件与 `.synced.json` 这类元数据）；目录不存在时回 null。 */
export async function skillNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    // 目录不存在：调用方按「源缺失」处理（员工机器上就是这种）。
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

/** 路径是否存在（不抛错）。 */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    void error
    return false
  }
}

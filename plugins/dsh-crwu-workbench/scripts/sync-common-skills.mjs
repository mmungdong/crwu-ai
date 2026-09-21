/**
 * 把仓库里维护的**公共技能**拷进本插件包（`common/skills/`），供打包与本地开发使用。
 *
 * 为什么需要这一步：npm 的 `files` **不能引用包目录之外的路径**，而公共技能
 * （`crwu-dws*`、`crwu-h3yun*`）在仓库里只有一份（`plugins/common/skills/`）。
 * 所以打包前先把它们拷进包里 —— 依赖是"按目录布局"表达的，不需要任何名单文件。
 *
 * 三种运行环境都要对：
 *   1. 仓库内开发 / 打包（`plugins/common/skills/` 存在）→ 拷贝；
 *   2. 员工用 tarball 安装（包里已经有 `common/skills/`，源不存在）→ **跳过**，不算失败；
 *   3. 直接 `node scripts/sync-common-skills.mjs` → 打印做了什么。
 *
 * `--check` 只比较不写盘：CI 用它断言「包里的 `common/skills/` 与仓库源逐字节一致」。
 * 比的是内容摘要而不只是技能名 —— 只比名字的话，改了公共技能正文却忘了同步会静默放过。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = resolve(PLUGIN_DIR, '..', 'common', 'skills')
const TARGET = join(PLUGIN_DIR, 'common', 'skills')

/** 读一个目录下的技能名（跳过隐藏文件与 .synced.json 这类元数据）。 */
async function skillNames(dir) {
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

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    void error
    return false
  }
}

/** 目录内容摘要：相对路径 + 文件字节，逐文件累进一个 sha256（顺序经过排序，结果稳定）。 */
async function digest(dir, base = dir) {
  const hash = createHash('sha256')
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    const rel = relative(base, path)
    if (entry.isDirectory()) {
      hash.update(`d ${rel}\n`)
      hash.update(await digest(path, base))
      continue
    }
    hash.update(`f ${rel}\n`)
    hash.update(await readFile(path))
  }
  return hash.digest('hex')
}

async function main() {
  const check = process.argv.includes('--check')
  const names = await skillNames(SOURCE)
  if (names === null) {
    // 员工机器（tarball 里已有 common/skills/）：不做事、不报错。
    const shipped = (await skillNames(TARGET)) ?? []
    console.log(`[skills] 跳过：仓库里没有公共技能源（${SOURCE}）；包里现有 ${shipped.length} 个：${shipped.join(' ')}`)
    return 0
  }
  if (names.length === 0) {
    console.error(`[skills] 公共技能源是空的：${SOURCE}（按目录布局表达依赖，空目录说明东西放错了）`)
    return 1
  }

  if (check) {
    const shipped = (await skillNames(TARGET)) ?? []
    const sameNames = shipped.length === names.length && shipped.every((name, at) => name === names[at])
    if (!sameNames) {
      console.error(`[skills] 包里的 common/skills 与仓库源不一致：源=${names.join(' ')} / 包=${shipped.join(' ') || '（空）'}`)
      console.error('[skills] 跑一次 `npm run skills:sync`（或 make plugin-skills）再提交')
      return 1
    }
    for (const name of names) {
      const [want, got] = [await digest(join(SOURCE, name)), await digest(join(TARGET, name))]
      if (want !== got) {
        console.error(`[skills] 公共技能 ${name} 的内容与仓库源不一致（技能名对得上、正文已经改过）`)
        console.error('[skills] 跑一次 `npm run skills:sync`（或 make plugin-skills）再提交')
        return 1
      }
    }
    console.log(`[skills] 一致：${names.length} 个公共技能（${names.join(' ')}），内容逐文件比对通过`)
    return 0
  }

  // 先清空再拷：删掉源里的技能后，包里不能留残骸。
  if (await exists(TARGET)) await rm(TARGET, { recursive: true, force: true })
  await mkdir(TARGET, { recursive: true })
  for (const name of names) {
    await cp(join(SOURCE, name), join(TARGET, name), { recursive: true })
  }
  const stamp = { source: 'plugins/common/skills', skills: names }
  await writeFile(join(TARGET, '.synced.json'), `${JSON.stringify(stamp, null, 2)}\n`)
  console.log(`[skills] 已同步 ${names.length} 个公共技能 → ${TARGET}：${names.join(' ')}`)
  return 0
}

process.exitCode = await main()

/**
 * 自带二进制的构建产物清单：读写、按清单重算哈希、以及"这批文件是否齐备"的判据。
 *
 * 单独成模块的理由是**可测试**：`sync-binaries.mjs`（装配/自检）与 `assert-pack.mjs`
 * （发布严格模式）都要回答同一类问题 ——「六个二进制在不在、字节是不是清单里记的那一份、
 * bin/ 里有没有多出运行残留」。判据写两份必然漂移，而且两份都只能靠真跑 110MB 的装配来验。
 * 这里的函数只依赖传入的目录，测试用几 KB 的假文件就能把每条失败分支跑一遍。
 *
 * 清单字段（`bin/manifest.json`）：
 * - `schemaVersion` / `generatedAt` / `platforms[]`；
 * - 每个平台每个工具：`tool`、`file`、`platform`、`source`、`sourceVersion`、`target`、
 *   `size`、`sha256`（**最终文件**的），以及下载型二进制额外的 `archiveSha256`；
 * - `crwu` 额外记 `buildCommit`（可复现性）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const BIN_MANIFEST_NAME = 'manifest.json'
export const BIN_MANIFEST_SCHEMA = 'crwu.plugin-bin-manifest.v1'
export const BIN_PLATFORMS = ['darwin-arm64', 'win32-x64']
export const BIN_TOOLS = ['crwu', 'dws', 'ossutil']

/** 该平台下某个二进制的文件名（Windows 带 `.exe`）。 */
export function binFileName(tool, platform) {
  return String(platform).startsWith('win32') ? `${tool}.exe` : tool
}

/** 十六进制 sha256。 */
export async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** 读清单；缺失/坏 JSON/schema 不符时返回 `{ ok:false, error }`。 */
export async function readBinManifest(path) {
  if (!existsSync(path)) return { ok: false, error: `缺少 ${path}` }
  let parsed = null
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    return { ok: false, error: `${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, error: `${path} 不是 JSON 对象` }
  if (parsed.schemaVersion !== BIN_MANIFEST_SCHEMA) {
    return { ok: false, error: `${path}.schemaVersion 不是 ${BIN_MANIFEST_SCHEMA}：${String(parsed.schemaVersion)}` }
  }
  return { ok: true, manifest: parsed }
}

/** 清单里声明过的相对路径集合（用来发现未声明的残留）。 */
export function declaredFiles(manifest) {
  const declared = new Map()
  for (const entry of Array.isArray(manifest?.platforms) ? manifest.platforms : []) {
    for (const tool of Array.isArray(entry?.tools) ? entry.tools : []) {
      declared.set(`${entry.platform}/${tool.file}`, tool)
    }
  }
  return declared
}

/** 目录树里的全部文件（相对 `dir`，使用 `/` 分隔）。 */
export async function listFiles(dir, prefix = '') {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = `${prefix}${entry.name}`
    if (entry.isDirectory()) out.push(...await listFiles(full, `${rel}/`))
    else out.push(rel)
  }
  return out
}

/**
 * 按清单核对一个 `bin/` 目录。
 *
 * @param root 含 `<平台>/<工具>` 的目录（工作树的 `bin/`，或解包后的 `<pkg>/bin`）。
 * @param manifest 已解析的清单。
 * @param options.requireAll 是否要求清单声明全部平台/工具（发布严格模式为 true）。
 * @returns 问题清单；空数组 = 通过。
 */
export async function verifyBinDir(root, manifest, options = {}) {
  const requireAll = options.requireAll === true
  const problems = []
  const declared = declaredFiles(manifest)
  const seen = new Set()

  for (const [relative, tool] of declared) {
    seen.add(relative)
    const absolute = join(root, relative)
    if (!existsSync(absolute)) {
      problems.push(`清单声明的文件不存在：bin/${relative}`)
      continue
    }
    const info = await stat(absolute)
    if (tool.size !== info.size) {
      problems.push(`bin/${relative} 大小与清单不符：清单=${String(tool.size)}，实际=${info.size}`)
    }
    const actual = await sha256(absolute)
    if (tool.sha256 !== actual) {
      problems.push(`bin/${relative} 哈希与清单不符：清单=${String(tool.sha256)}，实际=${actual}`)
    }
  }

  if (requireAll) {
    for (const platform of BIN_PLATFORMS) {
      for (const tool of BIN_TOOLS) {
        const relative = `${platform}/${binFileName(tool, platform)}`
        if (!seen.has(relative)) problems.push(`清单没有声明 bin/${relative}`)
      }
    }
  }

  // 未声明的文件 = 运行残留（dws 会在自己旁边落 `.dws/`）。发布包里一个都不许有。
  for (const relative of await listFiles(root)) {
    if (relative === BIN_MANIFEST_NAME) continue
    if (!seen.has(relative)) problems.push(`bin/ 里有未在清单中声明的文件：bin/${relative}`)
  }
  return problems
}

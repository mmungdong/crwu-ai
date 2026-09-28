import type { Context } from '@deepseek-ai/cordis'
import type { FsDirEntry, FsTarget, FileSystem } from '@deepseek-ai/dsh-fs'
import { text } from '../../shared/utils/value.ts'
import { basenameLocalPath, joinLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { COUNTED, HTML_FILE, RESULT_FILE, dirMarker, fileMarker } from './consts.ts'

/**
 * 扫一个案例目录，回答「这一轮的交付件出来了没有」。
 *
 * 两处刻意设计：
 * 1. **canonical 优先**：交付件可能同时存在多份（`.before-` 备份、历史版本），
 *    必须优先取 `审核意见.<目录名>.html`，否则界面会把旧备份当最新结果；
 * 2. **只认交付件名**：`审核结果.*.json` / `审核意见.*.html`，不把 `findings/` 或
 *    `材料盘点.json` 之类的中间产物当结果。
 */

export interface CaseItem {
  name: string
  path: string
  flags: Record<string, boolean>
  dirCounts: Record<string, number>
  resultFile: string
  htmlFile: string
  audit: unknown
  error: string
}

/** 目录名取路径最后一段；Windows 的 `\` 与 POSIX 的 `/`、结尾斜杠都不影响。 */
export function caseNameOf(displayPath: string): string {
  const name = basenameLocalPath(displayPath)
  return name === '' ? text(displayPath) : name
}

export async function inspectCase(ctx: Context, dirTarget: FsTarget): Promise<CaseItem | null> {
  const fs: FileSystem | undefined = fileSystem(ctx)
  if (fs === undefined) return null
  let entries: FsDirEntry[] = []
  try {
    entries = await fs.listDir(dirTarget)
  } catch (error) {
    // 目录不可读等于「还不是一个案例目录」。
    void error
    return null
  }

  const display = text(dirTarget.displayPath)
  const name = caseNameOf(display)
  const canonicalHtml = `审核意见.${name}.html`
  const flags: Record<string, boolean> = {}
  const dirCounts: Record<string, number> = {}
  let resultFile = ''
  let htmlFile = ''
  let htmlRank = -1

  for (const entry of entries) {
    if (entry.type === 'directory') {
      const key = dirMarker(entry.name)
      if (key === '') continue
      flags[key] = true
      if (COUNTED[key] === true) {
        let count = 0
        try {
          count = (await fs.listDir(entry.target)).length
        } catch (error) {
          void error
          count = 0
        }
        dirCounts[key] = (dirCounts[key] ?? 0) + count
      }
      continue
    }
    if (entry.type !== 'file') continue

    const marker = fileMarker(entry.name)
    if (marker !== '') {
      flags[marker] = true
      continue
    }
    if (RESULT_FILE.test(entry.name)) {
      flags.result = true
      resultFile = entry.name
      continue
    }
    if (HTML_FILE.test(entry.name)) {
      flags.html = true
      // 排序：canonical（3）> 非 .before- 的历史稿（2）> .before- 备份（1）。
      let rank = 1
      if (entry.name === canonicalHtml) rank = 3
      else if (!entry.name.includes('.before-')) rank = 2
      if (rank > htmlRank) {
        htmlRank = rank
        htmlFile = entry.name
      }
    }
  }

  const isCase = flags.materials === true || flags.inventory === true || flags.result === true
    || flags.review === true || flags.knowledge === true || flags.raw === true || flags.html === true
  if (!isCase) return null

  const item: CaseItem = { name, path: display, flags, dirCounts, resultFile, htmlFile, audit: null, error: '' }
  if (resultFile !== '') {
    try {
      // 按**记录里的绝对路径**解析：结果文件的 key 是 `dir/file`，只传文件名会解析错。
      const target = await resolveTarget(ctx, joinLocalPath(item.path, resultFile))
      item.audit = JSON.parse(await fs.readText(target))
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error)
    }
  }
  return item
}

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { readTextIfExists } from '../../../core/fs/paths.ts'
import { packageRootFrom } from '../../../core/platform/package-root.ts'
import { shellInvoke } from '../../../core/platform/shell.ts'
import { classifyRun, reasonOf, clampText } from '../../../tools/common/outcome.ts'
import { writeCaseText } from '../../../tools/common/case-files.ts'
import type { PythonRuntimeResolver } from '../../../core/runtime/python.ts'
import type { LocalAccessBroker } from '../../../core/access/broker.ts'
import { kindOf, type ValuationFileKind } from './classify.ts'
import { emptyExtractedFile } from './extract.ts'
import type {
  ExtractedFile, ExtractedPageFact, ExtractionCapabilities, FileExtractor,
} from './types.ts'

/**
 * **Python 后端**的提取器：把真正的字节读取交给技能脚本
 * `skills/biz/crwU-biz-valuation-realestate/scripts/extract_files.py`。
 *
 * 为什么不在这里用 TypeScript 读文件：PDF / docx / xlsx 的解析要么需要依赖（本仓不引），
 * 要么需要大量易错的字节级代码。技能脚本用的是 **DSH 自带 Python**（openpyxl / python-docx /
 * Pillow 都在），而且它自己就能如实汇报"缺哪个库" —— 那正是我们想要的降级语义。
 *
 * ## 两步，顺序不能换
 *
 * 1. **把脚本落到案例目录里**（`<案例目录>/scripts/extract_files.py`）。
 *    必须先落盘：`crwu_run_python_script` 与 Host 的 `python.script.run` 都只接受
 *    **案例目录之内**的脚本路径 —— 这是一条安全边界（不让模型提交任意可执行路径），
 *    所以 Host 自己也要走同一条路，不给自己开后门。
 * 2. **逐个文件调用**：`<python> <脚本> <输入文件> <输出 JSON>`，读回 JSON。
 *
 * ## 契约与降级
 *
 * - 脚本写出固定形状的 JSON；这里只做映射与校验，**不补字段**；
 * - 逐页事实（`pages` / `pageCount` / 计数）与能力声明（`capabilities` / `capabilityProbe`）
 *   按原样搬运，但**形状不对就整键缺省**：假的 `hasTextLayer: true` 会让下游去引用一段
 *   不存在的正文，假的 `pagesWithoutText: 0` 等于一句"整份都读到了"；
 * - 脚本报 `ok: false`（缺 PDF 库、无文本层、旧版 .doc）→ **抛错**，
 *   由 `runExtraction` 记成"未解析 + 能力缺口"，绝不产出半截 `extractedFields`；
 *   注意"整份读不出来"这条路**不经过**上面的逐页映射：`ok: false` 的结果里没有 `ExtractedFile`。
 * - 输出文件读不到 / 不是合法 JSON → 同样抛错（那是脚本或沙箱的问题，不是"读到了空内容"）。
 */

/** 脚本在案例目录内的落点。 */
export const EXTRACT_SCRIPT_DIR = 'scripts'
export const EXTRACT_SCRIPT_NAME = 'extract_files.py'

/** 提取产物（每份一个 JSON）在案例目录内的落点。 */
export const EXTRACT_OUTPUT_DIR = '提取结果'

/** 技能在包内的相对路径。 */
const SKILL_SCRIPT_RELATIVE = joinLocalPath(
  'skills', 'biz', 'crwu-biz-valuation-realestate', 'scripts', EXTRACT_SCRIPT_NAME,
)

/** 单份文件的提取超时（PDF 与整本工作簿都可能慢）。 */
export const EXTRACT_TIMEOUT_MS = 5 * 60_000

/** 包内技能脚本的绝对路径；找不到时为空串（生产形态一定找得到，测试可注入替身）。 */
export function packagedExtractScriptPath(): string {
  const root = packageRootFrom(dirname(fileURLToPath(import.meta.url)))
  if (root === '') return ''
  const path = joinLocalPath(root, ...SKILL_SCRIPT_RELATIVE.split(/[\\/]+/))
  return existsSync(path) ? path : ''
}

export interface PythonExtractorDeps {
  ctx: Context
  access: LocalAccessBroker
  python?: PythonRuntimeResolver
  world: { platform: () => Promise<string> }
  /** 本轮估值的案例目录（已由门禁核对过归属）。 */
  casePath: string
  session?: Session
  /** 包内脚本路径；缺省由 `packagedExtractScriptPath()` 解析。测试注入替身。 */
  sourceScriptPath?: string
  /**
   * 注入的读取器；缺省读**包内**脚本。
   *
   * 注意读的是插件自己的包文件，走 `node:fs` 而不是 `ctx.fs`：`ctx.fs` 是**员工的**
   * 沙箱文件服务（边界是会话 cwd），拿它读插件安装目录既越界也依赖于部署布局。
   * 案例目录里的**输出**才必须走 `ctx.fs`（那是员工的目录）。
   */
  readSource?: (path: string) => Promise<string>
  signal?: AbortSignal
}

/** 脚本输出的 JSON 形状（只声明我们读取的字段；多出来的字段不理会）。 */
interface ScriptPayload {
  ok?: unknown
  error?: unknown
  fileType?: unknown
  text?: unknown
  tables?: unknown
  images?: unknown
  extractedFields?: unknown
  warnings?: unknown
  capabilityGaps?: unknown
  pages?: unknown
  pageCount?: unknown
  pagesWithText?: unknown
  pagesWithoutText?: unknown
  capabilities?: unknown
  capabilityProbe?: unknown
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter((item) => item !== '') : []
}

/**
 * 只接受**真布尔**。
 *
 * `'true'` / `1` / `0` / `null` 一律返回 `undefined`（未知）：把 `1` 当 `true` 会凭空造出一条
 * "这一页有文本层"的事实，下游就会去引用一段根本不存在的正文。
 */
function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 只接受非负安全整数；`'3'` / `2.5` / `-1` 一律未知（不四舍五入、不截断）。 */
function countOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

/**
 * 逐页事实：**可定位 + 断言成形**才算一条，其余行丢弃。
 *
 * 一条都不成形时返回 `undefined`（不落空数组）：空数组会被 `every` 变成一句空洞的
 * "全部页都有文本层"，而真相是"没有逐页事实"。
 */
function pagesOf(value: unknown): ExtractedPageFact[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ExtractedPageFact[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const index = countOf(record.index)
    const hasTextLayer = booleanOf(record.hasTextLayer)
    if (index === undefined || index < 1 || hasTextLayer === undefined) continue
    const chars = countOf(record.chars)
    const warning = typeof record.warning === 'string' ? record.warning.trim() : ''
    out.push({
      index,
      hasTextLayer,
      ...(chars === undefined ? {} : { chars }),
      ...(warning === '' ? {} : { warning }),
    })
  }
  return out.length === 0 ? undefined : out
}

/** 能力声明：只认声明的键；非布尔值丢弃（**不许**把 `'true'`/`1` 收成 `true`）。 */
function capabilitiesOf(value: unknown): ExtractionCapabilities | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const out: ExtractionCapabilities = {}
  for (const key of ['pdfText', 'pdfRender', 'imageOcr'] as const) {
    const flag = booleanOf(record[key])
    if (flag !== undefined) out[key] = flag
  }
  // 视觉退路必须是**真字符串**：把 `7` 收成 `'7'` 就是凭空造一个能力声明。
  const vision = typeof record.visionFallback === 'string' ? record.visionFallback.trim() : ''
  if (vision !== '') out.visionFallback = vision
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 探针证据：**逐字搬运**，只丢形状不对的条目。
 *
 * 空串要留住 —— 它是"探过、没找到"的证据（`rasterizer: ''` 正是"本部署没有渲染器"这句话的
 * 出处）；丢成缺键就分不清"没探"和"没找到"了。
 */
function evidenceOf(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim()
    if (name === '' || typeof item !== 'string') continue
    out[name] = item
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** 字段表：只收字符串值（脚本只产字符串；别的形状一律丢弃，不猜测）。 */
function stringRecordOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = text(key).trim()
    const field = text(item)
    // 空值等于"没读到"：记一个空串只会让下游以为"读到了空内容"（与提取层的口径一致）。
    if (name === '' || field === '') continue
    out[name] = field
  }
  return out
}

function tablesOf(value: unknown): Array<{ name: string; rows: string[][] }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ name: string; rows: string[][] }> = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const rows = Array.isArray(record.rows) ? record.rows : []
    out.push({
      name: text(record.name),
      rows: rows.map((row) => (Array.isArray(row) ? row.map((cell) => text(cell)) : [])),
    })
  }
  return out
}

/**
 * 造一个 Python 提取器。
 *
 * 每次 `extract` 都**重新落一遍脚本**：脚本随包发布，插件升级后案例目录里的旧副本会过期
 * （拿旧脚本解析新格式会得到"读不出来"，很难归因）。落盘是幂等的、代价是一次小文件写。
 */
export function pythonFileExtractor(deps: PythonExtractorDeps): FileExtractor {
  return {
    canHandle(_contentType: string, fileName: string): boolean {
      // 认不出来的类型也交给自己：脚本会给出**具体**的缺口文案（比"没有可用提取器"有用）。
      return text(fileName) !== ''
    },

    async extract(input: { path: string; fileName: string; kind: ValuationFileKind }): Promise<ExtractedFile> {
      const empty = emptyExtractedFile(input.fileName, input.kind)
      if (deps.python === undefined) {
        throw new Error('DSH 自带 Python 解析器没有装配：无法执行技能提取脚本')
      }
      const runtime = await deps.python.check({})
      if (!runtime.ok) {
        throw new Error(`DSH 自带 Python 不可用（${runtime.state}）：${runtime.error}`)
      }

      // ① 脚本落盘（先读包内正文，再写进案例目录）。
      const source = deps.sourceScriptPath ?? packagedExtractScriptPath()
      if (source === '') throw new Error('包内找不到技能脚本 extract_files.py：插件包可能不完整')
      const read = deps.readSource ?? (async (path: string) => await readFile(path, 'utf8').catch(() => ''))
      const body = await read(source)
      if (body === '') throw new Error('技能脚本 extract_files.py 读不出内容：插件包可能不完整')
      const scriptPath = joinLocalPath(deps.casePath, EXTRACT_SCRIPT_DIR, EXTRACT_SCRIPT_NAME)
      const staged = await writeCaseText(deps.ctx, scriptPath, body, {
        ...(deps.session === undefined ? {} : { session: deps.session }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      })
      if (!staged.ok) throw new Error(`技能脚本落盘失败：${staged.error}`)

      // ② 逐个文件调用。输出写成案例目录里的一个 JSON，再读回来 —— 不走 stdout：
      //    表格可能很大，而命令输出有上限，被截断的 JSON 会变成"解析失败"这种误导性结论。
      const outPath = joinLocalPath(deps.casePath, EXTRACT_OUTPUT_DIR, `提取-${safeName(input.fileName)}.json`)
      const platform = await deps.world.platform()
      const run = await deps.access.runShell(
        { operation: 'python.script.run', source: 'audit-tool', workdir: deps.casePath },
        shellInvoke(runtime.path, [scriptPath, input.path, outPath], platform),
        {
          workdir: deps.casePath,
          timeoutMs: EXTRACT_TIMEOUT_MS,
          ...(deps.session === undefined ? {} : { session: deps.session }),
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
          summary: 'valuation file extract',
        },
      )
      const errorKind = classifyRun(run)
      const raw = await readTextIfExists(deps.ctx, outPath)
      if (raw === '') {
        const detail = errorKind === '' ? '脚本没有写出结果文件' : reasonOf(run)
        throw new Error(clampText(detail, 400))
      }

      let payload: ScriptPayload
      try {
        payload = JSON.parse(raw) as ScriptPayload
      } catch (error) {
        throw new Error(`提取结果不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      }

      const gaps = stringsOf(payload.capabilityGaps)
      const fileError = text(payload.error)
      // `ok: false` 一律按"这一份没解析"处理 —— 包括"缺 PDF 库""无文本层""旧版 .doc"。
      // 关键点：**不返回半截 extractedFields**（读不出来就不该有字段）。
      if (payload.ok !== true) {
        throw new Error([fileError, ...gaps].filter((item) => item !== '').join('；') || '提取脚本报告读取失败')
      }

      const kind: ValuationFileKind = (text(payload.fileType) || input.kind) as ValuationFileKind
      const fields = payload.extractedFields
      // P1 事实（逐页文本层 + 部署能力）：形状不对就**整键缺省**（未知），而不是补 0 / 补 false。
      // 用条件展开而不是 `pages: undefined`：`'pages' in result` 必须是假的，
      // 否则"未知"会被读成"已知，只是空"。
      const pages = pagesOf(payload.pages)
      const pageCount = countOf(payload.pageCount)
      const pagesWithText = countOf(payload.pagesWithText)
      const pagesWithoutText = countOf(payload.pagesWithoutText)
      const capabilities = capabilitiesOf(payload.capabilities)
      const capabilityProbe = evidenceOf(payload.capabilityProbe)
      return {
        ...empty,
        fileType: kindOf(input.fileName) === 'unknown' ? kind : kindOf(input.fileName),
        text: text(payload.text),
        tables: tablesOf(payload.tables),
        images: Array.isArray(payload.images)
          ? payload.images.flatMap((item) => {
            if (item === null || typeof item !== 'object') return []
            const record = item as Record<string, unknown>
            const path = text(record.path)
            return path === '' ? [] : [{ path, description: text(record.description) }]
          })
          : [],
        extractedFields: stringRecordOf(fields),
        ...(pages === undefined ? {} : { pages }),
        ...(pageCount === undefined ? {} : { pageCount }),
        ...(pagesWithText === undefined ? {} : { pagesWithText }),
        ...(pagesWithoutText === undefined ? {} : { pagesWithoutText }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(capabilityProbe === undefined ? {} : { capabilityProbe }),
        warnings: stringsOf(payload.warnings),
        capabilityGaps: gaps,
      }
    },
  }
}

/** 文件名安全化（只用于结果文件命名，不参与任何路径判定）。 */
function safeName(fileName: string): string {
  return text(fileName).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'file'
}

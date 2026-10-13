import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { isAbsoluteLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { isFile } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { writeCaseText } from '../common/case-files.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { kindOf } from '../../domains/report-evaluation/intake/classify.ts'
import { runExtraction } from '../../domains/report-evaluation/intake/extract.ts'
import { EXTRACT_OUTPUT_DIR, pythonFileExtractor } from '../../domains/report-evaluation/intake/python-extractor.ts'
import { VALUATION_MATERIAL_DIR, VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_file_extract`：**多类型资料的结构化提取**（协议 32）。
 *
 * 分工（与 `crwu_valuation_case_bootstrap` 同一条口径）：
 * - 真正的字节读取交给案例目录里的技能脚本（见 `intake/python-extractor.ts`）；
 * - 编排、降级与"读不出来就说读不出来"交给 `intake/extract.ts`（有独立单测）；
 * - 这里只做三件事：**校验调用范围**、**调编排**、**把完整结果落盘 + 只回紧凑摘要**。
 *
 * 为什么只回摘要：一张估值明细表几百行，几份文件就能把模型上下文塞满 —— 而模型真正要的是
 * 结构化字段与"哪一份没解析"。完整结果（正文 / 表格 / 图片）写在
 * `<案例目录>/提取结果/提取汇总.json`，需要时由子会话自己读。
 */

interface ExtractArgs {
  caseDir?: unknown
  files?: unknown
}

interface FileSummary {
  fileName: string
  fileType: string
  textLength: number
  tableCount: number
  imageCount: number
  extractedFields: Record<string, string>
  warnings: string[]
  capabilityGaps: string[]
}

interface ExtractResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  /** 完整结果的落点（含正文与表格）；子会话读它，不读返回值。 */
  resultPath: string
  /** 提取成功的文件（紧凑摘要）。 */
  files: FileSummary[]
  /** 一份都没解析出来的文件名。 */
  unparsed: string[]
  capabilityGaps: string[]
  warnings: string[]
}

function idleResult(): ExtractResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', resultPath: '',
    files: [], unparsed: [], capabilityGaps: [], warnings: [],
  }
}

/**
 * 把调用方提交的文件名收窄成**案例目录内的相对路径**。
 *
 * 拒绝而不是清洗（与 `crwu_run_python_script` 同一条理由）：静默清洗会让调用方以为
 * 自己拿到了一条它以为的路径。拒绝的三种：空串 / 绝对路径 / 含 `..`。
 */
function relativePathOf(value: unknown): { ok: true; path: string } | { ok: false; error: string } {
  const raw = text(value).trim()
  if (raw === '') return { ok: false, error: '文件名不能为空' }
  if (isAbsoluteLocalPath(raw)) return { ok: false, error: `只接受案例目录内的相对路径，不接受绝对路径：${raw}` }
  if (raw.split(/[\\/]+/).includes('..')) return { ok: false, error: `路径不许含 \`..\`：${raw}` }
  return { ok: true, path: raw }
}

export function valuationFileExtractTools(deps: ToolDeps) {
  const extract = defineTool({
    name: VALUATION_TOOL_NAMES.fileExtract,
    description: [
      '提取本轮估值资料的结构化内容（PDF 文本 / Word / Excel 表格 / 图片信息），并返回紧凑摘要。',
      '完整结果（正文与表格）写在案例目录的 提取结果/提取汇总.json 里，需要时自己读文件。',
      '读不出来的文件不会阻塞其他文件：它会出现在 unparsed 与 capabilityGaps 里——',
      '**绝不按文件名猜内容**。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      files: {
        type: 'array', items: { type: 'string' },
        description: `案例目录内的相对路径清单，例如 ${VALUATION_MATERIAL_DIR}/估值报告.pdf。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          resultPath: { type: 'string', required: true, description: `完整提取结果：${EXTRACT_OUTPUT_DIR}/提取汇总.json` },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                fileName: { type: 'string', required: true },
                fileType: { type: 'string', required: true },
                textLength: { type: 'integer', required: true },
                tableCount: { type: 'integer', required: true },
                imageCount: { type: 'integer', required: true },
                extractedFields: { type: 'object', required: true, additionalProperties: true },
                warnings: { type: 'array', required: true, items: { type: 'string' } },
                capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          unparsed: { type: 'array', required: true, items: { type: 'string' } },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: ExtractArgs, exec): Promise<ExtractResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：资料提取只能在估值子会话里进行') }
      }
      const casePath = access.casePath

      const requested = Array.isArray(args.files) ? args.files : []
      if (requested.length === 0) {
        return { ...base, ...failure('input', 'files 不能为空：请给出案例目录内的资料相对路径清单') }
      }

      // 收窄 + 存在性检查分开：先全部收窄（一次说清哪几条不合法），再逐条探测。
      const accepted: Array<{ path: string; fileName: string }> = []
      for (const item of requested) {
        const relative = relativePathOf(item)
        if (!relative.ok) return { ...base, ...failure('input', relative.error) }
        let absolute: string
        try {
          absolute = joinLocalPath(casePath, relative.path)
        } catch (error) {
          return {
            ...base,
            ...failure('input', `不是一条可用的案例内路径：${error instanceof Error ? error.message : String(error)}`),
          }
        }
        if (!await isFile(ctx, absolute)) {
          return { ...base, ...failure('not-found', `案例目录里找不到这份资料：${relative.path}`) }
        }
        accepted.push({ path: absolute, fileName: relative.path.split(/[\\/]+/).pop() ?? relative.path })
      }

      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const outcome = await runExtraction({
        files: accepted.map((file) => ({ path: file.path, fileName: file.fileName, kind: kindOf(file.fileName) })),
        extractors: [pythonFileExtractor({
          ctx,
          access: deps.access,
          python: deps.python,
          world: { platform: () => deps.world.platform() },
          casePath,
          ...(session === undefined ? {} : { session }),
          ...(signal === undefined ? {} : { signal }),
        })],
      })

      // 完整结果落盘：正文与表格不进模型上下文。
      const resultPath = joinLocalPath(casePath, EXTRACT_OUTPUT_DIR, '提取汇总.json')
      const written = await writeCaseText(ctx, resultPath, canonicalJson(outcome), {
        ...(session === undefined ? {} : { session }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!written.ok) {
        return { ...base, ...failure('infrastructure', `提取结果落盘失败：${written.error}`) }
      }

      const files: FileSummary[] = outcome.files.map((file) => ({
        fileName: file.fileName,
        fileType: file.fileType,
        textLength: file.text.length,
        tableCount: file.tables.length,
        imageCount: file.images.length,
        extractedFields: { ...file.extractedFields },
        warnings: [...file.warnings],
        capabilityGaps: [...file.capabilityGaps],
      }))

      // `ok` 的含义：**至少有一份读出来了**。全都没读出来时 ok=false + 缺口清单，
      // 让上层直接看到"这一轮没有可用资料"，而不是"成功但结果是空的"。
      const ok = files.length > 0
      return {
        ok,
        errorKind: ok ? '' : 'capability-gap',
        error: ok ? '' : '没有任何一份资料被成功解析：请检查文件格式，或补充可读的资料',
        caseDir: casePath,
        resultPath,
        files,
        unparsed: [...outcome.unparsed],
        capabilityGaps: [...outcome.capabilityGaps],
        warnings: [...outcome.warnings],
      }
    },
  })

  return [extract]
}

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { packageRootFrom } from '../../core/platform/package-root.ts'

/**
 * 把 `crwu-ocr` 技能运行时落到**本轮案例目录**里。
 *
 * ## 为什么必须落盘
 *
 * `crwu_run_python_script` 只接受案例目录内的脚本相对路径（安全边界：调用方提交不了任意
 * 可执行路径）。技能随插件发布在安装包里，所以 Host 在第一次调用时把它的运行脚本与依赖
 * 位置写进 `<案例>/ocr-skill/`，模型只看到案例内的稳定路径。
 *
 * ## 依赖不落盘
 *
 * 随包 wheel（`vendor/wheels/`）留在安装目录，`runtime.json` 只记录它的绝对路径。
 * wheel 几个 MB，逐案复制既慢又多一份可被误改的副本；Python 侧只读、按 sha256 校验后
 * 解包到 `ocr/.deps/`。插件升级后重新暂存脚本，`runtime.json` 指向新包。
 */

export const OCR_SKILL_RELATIVE = joinLocalPath('skills', 'capabilities', 'crwu-ocr')
export const OCR_STAGE_DIR = 'ocr-skill'
export const OCR_STAGE_SCRIPTS = joinLocalPath(OCR_STAGE_DIR, 'scripts')

/** 运行时需要的脚本；测试、示例与维护脚本不随案例暂存。 */
export const OCR_RUNTIME_FILES = [
  'ocr_runtime.py',
  'ocr_engines.py',
  'ocr_quartz.py',
  'ocr_prepare.py',
  'ocr_record.py',
  'ocr_merge.py',
  'ocr_status.py',
  'ocr_coverage.py',
] as const

/** 模型可以提交的 OCR 脚本（案例内相对路径）。 */
const OCR_SCRIPT_NAMES = new Set([
  'ocr_prepare.py', 'ocr_record.py', 'ocr_merge.py', 'ocr_status.py', 'ocr_coverage.py',
])

/**
 * 是否是 Host 暂存的 OCR 运行时脚本。
 *
 * 先按**路径语义**归一，再判位置：`ocr-skill//scripts/x.py`、`ocr-skill/./scripts/x.py`
 * 与 `OCR-SKILL/scripts/x.py` 在 APFS/NTFS 上解析到同一个文件，只认字面串等于给
 * `--case` 校验（以及"谁会用到暂存脚本"的判断）留了一个稳定的后门。
 */
export function isOcrSkillScript(relative: string): boolean {
  const canonical = normalize(text(relative).trim().replace(/\\/g, '/')).replace(/\\/g, '/')
  const match = /^ocr-skill\/scripts\/([^/]+)$/i.exec(canonical)
  return match !== null && OCR_SCRIPT_NAMES.has(match[1].toLowerCase())
}

/**
 * `--case` must name **this** audit case.
 *
 * The scripts write page images and index files relative to `--case`; accepting a
 * model-supplied path would let one case read/write another case's OCR directory
 * wherever the sandbox happens to allow it. The Host already validated the call's
 * case, so the argument has to agree with it.
 *
 * Every occurrence is collected: Python's argparse keeps the **last** `--case`, so
 * reading only the first one validated a value the script never used.
 */
export function ocrCaseArgumentProblem(scriptArgs: readonly string[], casePath: string, platform: string): string {
  const givens: string[] = []
  for (let index = 0; index < scriptArgs.length; index += 1) {
    const item = text(scriptArgs[index])
    if (item === '--case') {
      givens.push(text(scriptArgs[index + 1]))
      index += 1
      continue
    }
    if (item.startsWith('--case=')) givens.push(item.slice('--case='.length))
  }
  if (givens.length > 1) {
    return 'OCR 脚本的 `--case` 只允许出现一次：重复时 Python 取最后一个，等于绕开本轮案例校验'
  }
  const given = givens[0] ?? ''
  if (given === '') return 'OCR 脚本必须带 `--case <本轮案例目录>`'
  const absolute = platform === 'win32'
    ? /^[a-zA-Z]:[\\/]/.test(given) || given.startsWith('\\\\')
    : isAbsolute(given)
  if (!absolute) return `OCR 脚本的 --case 必须是绝对路径：${given}`
  const fold = (value: string): string => {
    const normalized = normalize(value).replace(/[\\/]+$/, '')
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  if (fold(given) !== fold(casePath)) {
    return `OCR 脚本的 --case 必须是本轮案例目录（收到 ${given}，本轮为 ${casePath}）`
  }
  return ''
}

export function ocrPackageRoot(): string {
  return packageRootFrom(dirname(fileURLToPath(import.meta.url)))
}

export interface OcrStageInput {
  casePath: string
  /** 包根；测试可注入。 */
  sourceRoot?: string
  /** 注入的写入器（默认走案例文件服务）；返回失败即停止。 */
  writeText: (path: string, content: string) => Promise<{ ok: boolean; error: string }>
  /** 注入的建目录器。 */
  ensureDir: (path: string) => Promise<{ ok: boolean; error: string }>
}

export interface OcrStageResult {
  ok: boolean
  error: string
  /** 案例内的脚本目录（绝对路径）。 */
  scriptDir: string
  /** 随包 wheel 根（绝对路径）；缺失时为空串。 */
  wheelRoot: string
  files: string[]
}

interface RuntimeConfig {
  schemaVersion: number
  skill: string
  wheelRoot: string
}

export function ocrRuntimeConfig(wheelRoot: string): RuntimeConfig {
  return { schemaVersion: 1, skill: 'crwu-ocr', wheelRoot }
}

/**
 * 暂存并回读脚本。每次调用都重写（6 个小文件）：插件升级后旧副本会过期，
 * 而"旧脚本解析新格式"表现为读不出来或悄悄少检查一项，很难归因。
 */
export async function stageOcrSkill(input: OcrStageInput): Promise<OcrStageResult> {
  const empty = { ok: false, error: '', scriptDir: '', wheelRoot: '', files: [] as string[] }
  const root = input.sourceRoot ?? ocrPackageRoot()
  if (root === '') return { ...empty, error: '找不到插件包根：无法暂存 crwu-ocr 技能' }
  const skillRoot = joinLocalPath(root, ...OCR_SKILL_RELATIVE.split(/[\\/]+/))
  if (!existsSync(skillRoot)) {
    return { ...empty, error: '插件包缺少 crwu-ocr 技能（skills/capabilities/crwu-ocr）：请重装完整插件包' }
  }
  const wheelRoot = joinLocalPath(skillRoot, 'vendor', 'wheels')
  if (!existsSync(joinLocalPath(wheelRoot, 'manifest.json'))) {
    return { ...empty, error: '插件包缺少 OCR 依赖清单（vendor/wheels/manifest.json）：请重装完整插件包' }
  }

  const scripts: Array<{ name: string; body: string }> = []
  for (const name of OCR_RUNTIME_FILES) {
    const source = joinLocalPath(skillRoot, 'scripts', name)
    if (!existsSync(source)) {
      return { ...empty, error: `插件包缺少 OCR 技能脚本 scripts/${name}：请重装完整插件包` }
    }
    try {
      scripts.push({ name, body: await readFile(source, 'utf8') })
    } catch (error) {
      return { ...empty, error: `OCR 技能脚本 scripts/${name} 读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    if (scripts[scripts.length - 1]?.body === '') {
      return { ...empty, error: `OCR 技能脚本 scripts/${name} 是空文件：请重装完整插件包` }
    }
  }

  const scriptDir = joinLocalPath(input.casePath, ...OCR_STAGE_SCRIPTS.split(/[\\/]+/))
  const made = await input.ensureDir(scriptDir)
  if (!made.ok) return { ...empty, error: `创建 OCR 脚本目录失败：${made.error}` }

  const written: string[] = []
  for (const script of scripts) {
    const target = joinLocalPath(scriptDir, script.name)
    const result = await input.writeText(target, script.body)
    if (!result.ok) return { ...empty, error: `暂存 OCR 脚本 ${script.name} 失败：${result.error}`, scriptDir }
    written.push(target)
  }
  const configPath = joinLocalPath(input.casePath, OCR_STAGE_DIR, 'runtime.json')
  const config = await input.writeText(configPath, JSON.stringify(ocrRuntimeConfig(wheelRoot), null, 2) + '\n')
  if (!config.ok) return { ...empty, error: `暂存 OCR 运行时配置失败：${config.error}`, scriptDir }
  written.push(configPath)

  return { ok: true, error: '', scriptDir, wheelRoot, files: written }
}

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { packageRootFrom } from '../../../core/platform/package-root.ts'
import { writeCaseText } from '../../../tools/common/case-files.ts'

/**
 * 把**技能脚本**落到估值案例目录里，返回它在案例内的路径。
 *
 * ## 为什么必须先落盘
 *
 * `python.script.run`（以及模型可见的 `crwu_run_python_script`）只接受**案例目录之内**的
 * 脚本路径 —— 这是一条安全边界（不让调用方提交任意可执行路径）。Host 自己也要走同一条路，
 * 不给自己开后门，所以每次要跑技能脚本时先把它写进 `<案例目录>/scripts/`。
 *
 * ## 为什么每次都要重写
 *
 * 脚本随包发布，插件升级后案例目录里的旧副本会过期。拿旧脚本解析新格式表现为"读不出来"
 * 或"校验过了但其实少检查一项"，两种都很难归因。重写的代价是一次小文件写。
 *
 * ## 读包内文件走 `node:fs`，不读 `ctx.fs`
 *
 * `ctx.fs` 是**员工的**沙箱文件服务（边界是会话 cwd），拿它读插件安装目录既越界也依赖部署布局。
 * 案例目录里的**产物**才必须走 `ctx.fs`。
 */

/** 技能在包内的相对目录。 */
export const VALUATION_SKILL_RELATIVE = joinLocalPath('skills', 'biz', 'crwu-biz-valuation-realestate')

/** 技能脚本在案例目录内的落点子目录。 */
export const STAGE_DIR = 'scripts'

/** 插件包根；解析不到时为空串。 */
export function valuationPackageRoot(): string {
  return packageRootFrom(dirname(fileURLToPath(import.meta.url)))
}

/** 包内技能文件的绝对路径；不存在时为空串。 */
export function packagedSkillFile(relative: string, root = valuationPackageRoot()): string {
  if (root === '') return ''
  const path = joinLocalPath(root, ...VALUATION_SKILL_RELATIVE.split(/[\\/]+/), ...text(relative).split(/[\\/]+/))
  return existsSync(path) ? path : ''
}

export interface StageInput {
  ctx: Context
  casePath: string
  /** 技能内的相对路径，例如 `scripts/validate_result.py`。 */
  relative: string
  /** 包内源文件路径；缺省由 `packagedSkillFile` 解析。测试可注入。 */
  sourcePath?: string
  /** 注入的读取器（默认 `node:fs`）。 */
  readSource?: (path: string) => Promise<string>
  session?: Session
  signal?: AbortSignal
}

export interface StageResult {
  ok: boolean
  error: string
  /** 案例内的脚本路径（`<案例目录>/scripts/<文件名>`）。 */
  scriptPath: string
}

export async function stageSkillScript(input: StageInput): Promise<StageResult> {
  const name = text(input.relative).split(/[\\/]+/).pop() ?? ''
  if (name === '' || name.includes('..')) return { ok: false, error: `不是一条可用的技能脚本路径：${input.relative}`, scriptPath: '' }
  const source = input.sourcePath ?? packagedSkillFile(input.relative)
  if (source === '') {
    return { ok: false, error: `包内找不到技能脚本 ${input.relative}：插件包可能不完整`, scriptPath: '' }
  }
  const read = input.readSource ?? (async (path: string) => await readFile(path, 'utf8').catch(() => ''))
  const body = await read(source)
  if (body === '') return { ok: false, error: `技能脚本 ${input.relative} 读不出内容：插件包可能不完整`, scriptPath: '' }
  const scriptPath = joinLocalPath(input.casePath, STAGE_DIR, name)
  const written = await writeCaseText(input.ctx, scriptPath, body, {
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!written.ok) return { ok: false, error: `技能脚本落盘失败：${written.error}`, scriptPath: '' }
  return { ok: true, error: '', scriptPath }
}

export interface StageAssetResult {
  ok: boolean
  error: string
  /** 案例内的资产路径（保留技能内的相对目录形状）。 */
  path: string
}

/**
 * Stage a non-script skill asset (e.g. the report-data schema) under the case directory,
 * preserving the skill-relative directory layout so packaged scripts can resolve siblings.
 */
export async function stageSkillAsset(input: StageInput): Promise<StageAssetResult> {
  const relative = text(input.relative).replace(/\\/g, '/').replace(/^\/+/, '')
  if (relative === '' || relative.includes('..') || relative.includes(':')) {
    return { ok: false, error: `不是一条可用的技能资产路径：${input.relative}`, path: '' }
  }
  const source = input.sourcePath ?? packagedSkillFile(relative)
  if (source === '') {
    return { ok: false, error: `包内找不到技能资产 ${relative}：插件包可能不完整`, path: '' }
  }
  const read = input.readSource ?? (async (path: string) => await readFile(path, 'utf8').catch(() => ''))
  const body = await read(source)
  if (body === '') return { ok: false, error: `技能资产 ${relative} 读不出内容：插件包可能不完整`, path: '' }
  const target = joinLocalPath(input.casePath, ...relative.split('/'))
  const written = await writeCaseText(input.ctx, target, body, {
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!written.ok) return { ok: false, error: `技能资产落盘失败：${written.error}`, path: '' }
  return { ok: true, error: '', path: target }
}

import { text } from '../../../../shared/utils/value.ts'
import { shellInvoke } from '../../../core/platform/shell.ts'
import type { WorkbenchConfig } from '../../../config/config.ts'
import type { RecalcProvider } from './recalculation.ts'

/**
 * **表格计算程序的探测**（协议 39：把重算从"只有接口"接成"有生产调用点"）。
 *
 * ## 为什么引擎路径来自**配置**而不是扫 PATH
 *
 * 仓库的既有口径是"业务二进制从包内取，找不到就是能力缺口，绝不退到同名 PATH 命令"
 *（`plugins/AGENTS.md`）。LibreOffice / Excel **不是**本仓随包发布的组件，所以：
 *
 * - 它只能由**部署配置**显式指定（`valuation.recalculation.enginePath`，绝对路径）；
 * - 配置为空 = **本部署没有表格计算程序** = `unavailable` —— 这不是错误，而是事实，
 *   报告据此只能交付 `partial`（保留公式正确的底稿并标注"待重算"）；
 * - 绝不扫 PATH、绝不猜安装位置：猜出来的程序算出的数字与"没人算过"一样不可信。
 *
 * 探测只回答"配置里有没有指定"，**不去执行业务命令**：真正的执行与回读由受控工具
 * （命名 Broker 操作）完成，失败原因如实回报。
 */
export function recalcProvidersOf(config: WorkbenchConfig | undefined): readonly RecalcProvider[] {
  const raw = text((config as { valuation?: { recalculation?: { enginePath?: unknown } } } | undefined)
    ?.valuation?.recalculation?.enginePath).trim()
  if (raw === '') return []
  // `detail` 只回**程序名**，不回绝对路径（配置路径属于本机事实，不进模型可见结果）。
  const base = raw.replace(/\\/g, '/').split('/').filter((part) => part !== '').pop() ?? raw
  return [{
    id: 'libreoffice.local',
    detail: `部署配置指定的表格计算程序（${base}）`,
  }]
}

/**
 * **真正跑一次重算并回读**（协议 39）。
 *
 * ## 两步，各有自己的命名操作
 *
 * 1. **引擎重算**：`system.valuation-recalculation.run`（提权 shell）。用配置指定的表格程序
 *    把工作簿转成一份新的 xlsx —— 转换时程序会**真正打开并重算**，再把缓存值写进新文件。
 *    产物落在一个临时目录里，**原底稿一个字节都不动**（"打开一次就宣告成功"正是要防的假象）。
 * 2. **回读**：`python.script.run`（案例内脚本）。用 `read_workbook_values.py` 以
 *    `data_only=True` 读**缓存值**，读不到就是 `null` —— 绝不回填期望值。
 *
 * 两步都必须成功；任一步失败或读回来的数值对不上，结果就是 `verified: false`。
 */

export interface EngineObservationInput {
  objectId: string
  /** 单价位置（`表名!单元格`），来自模板自己的填写说明。 */
  unitPriceCell: string
  /** 总价位置（`表名!单元格`）。 */
  totalValueCell: string
}

export interface EngineRunRequest {
  /** 部署配置里的引擎绝对路径（空串 = 没有引擎，调用方应当先探测）。 */
  enginePath: string
  /** 底稿的**绝对路径**（原文件，只读）。 */
  workbookAbsolutePath: string
  /** 临时目录的**绝对路径**（引擎产物落这里）。 */
  scratchAbsolutePath: string
  observations: readonly EngineObservationInput[]
}

export interface EngineRunPorts {
  /** 引擎调用（经命名操作，提权）。 */
  runEngine: (input: { command: string; workdir: string }) => Promise<{
    ok: boolean
    exitCode: number | null
    stdout: string
    stderr: string
    error: string
  }>
  /** 跑案例内的技能脚本（经命名操作）。 */
  runScript: (input: {
    scriptPath: string
    scriptArgs: string[]
  }) => Promise<{ ok: boolean; stdout: string; stderr: string; error: string }>
  /** 引擎产物路径（引擎按源文件名输出；由调用方给，避免这里猜命名规则）。 */
  recalculatedAbsolutePath: string
  /** 回读脚本在案例内的路径。 */
  scriptPath: string
  now?: () => string
}

export interface EngineRunOutcome {
  ok: boolean
  error: string
  observed: Array<{ objectId: string; unitPrice: string | null; totalValue: string | null }>
  /** 回读脚本报出的事实（公式没缓存值、位置不对…）。**原样转述**。 */
  problems: string[]
}

/** 引擎要执行的那条命令（形状固定，路径由调用方给全）。 */
export function engineCommandOf(input: {
  enginePath: string
  workbookAbsolutePath: string
  scratchAbsolutePath: string
}, platform: string): string {
  // `--convert-to xlsx` 到**另一个**目录：这是 LibreOffice 系最通用的"打开并重算一次"的写法。
  return shellInvoke(input.enginePath, [
    '--headless',
    '--norestore',
    '--convert-to', 'xlsx',
    '--outdir', input.scratchAbsolutePath,
    input.workbookAbsolutePath,
  ], platform)
}

/** 回读脚本的入参（对象 → 位置）。 */
export function readBackCellsJson(observations: readonly EngineObservationInput[]): string {
  const payload: Record<string, { unitPrice: string; totalValue: string }> = {}
  for (const item of observations) {
    payload[item.objectId] = {
      unitPrice: text(item.unitPriceCell),
      totalValue: text(item.totalValueCell),
    }
  }
  return JSON.stringify(payload)
}

export async function runConfiguredEngine(
  request: EngineRunRequest,
  ports: EngineRunPorts,
  platform: string,
): Promise<EngineRunOutcome> {
  const empty: EngineRunOutcome = { ok: false, error: '', observed: [], problems: [] }
  if (text(request.enginePath).trim() === '') {
    return { ...empty, error: '没有配置表格计算程序：无法重算' }
  }
  if (request.observations.length === 0) {
    return { ...empty, error: '没有给出任何「对象 → 数值位置」：无从回读，也不许猜位置' }
  }

  const engine = await ports.runEngine({
    command: engineCommandOf(request, platform),
    workdir: request.scratchAbsolutePath,
  })
  if (!engine.ok) {
    // 引擎失败的原因原样带回（模型可见结果里不出现绝对路径以外的凭据；这里是配置路径，不进结果）。
    const detail = text(engine.stderr).trim() || text(engine.stdout).trim() || engine.error
    return { ...empty, error: `表格计算程序没有成功重算（退出码 ${String(engine.exitCode ?? 'null')}）：${detail.slice(0, 400)}` }
  }

  const read = await ports.runScript({
    scriptPath: ports.scriptPath,
    scriptArgs: ['--workbook', ports.recalculatedAbsolutePath, '--cells', readBackCellsJson(request.observations)],
  })
  if (!read.ok) {
    return {
      ...empty,
      error: `回读重算后的工作簿失败：${(text(read.stderr).trim() || read.error).slice(0, 400)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text(read.stdout))
  } catch {
    return { ...empty, error: `回读脚本的输出不是 JSON：${text(read.stdout).slice(0, 200)}` }
  }
  const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {}
  const observed = (Array.isArray(record.observed) ? record.observed : []).map((item) => {
    const row = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown> : {}
    return {
      objectId: text(row.objectId),
      unitPrice: text(row.unitPrice) === '' ? null : text(row.unitPrice),
      totalValue: text(row.totalValue) === '' ? null : text(row.totalValue),
    }
  })
  const problems = (Array.isArray(record.problems) ? record.problems : [])
    .map((item) => text(item)).filter((item) => item !== '')
  return { ok: true, error: '', observed, problems }
}

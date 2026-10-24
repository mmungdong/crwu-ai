import type { Context } from '@deepseek-ai/cordis'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../../core/fs/paths.ts'

/**
 * 发布前的 OCR 覆盖率快照检查（设计 §6「发布侧」）。
 *
 * 交付校验（`audit_delivery validate --case`）已经会拦，但那只在模型**按流程跑**时成立；
 * 发布工具是最后一道可执行的闸门：快照缺失、或覆盖率未通过时不许上传。
 *
 * ## 读不出来 ≠ 不存在（2026-10-23 复查）
 *
 * 旧实现把所有读取失败折成空串，于是"文件服务不可用 / 权限拒绝 / 文件损坏"会被当成
 * "本轮不需要 OCR"直接放行 —— 最后一道闸门 fail-open 等于没有闸门。现在三态分开：
 * `content` / `missing` / `unreadable`，只有**确定不存在**才可能放行，读不出来一律 fail-closed。
 *
 * **不在这里复核 `indexDigest`**：快照的 digest 由 Python 的规范化序列化算出
 * （`ensure_ascii=False, sort_keys=True, separators=(",", ":")`），在 JS 里复刻会因
 * 浮点数与转义差异产生假"过期"。digest 的权威校验留在 `audit_delivery validate --case`；
 * 这里只回答"有没有通过的门禁快照"。
 */
export const COVERAGE_FILE = 'ocr/coverage.json'
export const COVERAGE_INDEX_FILE = 'ocr/index.json'
export const COVERAGE_INVENTORY_FILE = '材料盘点.json'

export interface CoverageGuardResult {
  ok: boolean
  errorKind: 'policy' | 'infrastructure' | ''
  error: string
  /** 通过时为快照里的 `gate.effectiveStatus`，供调用方回显。 */
  status: string
}

const PASS: CoverageGuardResult = { ok: true, errorKind: '', error: '', status: 'pass' }

/**
 * "不存在"的错误指纹。
 *
 * 沙箱后端对同一件事的措辞不统一（`ENOENT` / `no such file` / `cannot find` / 中文"不存在"），
 * 而 `stat` 既可能回 `undefined` 也可能抛错。只有**两种信号都指向不存在**时才当作 `missing`，
 * 其余一律按 `unreadable` fail-closed —— 漏一个权限错误，比误拦一次发布代价大得多。
 */
const NOT_FOUND = /ENOENT|no such file|not found|cannot find|不存在|找不到/i

type CaseFile =
  | { kind: 'content'; text: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string }

function failureOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** 读一个案例内文件，三态返回；**不抛异常**。 */
async function readCaseFile(ctx: Context, path: string): Promise<CaseFile> {
  const fs = fileSystem(ctx)
  if (fs === undefined) {
    return { kind: 'unreadable', error: 'Host 文件服务不可用：无法确认覆盖率快照，按 fail-closed 拒绝发布' }
  }
  try {
    const target = await resolveTarget(ctx, path)
    const info = await fs.stat(target)
    if (info === undefined) return { kind: 'missing' }
    if (info.type !== 'file') return { kind: 'unreadable', error: '不是普通文件' }
    return { kind: 'content', text: await fs.readText(target) }
  } catch (error) {
    const message = failureOf(error)
    return NOT_FOUND.test(message) ? { kind: 'missing' } : { kind: 'unreadable', error: message }
  }
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function infrastructure(error: string): CoverageGuardResult {
  return { ok: false, errorKind: 'infrastructure', status: '', error }
}

/**
 * 本轮是否**必须**有覆盖率快照。
 *
 * `材料盘点.json.ocrRequired[]` 非空：这轮有需要 OCR 的材料；
 * `ocr/index.json` 存在：已经跑过页图判读。两者任一成立就不能"没有快照也算过"。
 */
function coverageRequired(inventory: Record<string, unknown> | undefined, hasIndex: boolean): boolean {
  if (hasIndex) return true
  const required = inventory?.ocrRequired
  return Array.isArray(required) && required.length > 0
}

/**
 * 发布前的门禁：返回 `ok=false` 时调用方必须放弃上传并原样带回 `error`。
 *
 * 只在案例目录内读两个文件（`ocr/coverage.json`、`材料盘点.json`），不执行命令、不写任何东西。
 */
export async function requireCoveragePass(ctx: Context, caseDir: string): Promise<CoverageGuardResult> {
  const coverageFile = await readCaseFile(ctx, joinLocalPath(caseDir, COVERAGE_FILE))
  if (coverageFile.kind === 'unreadable') {
    return infrastructure(`${COVERAGE_FILE} 读不出来（${coverageFile.error}）：`
      + '这是发布闸门的基础设施故障，可重试；不要把它当成"没做 OCR"')
  }

  const inventoryFile = await readCaseFile(ctx, joinLocalPath(caseDir, COVERAGE_INVENTORY_FILE))
  if (inventoryFile.kind === 'unreadable') {
    return infrastructure(`${COVERAGE_INVENTORY_FILE} 读不出来（${inventoryFile.error}）：`
      + '无法核对本轮是否需要 OCR，按 fail-closed 拒绝发布（可重试）')
  }
  let inventory: Record<string, unknown> | undefined
  if (inventoryFile.kind === 'content' && inventoryFile.text.trim() !== '') {
    inventory = parseObject(inventoryFile.text)
    if (inventory === undefined) {
      return infrastructure(`${COVERAGE_INVENTORY_FILE} 不是 JSON 对象：无法核对本轮是否需要 OCR，`
        + '按 fail-closed 拒绝发布')
    }
  }

  const indexFile = await readCaseFile(ctx, joinLocalPath(caseDir, COVERAGE_INDEX_FILE))
  if (indexFile.kind === 'unreadable') {
    return infrastructure(`${COVERAGE_INDEX_FILE} 读不出来（${indexFile.error}）：按 fail-closed 拒绝发布`)
  }
  const hasIndex = indexFile.kind === 'content' && indexFile.text.trim() !== ''

  if (coverageFile.kind === 'missing') {
    if (!coverageRequired(inventory, hasIndex)) return PASS
    return {
      ok: false,
      errorKind: 'policy',
      status: '',
      error: `本轮有需要 OCR 的材料，但缺少 ${COVERAGE_FILE}：先跑 `
        + '`ocr-skill/scripts/ocr_coverage.py --case <案例目录>`，'
        + '再用 `audit_delivery.py validate <结果.json> --case <案例目录>` 过门禁',
    }
  }

  const coverage = parseObject(coverageFile.text)
  if (coverage === undefined) {
    return infrastructure(`${COVERAGE_FILE} 不是 JSON 对象：重跑 ocr_coverage.py 再发布`)
  }

  const status = typeof coverage.status === 'string' ? coverage.status : ''
  const gate = coverage.gate !== null && typeof coverage.gate === 'object'
    ? coverage.gate as Record<string, unknown>
    : {}
  // `effectiveStatus` 已按 policy 折算：本地审核（disclose）的未核不阻断，托管审核仍阻断。
  // 托管审核走不到这里（本地产物不回传），但契约保持单一：只看 effectiveStatus。
  const gateStatus = typeof gate.effectiveStatus === 'string'
    ? gate.effectiveStatus
    : (typeof gate.status === 'string' ? gate.status : '')

  if (status === 'index-missing') {
    return {
      ok: false,
      errorKind: 'policy',
      status,
      error: '覆盖率快照判定"缺 ocr/index.json"：材料盘点里的扫描件还没渲成页图，'
        + '先跑 `ocr_prepare.py --only <清单路径>` 再重跑 ocr_coverage.py',
    }
  }
  if (gateStatus !== 'pass') {
    const blocks = Array.isArray(gate.blocks) ? gate.blocks : []
    const reasons = blocks
      .map((block) => {
        if (block === null || typeof block !== 'object') return ''
        const item = block as Record<string, unknown>
        const kind = typeof item.kind === 'string' ? item.kind : ''
        const where = typeof item.relativePath === 'string' ? item.relativePath : ''
        return kind === '' ? '' : (where === '' ? kind : `${kind}（${where}）`)
      })
      .filter((item) => item !== '')
      .slice(0, 5)
      .join('、')
    return {
      ok: false,
      errorKind: 'policy',
      status,
      error: `OCR 覆盖率门禁未通过（gate.effectiveStatus=${gateStatus === '' ? '（空）' : gateStatus}）`
        + `${reasons === '' ? '' : `：${reasons}`}；读完待判读页后重跑 ocr_coverage.py`,
    }
  }
  return { ...PASS, status: 'pass' }
}

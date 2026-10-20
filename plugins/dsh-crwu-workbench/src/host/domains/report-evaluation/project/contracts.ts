import { text } from '../../../../shared/utils/value.ts'
import {
  ASSET_TYPES,
  PURPOSE_MAX_LENGTH,
  VALUE_TYPE_MAX_LENGTH,
  VALUATION_INPUT_SCHEMA_VERSION,
} from '../../../../shared/contracts/valuation-project.ts'
import type {
  ArchivedMaterial,
  AssetType,
  Blocker,
  FrozenInput,
  HandoffReceipt,
  KnowledgeRef,
  MethodRequest,
  PlanAssessment,
  ReportData,
  TaskNode,
  ValuationPath,
  ValueScope,
} from '../../../../shared/contracts/valuation-project.ts'

/**
 * Host 侧的**项目合同收窄与派生物**（计划 Task 1）。
 *
 * 类型本身在 `shared/contracts/valuation-project.ts`（两端都要认）；这里只放 Host 独有的
 * 运行期判定与派生：值收窄、基准日归一化、安全路径段。放这里而不是 shared，
 * 是因为这些都是"Host 不收就出事"的边界检查，Client 不需要也不该复制一份。
 *
 * 派生的 id 一律**只由 Host 铸号**：projectId / planId / taskId 会成为目录名的一部分，
 * 让模型或页面提交它们等于把任意路径写权限交出去。
 */

export type {
  ArchivedMaterial,
  Blocker,
  FrozenInput,
  HandoffReceipt,
  KnowledgeRef,
  MethodRequest,
  PlanAssessment,
  ReportData,
  TaskNode,
  ValuationPath,
  ValueScope,
}

// ---------------------------------------------------------------------------
// 值收窄
// ---------------------------------------------------------------------------

const VALUATION_PATH_VALUES: readonly string[] = ['combined', 'separate', 'unresolved']
const VALUE_SCOPE_VALUES: readonly string[] = ['land-only', 'building-only', 'land-and-building']

export function isValuationPath(value: unknown): value is ValuationPath {
  return VALUATION_PATH_VALUES.includes(text(value))
}

export function isValueScope(value: unknown): value is ValueScope {
  return VALUE_SCOPE_VALUES.includes(text(value))
}

// ---------------------------------------------------------------------------
// 基准日
// ---------------------------------------------------------------------------

/**
 * 把界面提交的基准日归一化为 `YYYY-MM-DD` 或 `null`。
 *
 * 两件事不能含糊：
 *   - 空串是**未指定**（`null`），不是"今天"，也**不是**从资料日期里补一个出来的值；
 *   - 形状对不等于日期存在：`2026-02-30` 必须被拒，而不是原样冻结进快照
 *     然后让计算结果挂在一个不存在的日期上。
 *
 * 返回 `{ ok, value, error }`：调用方要么把 `error` 当作输入错误返回，要么用 `value`。
 */
export function normalizeBaseDate(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = text(value).trim()
  if (raw === '') return { ok: true, value: null }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (match === null) return { ok: false, error: `基准日必须是 YYYY-MM-DD 格式，收到「${raw}」` }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // 用 UTC 构造再回读：Date 会把 2026-02-30 归一化成 3 月 2 日，回读即可发现不存在的那一天。
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return { ok: false, error: `基准日「${raw}」不是一个存在的日期` }
  }
  return { ok: true, value: raw }
}

// ---------------------------------------------------------------------------
// 评估目的 / 价值类型
// ---------------------------------------------------------------------------

/**
 * 把界面提交的**评估目的**归一化为文本或 `null`。
 *
 * 两条口径与基准日一致：
 *   - 空串是**未指定**（`null`），不是"默认转让 / 抵押"，也不是从补充要求里猜一个出来；
 *   - 超长说明它不是一句口径而是一段话：拒绝，而不是截断（截了之后报告里的前提就是错的）。
 *
 * ⚠️ **可选值清单不在代码里**：评估目的与价值类型属于业务规范（本轮知识快照），
 * 在业务方确认之前代码只做长度与形状检查，不发明枚举。
 */
export function normalizePurpose(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  return normalizeBusinessInput(value, '评估目的', PURPOSE_MAX_LENGTH)
}

/**
 * 把界面提交的**资产类型**收窄成已登记的稳定标识。
 *
 * 与评估目的 / 价值类型**不一样**：那两个允许自由文本，资产类型只认共享合同里的枚举 ——
 * 它是装配哪个 Skill 与哪份入口 Wiki 的依据，一个不认识的字符串没有任何入口可去。
 * 未选（空串 / 缺字段）直接拒绝：没有"默认房地产"这一档。
 */
export function normalizeAssetType(value: unknown): { ok: true; value: AssetType } | { ok: false; error: string } {
  const raw = text(value).trim()
  if (raw === '') {
    return { ok: false, error: '还没有选择资产类型：请先在通用估值页选定本轮要估的资产。' }
  }
  if (!(ASSET_TYPES as readonly string[]).includes(raw)) {
    return { ok: false, error: `不认识的资产类型「${raw}」：请从资产类型下拉里选择。` }
  }
  return { ok: true, value: raw as AssetType }
}

/** 把界面提交的**价值类型**归一化为文本或 `null`（与评估目的同一套口径）。 */
export function normalizeValueType(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  return normalizeBusinessInput(value, '价值类型', VALUE_TYPE_MAX_LENGTH)
}

function normalizeBusinessInput(
  value: unknown,
  label: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = text(value).trim()
  if (raw === '') return { ok: true, value: null }
  if (raw.length > maxLength) {
    return { ok: false, error: `${label}太长（${String(raw.length)} 字符，上限 ${String(maxLength)} 字符）：请填一句口径，不要贴整段说明。` }
  }
  // 控制字符会把一句口径变成多行/终端指令：宁可拒绝，也不把它冻结进快照。
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, error: `${label}里有不可见控制字符：请重新输入一行口径。` }
  }
  return { ok: true, value: raw }
}

// ---------------------------------------------------------------------------
// 安全路径段
// ---------------------------------------------------------------------------

/**
 * 一个 id 能不能当作**单段**目录名。
 *
 * 与流水号/估值 id 同一口径：不含分隔符、不含 `..`、不是 `.`、长度有界。
 * 中文显示名叫什么都可以 —— 它只做标签，不参与路径（设计稿 §11.1）。
 */
export function isSafeIdSegment(value: unknown): boolean {
  const raw = text(value).trim()
  if (raw === '' || raw.length > 128) return false
  if (raw === '.' || raw === '..') return false
  return !/[\\/]/.test(raw) && !raw.includes('..')
}

/** 把任意标签折叠成一个可用的路径段（仅用于**显示名派生的**案例目录名）。 */
export function safeIdSegment(value: unknown, fallback = 'item'): string {
  const raw = text(value).trim()
  const folded = raw.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/\.+/g, '-').replace(/^-+|-+$/g, '')
  const clean = folded === '' ? fallback : folded
  return isSafeIdSegment(clean) ? clean.slice(0, 64) : fallback
}

// ---------------------------------------------------------------------------
// 冻结输入
// ---------------------------------------------------------------------------

export interface FrozenInputParts {
  projectId: string
  assetType: AssetType
  methodRequest: MethodRequest
  baseDate: string | null
  purpose: string | null
  valueType: string | null
  /** Archived template material id; defaults to null when omitted. */
  templateFileId?: string | null
  supplementalPrompt: string
  files: ArchivedMaterial[]
  inputDigest: string
}

/** 组装冻结输入，并把 Schema 版本钉在一处（别处不硬编码字符串）。 */
export function buildFrozenInput(parts: FrozenInputParts): FrozenInput {
  return {
    schemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
    projectId: parts.projectId,
    assetType: parts.assetType,
    methodRequest: parts.methodRequest,
    baseDate: parts.baseDate,
    purpose: parts.purpose,
    valueType: parts.valueType,
    // Normalize "no template" to null, never an empty string.
    templateFileId: parts.templateFileId === null || parts.templateFileId === undefined ? null : text(parts.templateFileId),
    supplementalPrompt: parts.supplementalPrompt,
    files: parts.files,
    inputDigest: parts.inputDigest,
  }
}

/** 补充要求的长度上限（Client 与 Host 必须同一个数）。 */
export const SUPPLEMENTAL_PROMPT_MAX_LENGTH = 4000

/** 一次可提交的资料份数上限（递归去重后的文件数）。 */
export const MAX_MATERIAL_FILES = 200

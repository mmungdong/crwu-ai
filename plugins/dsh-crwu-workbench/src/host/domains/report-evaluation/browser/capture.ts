import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { isFile } from '../../../core/fs/paths.ts'
import { writeCaseText } from '../../../tools/common/case-files.ts'

/**
 * **来源证据**的落盘。
 *
 * ## 证据是什么（以及本部署拿不到什么）
 *
 * 理想证据是页面截图。本部署**没有**可用的无头浏览器，所以能力的上限是
 * "把取到的页面字节原样存进案例目录 + 记指纹" —— 那是可核对的（事后拿同一 URL 对比、
 * 或人工打开留存页），但**不能替代**截图。这个差别必须写进 `capabilityGaps`，
 * 不能因为"反正存了点东西"就默认证据充分。
 *
 * ## 三条约束
 *
 * 1. **只写案例目录内**：路径由 Host 拼，调用方提交的只有"哪一条 URL / 哪一页"；
 * 2. **不存敏感面**：落盘的是站点返回的公开页面字节；调用方**不能**往里塞请求头或 Cookie
 *    （本层的入口只有 `url` / `body` / `casePath`）；
 * 3. **指纹可核对**：文件名带 `sha256` 前 12 位，同一页重抓同一份内容 → 同一个名字（幂等覆盖），
 *    内容变了则产生新文件（不覆盖历史证据）。
 */

/** 证据目录名（案例目录内）。 */
export const EVIDENCE_DIR = '来源证据'

/** 证据文件名的最大长度（URL 可能很长）。 */
const NAME_MAX = 72

/** 证据条目。 */
export interface EvidenceEntry {
  ok: boolean
  error: string
  /** 相对案例目录的落点，例如 `来源证据/fang-3f2a1b0c9d8e.html`。 */
  file: string
  /** 内容指纹（`sha256:<hex>`）；失败时为空串。 */
  digest: string
  bytes: number
  url: string
  /** 站点返回的 HTTP 状态码（用于判断这份证据是不是错误页）。 */
  status: number
}

/** 由 URL 与内容算一个稳定、安全、可读的文件名。 */
export function evidenceFileName(source: string, url: string, body: string, extension = 'html'): string {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  let tail = ''
  try {
    const parsed = new URL(url)
    tail = `${parsed.hostname}${parsed.pathname}`.replace(/[^0-9A-Za-z.-]+/g, '_')
  } catch (error) {
    void error
    tail = 'page'
  }
  const head = `${text(source) || 'source'}-${tail}`.slice(0, NAME_MAX).replace(/[^0-9A-Za-z._-]+/g, '_')
  return `${head}-${digest}.${extension}`
}

/**
 * **可注入的页面截图能力**（§7.4）。
 *
 * ## 为什么是一个注入点，而不是在这里写死"没有截图"
 *
 * 方案要求"使用用户在 DSH 中已验证的浏览器及截图方法，封装为**可注入能力**，
 * 不另写一个无法取证的替代通道"。所以这一层只定义**接口与纪律**，具体实现由宿主装配：
 *
 * - 有实现时（DSH 提供了已验证的截图通道）→ 每个候选案例在采集时就存下截图，
 *   与案例的关联（哪条 URL / 哪一页 / 哪个案例）由调用方给定，**不靠文件名猜**；
 * - 没有实现时 → 如实写 `screenshot_missing`，并带上能力缺口文案。
 *   **绝不用页面字节 / 指纹 / JSON-LD 顶替截图**：那三样在争议复核时的证明力不一样。
 *
 * 这一层不做的事：自己去开浏览器、自己找截图工具、伪造一张图片。接口拿不到这些能力时，
 * 结论就是"没有截图"，而不是"想办法凑一张"。
 */
export interface ValuationScreenshotRequest {
  /** 要截图的页面 URL。 */
  url: string
  /** 本轮估值案例目录；实现方只能往它下面写。 */
  casePath: string
  /** 来源 id（fang / anjuke / lianjia…）。 */
  source: string
  /**
   * 这条截图关联的**案例 id**（`来源-序号`，与 `估值案例.json` 的案例顺序一致）。
   *
   * 单独给出来是因为"截图属于哪条案例"不能靠文件名推：同一页面上可能有多套房源。
   */
  caseId: string
  /** Optional human label used only for the evidence directory name. */
  displayName?: string
  /** Optional evidence type; omitted by legacy callers and never inferred as detail. */
  evidenceType?: 'page-screenshot' | 'detail-screenshot' | 'alternative-evidence'
  session?: Session
  signal?: AbortSignal
}

export interface ValuationScreenshotResult {
  ok: boolean
  error: string
  /** 相对案例目录的落点，例如 `来源证据/截图-fang-1.png`；失败时为空串。 */
  file: string
  /** 图片内容指纹（`sha256:<hex>`）；失败时为空串。 */
  digest: string
  bytes: number
  /** 采集时刻（ISO 字符串）。 */
  capturedAt: string
  /** Verified final page URL for this shot; empty for legacy callers that never verified one. */
  sourceUrl?: string
  /** Verified evidence type; omitted when the caller did not declare one. */
  evidenceType?: 'page-screenshot' | 'detail-screenshot' | 'alternative-evidence'
}

/** 注入的截图能力（`deps.screenshot`）。 */
export type ValuationScreenshotCapability = (
  request: ValuationScreenshotRequest,
) => Promise<ValuationScreenshotResult>

/** 没有截图能力时的结果（`ok:false` + 缺口人话，调用方据此写 `screenshot_missing`）。 */
export function screenshotUnavailable(reason: string = SCREENSHOT_GAP): ValuationScreenshotResult {
  return { ok: false, error: reason, file: '', digest: '', bytes: 0, capturedAt: '' }
}

export interface SaveEvidenceInput {
  ctx: Context
  /** 本轮估值案例目录（已由门禁核对归属）。 */
  casePath: string
  source: string
  url: string
  body: string
  status: number
  session?: Session
  signal?: AbortSignal
  /** 扩展名；HTML 页面用 `html`，JSON 响应可用 `json`。 */
  extension?: string
}

/** 把一份页面字节存进 `<案例>/来源证据/`。 */
export async function saveEvidence(input: SaveEvidenceInput): Promise<EvidenceEntry> {
  const body = text(input.body)
  const relative = joinLocalPath(EVIDENCE_DIR, evidenceFileName(
    input.source, input.url, body, text(input.extension) || 'html',
  ))
  const digest = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
  if (body === '') {
    return { ok: false, error: '页面内容为空：没有可留存的证据', file: '', digest: '', bytes: 0, url: input.url, status: input.status }
  }
  const written = await writeCaseText(input.ctx, joinLocalPath(input.casePath, relative), body, {
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!written.ok) {
    return { ok: false, error: written.error, file: '', digest: '', bytes: 0, url: input.url, status: input.status }
  }
  return { ok: true, error: '', file: relative, digest, bytes: body.length, url: input.url, status: input.status }
}

/**
 * 截图能力缺口文案。
 *
 * **每次**留存证据时都要带上它：本部署只能存页面字节，员工看到"有证据文件"会以为
 * 等于"有截图"，而两者在争议复核时的证明力不一样。
 */
export const SCREENSHOT_GAP = '本部署没有可用的页面截图能力：来源证据是页面字节（HTML）与指纹，不是截图。'
  + '需要可视证据时请在默认浏览器人工打开该页面并另存。'

/**
 * 采集一条候选案例的截图（有注入能力才做；没有就如实返回"不可用"）。
 *
 * **不伪造**：能力缺失、调用抛错、返回空文件，都落成 `ok:false` + 原因，
 * 由调用方写进 `screenshot_missing` 与 `capabilityGaps`。
 */
export async function captureScreenshot(
  capability: ValuationScreenshotCapability | undefined,
  request: ValuationScreenshotRequest,
  /** 回读用的存在性检查（由调用方给，因为它手上有 ctx；不给就只查形状）。 */
  exists?: (file: string) => Promise<boolean>,
): Promise<ValuationScreenshotResult> {
  if (capability === undefined) return screenshotUnavailable()
  let result: ValuationScreenshotResult
  try {
    result = await capability(request)
  } catch (error) {
    return screenshotUnavailable(`截图能力调用失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (result === null || typeof result !== 'object') {
    return screenshotUnavailable('截图能力返回了非对象结果：无法确认截图是否留存')
  }
  if (!result.ok) return result
  // 后置条件：说成功就必须给文件与指纹，而且文件要真的在案例目录里 ——
  // "声称截了图"与"截图还在"是两件事，后者才谈得上证据（§7.4）。
  if (text(result.file) === '' || text(result.digest) === '') {
    return screenshotUnavailable('截图能力声称成功，却没有给出文件与指纹：不能当作已留存')
  }
  if (exists !== undefined && !(await exists(text(result.file)))) {
    return screenshotUnavailable(`截图能力声称写入了 ${text(result.file)}，但案例目录里找不到它`)
  }
  return result
}

/** 证据文件是否真的在案例目录里（回读后置条件，而不是相信写入返回值）。 */
export async function evidenceExists(ctx: Context, casePath: string, file: string): Promise<boolean> {
  if (text(file) === '' || text(file).includes('..')) return false
  return await isFile(ctx, joinLocalPath(casePath, file))
}

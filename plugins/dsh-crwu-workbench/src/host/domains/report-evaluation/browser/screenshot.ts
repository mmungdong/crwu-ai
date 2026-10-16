import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { text } from '../../../../shared/utils/value.ts'
import { safeIdSegment } from '../project/contracts.ts'
import { canonicalListingUrl } from '../market/candidates.ts'
import { screenshotUnavailable, type ValuationScreenshotCapability, type ValuationScreenshotRequest, type ValuationScreenshotResult } from './capture.ts'
import type { BrowserClient } from './cli-client.ts'

/**
 * **页面截图能力**（设计稿 §11.2，计划 Task 8/9/11）。
 *
 * ## 为什么它必须是一个真实能力，而不是"注入才有的可选件"
 *
 * 方法要求页面截图留证。如果这一项缺省不装配，每个候选案例都会写 `screenshot_missing`，
 * 于是报告只能到 `partial` —— 而那看起来像"业务上不需要截图"。所以宿主**必须**把这条通道接上：
 * CLI 的 `shot` 已经能取全页 PNG，这里只是把它绑到案例证据目录与契约上。
 *
 * ## 三条定死的口径
 *
 * 1. **落点**：`推理结果/图片/<安全 caseId-名称>/<provider>-<slug>.png`，路径由 Host 从
 *    案例目录派生 —— 调用方提交不了输出目录。`safeIdSegment` 会把中文标题折成可用目录名，
 *    但**身份仍是 caseId**（标题只是标签）。
 * 2. **挑战页截图永远不是证据**：CLI 的 `shot` 在页面被判为登录墙/验证码/拦截时**不写 `--out`**，
 *    所以这里拿到的 `ok:false` 会直接变成 `screenshot_missing` —— 结构上不可能把验证页存成案例图。
 * 3. **指纹与字节数来自 CLI 的真实产物**，不由这里编。CLI 没给指纹时按失败处理
 *    （没有指纹的"证据"无法在报告里被核对）。
 */

/** 截图证据的目录（相对案例目录）。与 `screenshot-manifest.schema.json` 的 `relativePath` 口径一致。 */
export const SCREENSHOT_DIR = '推理结果/图片'

/** 图片文件名里的安全片段。 */
function slugOf(value: unknown, fallback: string): string {
  return safeIdSegment(value, fallback)
}

export interface ScreenshotCapabilityDeps {
  client: BrowserClient
  /** 页面等待时间（毫秒）；缺省交给 CLI。 */
  waitMs?: number
  /**
   * `caseId → 人可读名称`（可选）。
   *
   * 取证请求里只有 `caseId`（它是身份），而目录名按设计是 `<caseId-名称>`。
   * 名称由**调用方从案例记录**取（那里才有小区名/标题）—— 不能靠文件名反推，
   * 也不能让模型提交它（那会变成"输出目录由模型决定"）。
   */
  displayNameOf?: (caseId: string) => string
  /**
   * **在截图之前幂等创建输出目录**（经 Broker / 文件服务，不是裸 `node:fs`）。
   *
   * 为什么必须有：`crwu browser shot --out` 是**另一个进程**在用 `os.WriteFile` 落盘，
   * 它不建父目录 —— 首次运行时 `推理结果/图片/<caseId-名称>/` 不存在，结果是 `ENOENT`。
   * 那个报错会被当成"页面没通过校验"，一路走到登录 / 验证码的处置上，与真实原因无关。
   * 缺省不装配时按"没有这一步"处理（本部署由 `runtime.ts` 接上 Broker）。
   */
  ensureDirectory?: (absolutePath: string, request: ValuationScreenshotRequest) => Promise<{ ok: boolean; error: string }>
}

/** 一个 caseId → 证据目录名：`<安全 caseId>-<安全 名称>`。 */
export function screenshotDirectoryName(caseId: unknown, displayName: unknown): string {
  const id = slugOf(caseId, 'case')
  const label = slugOf(displayName, '')
  return label === '' ? id : `${id}-${label}`
}

/**
 * 由浏览器客户端造一个截图能力。
 *
 * 返回值符合既有的 `ValuationScreenshotCapability`：调用方（`market-search.ts`）拿到
 * `ok/file/digest/bytes/capturedAt` 后写进案例记录；失败时它写 `screenshot_missing`。
 */
export function createBrowserScreenshotCapability(deps: ScreenshotCapabilityDeps): ValuationScreenshotCapability {
  return async (request: ValuationScreenshotRequest): Promise<ValuationScreenshotResult> => {
    const casePath = text(request.casePath)
    const url = text(request.url)
    if (casePath === '') return screenshotUnavailable('没有案例目录：截图必须落在本轮案例里。')
    if (url === '') return screenshotUnavailable('没有页面地址：无法截图。')

    const caseId = text(request.caseId)
    const requestLabel = text(request.displayName)
    const displayName = requestLabel !== ''
      ? requestLabel
      : (deps.displayNameOf === undefined ? '' : deps.displayNameOf(caseId))
    const directory = joinLocalPath(casePath, SCREENSHOT_DIR, screenshotDirectoryName(caseId, displayName))
    // Unique per capture: a repeated detail capture must not overwrite the older image.
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const fileName = `${slugOf(request.source, 'source')}-${slugOf(caseId, 'case')}-${stamp}.png`
    const absolute = joinLocalPath(directory, fileName)

    // **先建目录再让 CLI 落盘**：`shot --out` 不建父目录，首次运行时那里还不存在。
    // 建不出来是**文件错误**，不是"页面没通过校验" —— 两者必须分开说。
    if (deps.ensureDirectory !== undefined) {
      const made = await deps.ensureDirectory(directory, request)
      if (!made.ok) {
        return screenshotUnavailable(`截图目录创建失败（文件错误，不是页面校验问题）：${made.error}`)
      }
    }

    const outcome = await deps.client.shot({
      url,
      out: absolute,
      fullPage: true,
      scroll: true,
      ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
    }, request.signal)

    if (!outcome.ok) {
      // 页面被判为登录墙 / 验证码 / 拦截时 CLI **不写 `--out`**：这里如实说"没有截图"，
      // 而不是拿一个页面字节或指纹顶替（那正是"挑战页截图当证据"的入口）。
      return screenshotUnavailable(
        outcome.error || `页面未通过校验（verdict=${outcome.verdict || 'unknown'}）：没有可留存的截图。`,
      )
    }
    if (text(outcome.digest) === '' || outcome.bytes <= 0) {
      return screenshotUnavailable('CLI 报告截图成功但没有给出指纹或字节数：无法在报告里核对这张图。')
    }
    // `shot` is a SECOND navigation: verify its own final URL against the requested identity.
    const finalUrl = text(outcome.finalUrl)
    const requestedCanonical = canonicalListingUrl(url)
    const finalCanonical = canonicalListingUrl(finalUrl)
    if (finalUrl === '' || requestedCanonical === '' || finalCanonical === '' || finalCanonical !== requestedCanonical) {
      return screenshotUnavailable(
        `截图导航到的最终地址与请求的详情页不一致（${finalUrl || '(空)'} ≠ ${url}）：不把这一页当作该案例证据。`,
      )
    }
    const relative = joinLocalPath(SCREENSHOT_DIR, screenshotDirectoryName(caseId, displayName), fileName)
    return {
      ok: true,
      error: '',
      file: relative,
      digest: outcome.digest,
      bytes: outcome.bytes,
      capturedAt: new Date().toISOString(),
      sourceUrl: finalUrl,
      ...(request.evidenceType === undefined ? {} : { evidenceType: request.evidenceType }),
    }
  }
}

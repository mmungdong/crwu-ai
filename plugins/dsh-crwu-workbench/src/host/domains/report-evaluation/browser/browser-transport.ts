import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { text } from '../../../../shared/utils/value.ts'
import type { MarketFailureKind, MarketFetchResult, MarketRecoveryNote, MarketTransport } from './provider.ts'
import type { BrowserClient, RecoveryOutcome } from './cli-client.ts'
import { recoveryVerified, type ChallengeRecoveryCoordinator } from './challenge-recovery.ts'

/**
 * `MarketTransport` 的**浏览器实现**（设计稿 §8.2 / §8.4，计划 Task 8）。
 *
 * ## 它把三件事接在一起
 *
 * 1. **取页面**走 `crwu browser fetch`（Host 拼 argv，模型提交不了 URL/路径/选择器）；
 * 2. **页面判定**由 CLI 给（`verdict` / `failureKind`），这一层不自己判"是不是验证码"；
 * 3. **可见挑战**先自动调用固定的恢复能力（`ChallengeRecoveryCoordinator`），
 *    恢复成功才重新取原 URL —— 脚本自己说成功不算，页面回读才算。
 *
 * ## 三条不许含糊的边界
 *
 * - **`out` 只在判定为可用页面时才被 CLI 写出**。所以这里的 `body` 来自那个文件；
 *   挑战页 / 登录页不写 `--out`，于是它**结构上**不可能成为案例证据。
 * - **恢复是任务级的**：`retrievalTaskId` + `providerId` 绑定在闭包里，调用方换不了。
 *   于是"恢复的是哪一个房源"始终可追溯，也不会把 A 房的恢复预算用掉去救 B 房。
 * - **失败类别要分**：`captcha` 走恢复；`login` 引导登录；`rate-limited` 交给有界重试；
 *   `not-found` / 模板问题不重试。全说成"请登录"会让员工反复登录一个没坏的账号。
 */

export interface BrowserTransportTask {
  /** 取数任务 id（恢复预算与断点都挂在它上面）。 */
  retrievalTaskId: string
  providerId: string
  /** 方案/案例目录（受控路径；由 Host 从 scope 派生）。 */
  caseRoot: string
  /** 证据落点的安全子目录（例如 `来源证据/页面`）。 */
  pageDir: string
}

export interface BrowserTransportDeps {
  client: BrowserClient
  coordinator: ChallengeRecoveryCoordinator
  /** 页面等待时间（毫秒）。 */
  waitMs?: number
  /** 读取页面字节（由调用方注入 fs；传输层不直接碰磁盘）。 */
  readPage: (absolutePath: string) => Promise<string>
  /** 页面字节上限：超过就截断并如实标注（避免把整页 DOM 灌进上下文）。 */
  bodyMaxBytes?: number
}

export type TransportRecoveryNote = MarketRecoveryNote

/** 页面证据的落点：安全 id 派生，不用页面标题拼路径。 */
export function pageEvidencePath(task: BrowserTransportTask, slug: string): { page: string; dump: string } {
  const safe = text(slug).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 64) || 'page'
  const dir = joinLocalPath(task.caseRoot, task.pageDir)
  return {
    page: joinLocalPath(dir, `${task.retrievalTaskId}-${safe}.html`),
    dump: joinLocalPath(dir, `${task.retrievalTaskId}-${safe}.dump.html`),
  }
}

function recoveryNote(outcome: RecoveryOutcome): TransportRecoveryNote {
  return {
    state: outcome.state,
    reasonCode: outcome.reasonCode,
    attempts: outcome.attempts,
    strategyId: outcome.strategyId,
    beforeKind: outcome.beforeKind,
    afterKind: outcome.afterKind,
    challengeVisible: outcome.pageValidation.challengeVisible,
    // 核验事实随摘要一起走：只写 "recovered" 而不写"最终 URL 同站、页面可读"，
    // 事后无法核对这条恢复到底核过什么。
    hostMatches: outcome.pageValidation.hostMatches,
    readable: outcome.pageValidation.readable,
    finalUrl: outcome.pageValidation.finalUrl,
  }
}

/** `failureKind` → 要不要引导登录 / 要不要按可重试处理。 */
export function retryableOf(kind: MarketFailureKind): boolean {
  return kind === 'network' || kind === 'rate-limited' || kind === 'server-error'
}

/** 按任务造一个 `MarketTransport`。 */
export function browserTransportForTask(deps: BrowserTransportDeps, task: BrowserTransportTask): MarketTransport {
  const bodyMax = Math.max(1024, Math.floor(deps.bodyMaxBytes ?? 4 * 1024 * 1024))
  return async (url, options) => {
    const first = await fetchOnce(deps, task, url, options.signal, bodyMax)
    // 判据是 `captcha` 这个**分类结果**，不是某个内部字段名：CLI 的页面判定才是权威。
    if (first.ok || first.captcha !== true) return first
    // 可见挑战：先调用固定的恢复能力。**不默认失败**。
    const recovery = await deps.coordinator.attempt({
      providerId: task.providerId,
      retrievalTaskId: task.retrievalTaskId,
      url,
    }, options.signal)
    // 只有**核验过**的恢复才算恢复：最终 URL 回到该来源、页面可读、不带着可见挑战。
    // 协调器已经这样收窄过一次，这里再核一遍是因为这一层的赌注不同 —— 它决定
    // 哪一页能成为案例证据，而挑战页/挑战画布从来不是证据。
    if (recoveryVerified(recovery)) {
      // 恢复成功只是"页面看起来没有挑战了"；**重新取一次原 URL**，以新的页面为证据。
      const retry = await fetchOnce(deps, task, url, options.signal, bodyMax)
      if (retry.ok || retry.captcha !== true) {
        return {
          ...retry,
          notes: [...(retry.notes ?? []), `可见人机验证已由固定策略恢复（${recovery.strategyId}/${recovery.reasonCode}）`],
          recovery: recoveryNote(recovery),
        }
      }
      // 拿回原页面又被打回挑战：预算共享，交由协调器下一次判定。
      return {
        ...retry,
        notes: [...(retry.notes ?? []), '恢复后再次遇到可见挑战（同一任务共享恢复预算）'],
        recovery: recoveryNote(recovery),
      }
    }
    // 未恢复：保存 waiting-user 断点由调用方持久化；不伪造页面字节。
    return {
      ok: false,
      error: recovery.pageValidation.reason || '自动恢复未通过：请在当前浏览器完成网页验证后继续同一任务',
      status: 0,
      body: '',
      contentType: '',
      url,
      loginRequired: recovery.reasonCode === 'login-required',
      captcha: true,
      failureKind: 'captcha',
      notes: [`自动恢复未通过（${recovery.state}/${recovery.reasonCode}）：已保留断点，请在当前浏览器完成验证后用同一取数任务继续`],
      recovery: recoveryNote(recovery),
    }
  }
}

async function fetchOnce(
  deps: BrowserTransportDeps,
  task: BrowserTransportTask,
  url: string,
  signal: AbortSignal | undefined,
  bodyMax: number,
): Promise<MarketFetchResult> {
  const { page, dump } = pageEvidencePath(task, url.split('/').pop() ?? 'page')
  const outcome = await deps.client.fetch({
    url,
    out: page,
    dump,
    scroll: true,
    ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
  }, signal)
  const base: MarketFetchResult = {
    ok: outcome.ok,
    error: outcome.error,
    status: outcome.status,
    body: '',
    contentType: '',
    url: outcome.finalUrl || url,
    loginRequired: outcome.failureKind === 'login' || outcome.verdict === 'login-wall',
    captcha: outcome.failureKind === 'captcha' || outcome.verdict === 'captcha',
    failureKind: (outcome.failureKind || (outcome.ok ? '' : 'unknown')) as MarketFailureKind,
    notes: [],
  }
  if (!outcome.ok) return base
  // `--out` 只在校验通过时才写；读不到就是"拿不到页面字节"，不是空案例。
  let body = ''
  try {
    body = await deps.readPage(page)
  } catch (error) {
    return {
      ...base, ok: false, failureKind: 'unreadable',
      error: `页面已取回但读不到字节：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const byteLength = new TextEncoder().encode(body).length
  if (byteLength > bodyMax) {
    // Incomplete body must never be parsed or cached as a full page.
    return {
      ...base, ok: false, failureKind: 'unreadable', body: '',
      error: `页面字节 ${String(byteLength)} 超过上限 ${String(bodyMax)}：内容不完整，本轮不当作可用页面`,
    }
  }
  return { ...base, body }
}

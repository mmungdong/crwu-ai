import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../../shared/utils/value.ts'
import type { OperationMap } from '../../operations/types.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { WorkbenchConfig } from '../../config/config.ts'
import type { BrowserClient, SiteStatusView } from '../../domains/report-evaluation/browser/cli-client.ts'
import type { LoginJobs } from '../../domains/report-evaluation/browser/login-jobs.ts'
import { gateSiteIds, type BrowserSite } from '../../domains/report-evaluation/browser/sites.ts'
import type { SiteChallengeView, SiteRowView as SharedSiteRowView } from '../../../shared/contracts/report-evaluation.ts'

/**
 * 房地产二级目录的**局部门禁**（设计稿 §4.2）。
 *
 * ## 门禁只在房地产正文里，不在导航上
 *
 * 三个操作（`valuation-browser-preflight` / `valuation-browser-login` /
 * `valuation-browser-login-cancel`）只服务房地产这一个工作面。它们
 * **不**进全局必需环境清单：登录不上链家不该拦住报告审核、环境信息或本地审核。
 *
 * ## 三条不许含糊的口径
 *
 * 1. **加载即"正在检查"**：进页面就先发一次真实 `status`，不先画一个"未登录"的空态 ——
 *    那个空态会让员工以为要重新登录，而真实情况可能只是还没查。
 * 2. **`authenticated` 才释放，而且只看必需项**。`unknown`（网络 / 风控 / 查不出来）
 *    与 `unauthenticated`（确实没登录）必须分开显示：前者的处置是"重新检查"，
 *    后者才是"去登录"。把它们混成一句"请登录"会让员工反复登录一个没坏的账号。
 * 3. **Cookie 存在不算成功**：登录任务结束后由 `login-jobs` 再跑一次权威 `status`，
 *    这里只读它的结论。
 */

export interface ValuationAuthDeps {
  ctx: Context
  access: LocalAccessBroker
  config: WorkbenchConfig
  client: BrowserClient
  logins: LoginJobs
  sites: readonly BrowserSite[]
  /** 装配期解析出的站点清单路径（诊断用；不含凭据）。 */
  sitesPath: string
  /** 站点清单本身读不出来时的原因（门禁如实显示，而不是假装未登录）。 */
  sitesError?: string
  /**
   * **有界挑战恢复**（与取数共用同一个协调器；`assistLoginChallenge` 关掉时缺省）。
   *
   * 门禁里遇到人机验证时先走它一次——这正是设计 §8.4 的要求：
   * 不能因为受保护页弹了验证就把员工挡在门外，也不能默认失败。
   * 预算与冷却由协调器按 `taskId` 管理，所以重复点「重新检查」不会无限重试。
   */
  recover?: (input: { siteId: string; url: string; taskId: string }) => Promise<{
    state: string
    reasonCode: string
  }>
}

/** 门禁里每个来源的挑战任务 id：同一来源的多次检查共享同一份尝试预算。 */
export function gateRecoveryTaskId(siteId: string): string {
  return `gate:${text(siteId)}`
}

/**
 * 能力（案例来源）状态结论（Host 推出一次，界面只渲染）。
 *
 * 协议 39 起它**不是门禁**：`required` 只表示"这个来源对本轮业务更重要"，
 * 未登录 / 未知 / 该站失败都不阻止填写与启动。`released` 保留为字段兼容，
 * 但**不参与任何禁用判据** —— 真正的来源策略随交接交给父会话。
 */
export interface AuthGateView {
  /** ⚠️ 兼容字段：不再表示"能不能进正文"。 */
  released: boolean
  required: string[]
  optional: string[]
  /** 一句话说明现在这些来源是什么状态。 */
  reason: string
  /** 是否连"检查"都没做成（清单读不出来 / 浏览器不可用）→ 界面给"重新检查"。 */
  unavailable: boolean
  /** 这次检查的**时刻**（RFC3339，Host 自己铸）：一次检查不等于整轮始终可用。 */
  checkedAt: string
}

export interface SiteRowView extends SharedSiteRowView {
  required: boolean
  stateLabel: string
  /**
   * 该来源这一次检查里做过的/需要做的**挑战处置**。
   *
   * `detected` 时说明受保护页给了人机验证（或风控）：这时唯一有意义的动作是
   * "去那个已经打开的窗口完成验证，再重新检查"，而不是让员工重新登录。
   */
  challenge?: SiteChallengeView
}

const STATE_LABELS: Record<string, string> = {
  authenticated: '已登录',
  unauthenticated: '未登录',
  unknown: '无法检查',
}

/**
 * 由逐站状态推出**能力状态**（纯函数，界面与测试共用同一份判据）。
 *
 * 它回答的是"这些来源现在各自是什么状态、有哪些人工动作可做"，**不回答"能不能继续"**。
 * `checkedAt` 由调用方传入（Host 只在真的查过一次之后才填）。
 */
export function gateFromStatuses(
  sites: readonly BrowserSite[],
  statuses: readonly SiteStatusView[],
  plan: { required: string[]; optional: string[] },
  unavailable: boolean,
  checkedAt = '',
): AuthGateView {
  const known = new Set(sites.map((site) => site.id))
  const required = plan.required.filter((id) => known.has(id))
  const optional = plan.optional.filter((id) => known.has(id))

  const stateOf = (siteId: string): string => {
    const row = statuses.find((status) => status.siteId === siteId)
    return row?.state ?? 'unknown'
  }

  const missingLogin = required.filter((id) => stateOf(id) === 'unauthenticated')
  const unknown = required.filter((id) => stateOf(id) === 'unknown')
  const blocked = required.filter((id) => stateOf(id) !== 'authenticated')

  let reason = ''
  if (sites.length === 0) {
    reason = '部署配置里没有可用的案例来源清单：本轮没有可核对的来源，请检查站点清单配置'
  } else if (unavailable) {
    reason = '没能读到案例来源状态（网络 / 浏览器 / 站点清单不可用）：这不阻止开始，'
      + '本轮会按可用的替代来源继续；可以稍后重新检查'
  } else if (missingLogin.length > 0) {
    const labels = missingLogin.map((id) => sites.find((site) => site.id === id)?.label ?? id)
    reason = `${labels.join('、')} 未登录：本轮改用其它来源；需要它时可在下面登录后重新检查`
  } else if (unknown.length > 0) {
    const labels = unknown.map((id) => sites.find((site) => site.id === id)?.label ?? id)
    reason = `${labels.join('、')} 的登录状态查不出来（网络、风控或人机验证）：按真实类别处置后重新检查，不要盲目重登`
  } else if (blocked.length > 0) {
    const labels = blocked.map((id) => sites.find((site) => site.id === id)?.label ?? id)
    reason = `${labels.join('、')} 还没有确认可用`
  }

  return {
    released: unavailable !== true && required.every((id) => stateOf(id) === 'authenticated'),
    required,
    optional,
    reason,
    unavailable,
    checkedAt,
  }
}

/** 逐站展示行（必需/可选 + 人话状态）。 */
export function siteRowsOf(
  sites: readonly BrowserSite[],
  statuses: readonly SiteStatusView[],
  plan: { required: string[]; optional: string[] },
  challenges?: ReadonlyMap<string, SiteChallengeView>,
): SiteRowView[] {
  return sites.map((site) => {
    const row = statuses.find((status) => status.siteId === site.id)
    const state = row?.state ?? 'unknown'
    return {
      siteId: site.id,
      label: row?.label || site.label,
      state,
      reason: row?.reason ?? '',
      verdict: row?.verdict ?? '',
      protectedUrl: row?.protectedUrl || site.protectedUrl,
      expiresAt: row?.expiresAt ?? '',
      sessionCookie: row?.sessionCookie === true,
      ...(challenges?.get(site.id) === undefined ? {} : { challenge: challenges.get(site.id) as SiteChallengeView }),
      required: plan.required.includes(site.id),
      stateLabel: STATE_LABELS[state] ?? '无法检查',
    }
  })
}

export function createValuationAuthOperations(deps: ValuationAuthDeps): OperationMap {
  return {
    // ── ① 门禁：真实 status（必填来源逐个报告） ────────────────────────────
    'valuation-browser-preflight': async () => {
      if (text(deps.sitesError).trim() !== '') {
        // 清单读不出来不是"未登录"：如实说配置不可用，并给"重新检查"这条动作。
        return {
          ok: false, error: text(deps.sitesError), sites: [], rows: [],
          gate: {
            released: false, required: [], optional: [],
            reason: text(deps.sitesError), unavailable: true,
            checkedAt: new Date().toISOString(),
          },
          loginJobs: deps.logins.current(), opened: false, openError: '',
        }
      }
      // 必需/可选由**可信配置**声明；站点清单里没写的 id 在这里被忽略（配置校验另有把关）。
      const plan = gateSiteIds(deps.config, deps.sites)
      const ids = [...plan.required, ...plan.optional]
      let status = await deps.client.status(ids)

      // ── 挑战处置：**先尝试恢复，再让员工动手**（设计稿 §8.4） ──────────────
      //
      // 受保护页要求人机验证时，员工**已经登录**了：把他按回登录页是错的处置。
      // 这里对**必需来源**里判定为 `captcha` 的那些做一次有界自动尝试（≤2 次 / ≤120 秒，
      // 预算挂在 `gate:<siteId>` 上，重复点击共享同一份预算），然后**重新读一次权威状态**——
      // 只有真的过了才放行，绝不因为"尝试过了"就当成通过。
      const challenges = new Map<string, SiteChallengeView>()
      // 挑战信息**与登录状态无关**：凭据有效但页面被挑战时（2026-10-14 口径）门禁照样放行，
      // 但界面要能看到"这个来源当前要求验证"，好让员工与后续取数流程有准备。
      for (const row of status.sites) {
        if (row.verdict !== 'captcha' && row.verdict !== 'blocked') continue
        const site = deps.sites.find((item) => item.id === row.siteId)
        if (site === undefined) continue
        challenges.set(row.siteId, {
          detected: true, attempted: false, state: '', reasonCode: '', verifyUrl: site.protectedUrl,
        })
      }
      // 只有**还没能用凭据证明已登录**的来源才值得自动尝试恢复：已登录时验证由取数流程处理，
      // 门禁再导航一次只会白白增加风控压力。
      const challenged = plan.required.filter((id) => {
        const row = status.sites.find((item) => item.siteId === id)
        return row !== undefined && row.verdict === 'captcha' && row.state !== 'authenticated'
      })
      if (challenged.length > 0 && deps.recover !== undefined) {
        for (const siteId of challenged) {
          const site = deps.sites.find((item) => item.id === siteId)
          if (site === undefined) continue
          let state = ''
          let reasonCode = ''
          try {
            const outcome = await deps.recover({
              siteId, url: site.protectedUrl, taskId: gateRecoveryTaskId(siteId),
            })
            state = outcome.state
            reasonCode = outcome.reasonCode
          } catch (error) {
            // 恢复本身抛错 = 这次尝试没做成（不是"没登录"）：如实记，继续走人工验证。
            state = 'failed'
            reasonCode = error instanceof Error ? error.message : String(error)
          }
          challenges.set(siteId, {
            detected: true,
            attempted: true,
            state,
            reasonCode,
            verifyUrl: site.protectedUrl,
          })
        }
        if (challenges.size > 0) status = await deps.client.status(ids)
      }

      // 检查时刻由 Host 铸（面板只渲染）：一次成功检查不等于整轮始终可用。
      const gate = gateFromStatuses(deps.sites, status.sites, plan, status.unavailable, new Date().toISOString())
      return {
        ok: true,
        error: status.error,
        sites: status.sites,
        rows: siteRowsOf(deps.sites, status.sites, plan, challenges),
        gate,
        loginJobs: deps.logins.current(),
        opened: false,
        openError: '',
      }
    },

    // ── ② 登录：立刻拉起可见浏览器，不先探测任何来源 ────────────────────────
    'valuation-browser-login': async (args) => {
      const siteId = text(args.siteId).trim()
      if (siteId === '') return { ok: false, error: '缺少来源 id', jobId: '', reused: false }
      if (!deps.sites.some((site) => site.id === siteId)) {
        return { ok: false, error: `未知来源：${siteId}`, jobId: '', reused: false }
      }
      const started = await deps.logins.start(siteId)
      return {
        ok: started.ok,
        error: started.error,
        jobId: started.job.jobId,
        reused: started.reused,
        job: started.job,
      }
    },

    // ── ③ 取消登录：只取消本页发起的那一条 ──────────────────────────────────
    'valuation-browser-login-cancel': async (args) => {
      const jobId = text(args.jobId).trim()
      if (jobId === '') return { ok: false, error: '缺少登录任务 id' }
      const outcome = deps.logins.cancel(jobId)
      return { ok: outcome.ok, error: outcome.error }
    },

    // ── ④ 打开验证窗口：员工已登录、受保护页要人机验证时唯一的出路 ──────────
    //
    // 为什么必须是一条**受控 Host 操作**而不是 `window.open(verifyUrl)`：验证只在
    // CLI 自己的持久 profile 里有效，随便开一个系统浏览器窗口既没有那份 Cookie、也没有
    // 任何边界。所以这里只接受 `siteId`：站点与 URL 都从**可信站点清单**取，调用方
    // 提交不了任意地址、也提交不了 profile 路径。`opened: true` **不**表示验证已完成 ——
    // 完成与否只由下一次 preflight 的逐站结论回答。
    'valuation-browser-open-verification': async (args) => {
      const siteId = text(args.siteId).trim()
      if (siteId === '') return { ok: false, error: '缺少来源 id', opened: false, siteId: '' }
      if (!deps.sites.some((site) => site.id === siteId)) {
        // 未知 id 与"清单读不出来"分开说：前者是调用方给错了，后者才是环境问题。
        return { ok: false, error: `未知来源：${siteId}`, opened: false, siteId }
      }
      try {
        const opened = await deps.client.openVerification(siteId)
        return { ok: opened.ok, error: opened.error, opened: opened.opened, siteId }
      } catch (error) {
        // 原始 message 可能带命令与路径：只回一句人话。
        void error
        return { ok: false, error: '打开验证窗口失败：请稍后重试，或先重新检查来源状态', opened: false, siteId }
      }
    },
  }
}

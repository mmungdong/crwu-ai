import { text } from '../../../../shared/utils/value.ts'
import type { BrowserClient, RecoveryOutcome, SiteStatusView } from './cli-client.ts'

/**
 * 房地产门禁的**登录任务**（设计稿 §4.2）。
 *
 * ## 为什么登录要是一个"任务"而不是一次 RPC
 *
 * 员工登录是**分钟级**的人工动作：CLI 打开一个可见窗口并等下去。把它做成同步 RPC 会让
 * 面板请求挂几分钟，而且取消/切换二级目录都无从下手。所以：
 *
 * 1. **点击立刻拉起可见浏览器**，不等任何探测 —— "先串行探测三家再打开"就是"点了没反应"；
 * 2. 页面**有界查询**当前任务状态（`get` / `current`），没有轮询定时器、不追踪估值完成度；
 * 3. 同一 profile 只允许**一个**登录任务：再点一次复用同一条，而不是开第二个窗口；
 * 4. **Cookie 存在 ≠ 登录成功**：登录命令结束后必须再跑一次**权威** `status`，
 *    只有它说 `authenticated` 才释放门禁。出现挑战时可以先调用适配的恢复能力辅助，
 *    但挑战消失**不**等于员工身份已通过。
 *
 * Job 随插件实例清理（`dispose`）：卸载时中止自己的任务，不去动别人的浏览器。
 */

/**
 * 登录任务的终态。
 *
 * `waiting-user` 是**登录成功但页面读不回来**时的状态：凭据已经到位（passport 认可了员工），
 * 而受保护页回的是站点的**人机验证 / 风控**。把它报成 `failed` 就是在说"你没登录成功" ——
 * 那是错的判断，员工已经在浏览器里看着自己登录成功了。
 */
export type LoginJobState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting-user'

export interface LoginJobView {
  jobId: string
  siteId: string
  state: LoginJobState
  startedAt: number
  finishedAt: number | null
  /** 给人看的一句话（失败原因 / 已确认状态）。 */
  detail: string
  /** 权威 `status` 的逐站结果；登录结束前为空数组。 */
  sites: SiteStatusView[]
  /** 登录命令自身的退出事实。**不代表**登录成功。 */
  commandOk: boolean
  /** 本次任务里跑过几次挑战恢复辅助。 */
  recoveryAttempts: number
}

export interface LoginJobsDeps {
  client: BrowserClient
  /** 站点登录页（挑战辅助要回到它）。拿不到就跳过辅助，不做别的猜测。 */
  loginUrlOf: (siteId: string) => string
  /** 挑战恢复辅助（缺省不装配：那时只等员工在窗口里自己完成）。 */
  assist?: (input: { siteId: string; url: string; retrievalTaskId: string }) => Promise<RecoveryOutcome>
  now?: () => number
  newId?: () => string
}

export interface LoginJobs {
  start(siteId: string): Promise<{ ok: boolean; error: string; job: LoginJobView; reused: boolean }>
  get(jobId: string): LoginJobView | undefined
  current(): LoginJobView[]
  cancel(jobId: string): { ok: boolean; error: string }
  dispose(): void
}

/** 每个登录任务最多做几次挑战恢复辅助。 */
const MAX_LOGIN_RECOVERY_ASSISTS = 1

export function createLoginJobs(deps: LoginJobsDeps): LoginJobs {
  const now = deps.now ?? (() => Date.now())
  let sequence = 0
  const newId = deps.newId ?? (() => {
    sequence += 1
    return `login-${String(now())}-${String(sequence)}`
  })

  const jobs = new Map<string, LoginJobView>()
  const controllers = new Map<string, AbortController>()

  const runningJob = (): LoginJobView | undefined => {
    for (const job of jobs.values()) {
      if (job.state === 'running') return job
    }
    return undefined
  }

  const settle = (jobId: string, patch: Partial<LoginJobView>): void => {
    const job = jobs.get(jobId)
    if (job === undefined) return
    jobs.set(jobId, { ...job, ...patch })
    controllers.delete(jobId)
  }

  const launch = async (jobId: string, siteId: string, controller: AbortController): Promise<void> => {
    const signal = controller.signal
    const loginUrl = deps.loginUrlOf(siteId)
    let commandOk = false
    let detail = ''
    let recoveryAttempts = 0

    try {
      let outcome = await deps.client.login(siteId, signal)
      commandOk = outcome.ok
      if (outcome.aborted || signal.aborted) {
        settle(jobId, { state: 'cancelled', finishedAt: now(), detail: '登录被取消', commandOk, recoveryAttempts })
        return
      }
      detail = outcome.error

      // 登录页上真的出现可见挑战时，先调用适配的固定策略辅助一次。恢复能力自己判定
      // "有没有可见挑战"：普通登录表单不会被拖滑块（`recover` 的探针会说没有挑战）。
      if (!outcome.ok && deps.assist !== undefined && loginUrl !== '' && recoveryAttempts < MAX_LOGIN_RECOVERY_ASSISTS) {
        try {
          const recovery = await deps.assist({ siteId, url: loginUrl, retrievalTaskId: `login:${jobId}` })
          recoveryAttempts += 1
          if (recovery.state === 'recovered') {
            outcome = await deps.client.login(siteId, signal)
            commandOk = outcome.ok
            detail = outcome.error
          }
        } catch (error) {
          // 辅助失败不改判：后面那次权威 status 才是结论。
          detail = `${detail}；挑战恢复辅助未完成：${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (signal.aborted) {
        settle(jobId, { state: 'cancelled', finishedAt: now(), detail: '登录被取消', commandOk, recoveryAttempts })
        return
      }

      // **权威判定**：Cookie 存在不能直接宣告成功，必须由 status 说 authenticated。
      // 这条链路上"登录窗口本来就开着"，所以读受保护页是**免费**的，而它带来的页面判定
      // 正是区分「登录失败」与「已登录但页面要人机验证」的唯一依据（waiting-user）。
      // 门禁预检走的是只读凭据的 `status`，不会为了这次检查多开一个窗口。
      // 存量替身 / 旧宿主适配器只有 `status`（只读凭据），这里退回它——
      // 那条路径拿不到页面判定，于是只会得出"登录成功"或"未通过"，不会再落到 waiting-user。
      const readStatus = deps.client.statusVerified ?? deps.client.status
      const status = await readStatus([siteId], signal)
      if (signal.aborted) {
        settle(jobId, { state: 'cancelled', finishedAt: now(), detail: '登录被取消', commandOk, recoveryAttempts })
        return
      }
      const sites = status.sites
      const row = sites.find((site) => site.siteId === siteId)
      const authenticated = sites.some((site) => site.siteId === siteId && site.state === 'authenticated')
      if (authenticated) {
        settle(jobId, {
          state: 'succeeded', finishedAt: now(), sites, commandOk, recoveryAttempts,
          // 凭据有效但页面被挑战：登录是成功的，验证交给取数流程（它会自动尝试恢复）。
          detail: row?.verdict === 'captcha' || row?.verdict === 'blocked'
            ? '已确认登录状态；该来源当前要求人机验证，取数时会自动尝试恢复'
            : '已确认登录状态',
        })
        return
      }
      const reason = status.unavailable
        ? status.error
        : (row?.reason || status.error || '登录状态未通过权威检查')

      // **登录成功 ≠ 页面读得回来**。受保护页回人机验证 / 风控时，员工其实已经登录
      //（passport 的会话 cookie 就在那儿，`commandOk` 也说了登录命令成功）；这时把它报成
      // `failed` 就是错误判断 —— 员工看着浏览器里的"已登录"，面板却说登录失败。
      // 诚实的结论是 `waiting-user`：凭据已到位，等员工在可见窗口里过掉那次验证。
      const challenged = row !== undefined && (row.verdict === 'captcha' || row.verdict === 'blocked')
      if (challenged && commandOk) {
        settle(jobId, {
          state: 'waiting-user', finishedAt: now(), sites, commandOk, recoveryAttempts,
          detail: row.state === 'authenticated'
            ? '已确认登录状态'
            : (reason === '' ? '登录凭据已到位，但受保护页要求完成网页验证' : reason),
        })
        return
      }

      settle(jobId, {
        state: 'failed', finishedAt: now(), sites, commandOk, recoveryAttempts,
        detail: reason === '' ? '登录后仍不是已登录状态' : reason,
      })
    } catch (error) {
      if (signal.aborted) {
        settle(jobId, { state: 'cancelled', finishedAt: now(), detail: '登录被取消', commandOk, recoveryAttempts })
        return
      }
      settle(jobId, {
        state: 'failed', finishedAt: now(), commandOk, recoveryAttempts,
        detail: `登录任务失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    async start(siteId: string) {
      const id = text(siteId).trim()
      if (id === '') return { ok: false, error: '缺少来源 id', job: emptyJob('', ''), reused: false }
      const existing = runningJob()
      if (existing !== undefined) {
        // 同一个 profile 上只允许一个登录任务：再点一次是复用，不是开第二个窗口。
        return { ok: true, error: '', job: existing, reused: true }
      }
      const jobId = newId()
      const job: LoginJobView = {
        jobId, siteId: id, state: 'running', startedAt: now(), finishedAt: null,
        detail: '正在等待登录', sites: [], commandOk: false, recoveryAttempts: 0,
      }
      jobs.set(jobId, job)
      const controller = new AbortController()
      controllers.set(jobId, controller)
      // 立刻拉起可见浏览器：不先串行探测任何来源。
      void launch(jobId, id, controller)
      return { ok: true, error: '', job, reused: false }
    },

    get(jobId: string) {
      return jobs.get(text(jobId))
    },

    current() {
      return [...jobs.values()].slice(-8)
    },

    cancel(jobId: string) {
      const id = text(jobId)
      const job = jobs.get(id)
      if (job === undefined) return { ok: false, error: '没有这个登录任务' }
      if (job.state !== 'running') return { ok: false, error: '这个登录任务已经结束' }
      const controller = controllers.get(id)
      if (controller === undefined) return { ok: false, error: '这个登录任务没有可取消的句柄' }
      // 只取消本页发起的那一条；`runCrwu` 会把它转成 CLI 进程的取消信号。
      controller.abort()
      return { ok: true, error: '' }
    },

    dispose() {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      jobs.clear()
    },
  }
}

function emptyJob(jobId: string, siteId: string): LoginJobView {
  return {
    jobId, siteId, state: 'failed', startedAt: 0, finishedAt: null,
    detail: '未创建登录任务', sites: [], commandOk: false, recoveryAttempts: 0,
  }
}

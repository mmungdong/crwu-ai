import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchConfig } from '../../../config/config.ts'
import type { LocalAccessBroker } from '../../../core/access/broker.ts'
import type { WorldFacts } from '../../../core/platform/world.ts'
import type { OperationMap } from '../../../operations/types.ts'
import type { ValuationScreenshotCapability } from './capture.ts'
import { runCrwu } from '../../../integrations/crwu/run.ts'
import { ensureDirectory } from '../../../tools/common/case-files.ts'
import { createValuationAuthOperations } from '../../../operations/report-evaluation/auth.ts'
import {
  createBrowserClient,
  type BrowserClient,
  type CliOutput,
  type CrwuRunner,
} from './cli-client.ts'
import { createChallengeRecoveryCoordinator, type ChallengeRecoveryCoordinator } from './challenge-recovery.ts'
import { createLoginJobs, type LoginJobs } from './login-jobs.ts'
import { createProfileQueue } from './profile-queue.ts'
import { createBrowserScreenshotCapability } from './screenshot.ts'
import { gateSiteIds, loadBrowserSites, type BrowserSite } from './sites.ts'

/**
 * 房地产浏览器能力的**装配点**（设计稿 §8.2 / §8.3，计划 Task 3）。
 *
 * 一处装配、一处收尾：`apply()` 只拿这个对象，不再自己拼 profile 队列、登录任务与冷却状态。
 * 这么做的直接理由是**同一个 profile 只有一把锁** —— 队列必须与 client 一起造出来，
 * 分成两处装配就会出现"面板一条队列、估值 Tool 另一条"，于是两个 Agent 同时导航同一个标签页，
 * 而两张截图各自看起来都正常。
 *
 * ## 两个 client、一条队列、两种来源
 *
 * 面板（门禁 / 登录）与估值子会话（取数）走的是**同一条串行队列**，但**来源不同**：
 * 权限表按来源判"这件事该不该由它做"，而"驱动浏览器取数"两者都可以、"弹一个登录窗口"只有面板可以
 * （`system.browser.login` 的 `allowedSources` 就是 `['panel']`）。所以这里造两个 client 共享队列，
 * 而不是让调用方自己传一个 source —— 传得进来就传得错。
 *
 * ## 站点清单读不出来不是"未登录"
 *
 * `loadBrowserSites` 的结构化失败原样带到门禁上：界面显示"配置不可用 + 重新检查"，
 * 而不是画一个假的"未登录"让员工反复去登录一个没坏的账号。
 */
export interface ValuationBrowserRuntime {
  /** `valuation-browser-preflight` / `login` / `login-cancel` 三个门禁操作。 */
  operations: OperationMap
  sites: BrowserSite[]
  sitesPath: string
  /** 非空表示站点清单没读成；门禁据此给"不可用"而不是"未登录"。 */
  sitesError: string
  /** 面板来源的 client（门禁 / 登录 / 挑战辅助）。 */
  panelClient: BrowserClient
  /** 估值子会话来源的 client（取数 / 截图 / 恢复）。与面板共享同一条 profile 队列。 */
  toolClient: BrowserClient
  queue: ReturnType<typeof createProfileQueue>
  logins: LoginJobs
  coordinator: ChallengeRecoveryCoordinator
  /**
   * **页面截图能力**（v2 证据落点 `推理结果/图片/<caseId-名称>/`）。
   *
   * 由取数那条 client（`toolClient`）驱动：截图与取数必须落在**同一个 profile 队列**上，
   * 否则会出现"A 的截图拍到了 B 的页面"。
   */
  screenshot: ValuationScreenshotCapability
  /** 必需 / 可选来源（由可信配置声明，站点清单里没有的 id 已被忽略）。 */
  gatePlan: { required: string[]; optional: string[] }
  dispose: () => void
}

export interface ValuationBrowserRuntimeDeps {
  ctx: Context
  config: WorkbenchConfig
  access: LocalAccessBroker
  world: WorldFacts
}

export function createValuationBrowserRuntime(deps: ValuationBrowserRuntimeDeps): ValuationBrowserRuntime {
  const loaded = loadBrowserSites(deps.config)
  const sites = loaded.sites
  const sitesError = loaded.ok ? '' : loaded.error
  const queue = createProfileQueue()
  const profileKey = 'crwu:browser:default'

  const runnerFor = (source: 'panel' | 'audit-tool'): CrwuRunner => {
    return async (argv, options): Promise<CliOutput> => {
      // workdir 只作为命令的工作目录（不决定任何安全边界）；边界由操作身份 + 沙箱模式决定。
      const workdir = await deps.world.workdir()
      const platform = await deps.world.platform()
      return await runCrwu(deps.ctx, argv, {
        access: deps.access,
        source,
        workdir,
        platform,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    }
  }

  const clientDeps = {
    sitesPath: loaded.path,
    queue,
    workdir: '',
    profileKey,
  }

  const panelClient = createBrowserClient({ ...clientDeps, run: runnerFor('panel'), source: 'panel' })
  const toolClient = createBrowserClient({ ...clientDeps, run: runnerFor('audit-tool'), source: 'audit-tool' })

  const coordinator = createChallengeRecoveryCoordinator({ client: toolClient })

  const assistEnabled = deps.config.valuation?.browser?.assistLoginChallenge !== false
  const loginUrlOf = (siteId: string): string => sites.find((site) => site.id === siteId)?.loginUrl ?? ''
  const logins = createLoginJobs({
    client: panelClient,
    loginUrlOf,
    // 挑战辅助走上取数那条 client：登录窗口不新建恢复入口，也不因此获得登录权限。
    ...(assistEnabled
      ? {
        assist: async (input: { siteId: string; url: string; retrievalTaskId: string }) =>
          await coordinator.attempt({
            providerId: input.siteId,
            retrievalTaskId: input.retrievalTaskId,
            url: input.url,
          }),
      }
      : {}),
  })

  const operations = createValuationAuthOperations({
    ctx: deps.ctx,
    access: deps.access,
    config: deps.config,
    client: panelClient,
    logins,
    sites,
    sitesPath: loaded.path,
    sitesError,
    // 门禁遇到挑战先走**同一个**协调器（与取数共享预算与冷却）：登录窗口不新建恢复入口，
    // 门禁也不会因此获得任何新的权限——它只能恢复站点清单里登记过的那个受保护页。
    ...(assistEnabled
      ? {
        recover: async (input: { siteId: string; url: string; taskId: string }) => {
          const outcome = await coordinator.attempt({
            providerId: input.siteId,
            retrievalTaskId: input.taskId,
            url: input.url,
          })
          return { state: outcome.state, reasonCode: outcome.reasonCode }
        },
      }
      : {}),
  })

  return {
    operations,
    screenshot: createBrowserScreenshotCapability({
      client: toolClient,
      // 截图输出目录在**写之前**幂等创建（`shot --out` 自己不建父目录，首次运行会 ENOENT）。
      // 经 Broker 走 `system.case-file.write`：与案例目录之内的其它文件操作同一条口径。
      ensureDirectory: async (absolutePath, request) => {
        const made = await ensureDirectory(deps.access, absolutePath, {
          workdir: await deps.world.workdir(),
          platform: await deps.world.platform(),
          ...(request.session === undefined ? {} : { session: request.session }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        return { ok: made.ok, error: made.error }
      },
    }),
    sites,
    sitesPath: loaded.path,
    sitesError,
    panelClient,
    toolClient,
    queue,
    logins,
    coordinator,
    gatePlan: gateSiteIds(deps.config, sites),
    dispose: () => {
      // 卸载顺序：先中止自己的登录任务与恢复状态，再丢掉还没开始的排队项。
      // 正在执行的操作属于调用者自己的 signal，不由这里杀。
      logins.dispose()
      coordinator.dispose()
      queue.dropQueued(profileKey)
    },
  }
}

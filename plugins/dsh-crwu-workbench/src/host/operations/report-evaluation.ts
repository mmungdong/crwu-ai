import type { Context } from '@deepseek-ai/cordis'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import type { OperationMap } from './types.ts'
import type { LocalAccessBroker } from '../core/access/broker.ts'
import type { WorkbenchState } from '../core/state/types.ts'
import type { WorldFacts } from '../core/platform/world.ts'
import { writePanelCaseFile } from '../tools/common/case-files.ts'
import { workspaceSessionService } from '../core/workspace-session/index.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import { browserSourceFacts, loadBrowserSites, type ValuationSourceFact } from '../domains/report-evaluation/browser/sites.ts'
import type { ValuationLifecycles } from '../domains/report-evaluation/lifecycle/index.ts'
import type { ValuationScopes } from '../domains/report-evaluation/scope.ts'
import { PreviewRegistry } from '../domains/report-evaluation/intake/preview.ts'
import { HANDOFF_RECORD_FILE, HandoffStore } from '../domains/report-evaluation/execution/handoff-store.ts'
import { createIntakeOperations } from './report-evaluation/intake.ts'
import { createHandoffOperations } from './report-evaluation/handoff.ts'
import { createResumeOperations } from './report-evaluation/resume.ts'

/**
 * 报告评估（房地产估值）的**操作表装配**。
 *
 * ## 这个文件只做两件事
 *
 * 1. 构造跨 handler 共享的**一份**实例：预览注册表与交接状态机
 *    （两处各造一个的后果是"预览说在、交接说没有"）；
 * 2. 把三个 handler 模块挂到 `OperationMap` 上：
 *    - `report-evaluation/intake.ts` —— 本机扫描与归档预览（**不提取、不联网、不拉知识**）；
 *    - `report-evaluation/handoff.ts` —— 幂等父会话交接；
 *    - `report-evaluation/resume.ts` —— 项目归属的显式恢复（P18；与上面两块共用注册表实例）。
 *
 * 门禁那三条（preflight / login / login-cancel）由**浏览器 runtime** 装配
 *（`domains/report-evaluation/browser/runtime.ts`）：它们与 profile 队列、登录任务同生共死，
 * 分成两处装配会让"面板一条队列、工具另一条"。
 *
 * ## 协议 35 删掉了什么
 *
 * v1 的面板完成度操作（`valuation-status` / `valuation-result` / `valuation-open-artifact` /
 * 运行期 `valuation-cancel`）连同 `report-evaluation/monitor.ts` 一起下线：页面在交接成功后
 * 直接跳进顶层父会话，不再有"页面轮询宿主完成度"这条链路。
 *
 * ## 交接记录为什么在这里构造
 *
 * `HandoffStore` 需要"把整份记录写进项目目录"的能力，而那需要 Broker（面板来源提权）与
 * 已选工作区 —— 两样都只有装配层有。状态机本身（互斥、状态转移）在
 * `domains/report-evaluation/execution/handoff-store.ts`，可以直接单测。
 */

/**
 * 交接用的来源事实：站点清单读不到时返回一条"不可用"，**不返回空数组**。
 *
 * 为什么不是空数组：父会话看到空数组只能理解为"本轮没有任何来源"，于是"来源不足"的结论
 * 就无从区分是配置坏了还是真的没有站点。
 */
function sourceFactsOf(config: WorkbenchConfig | undefined): ValuationSourceFact[] {
  if (config === undefined) return []
  return browserSourceFacts(config, loadBrowserSites(config))
}

export interface ValuationOpsDeps {
  ctx: Context
  state: WorkbenchState
  access: LocalAccessBroker
  world: WorldFacts
  /** 轮次状态机（进程内，随插件生命周期）。 */
  lifecycles: ValuationLifecycles
  /** 估值案例 scope（父会话与方案子会话的案例归属）。 */
  scopes: ValuationScopes
  /**
   * 部署配置。**只有来源策略**用它（站点清单路径 + 必需/可选分档）。
   *
   * 缺省时来源事实为空数组：那是"装配没给配置"，不是"没有来源" —— 真实装配
   * （`apply.ts`）一定会传它，缺省只为让既有单测不必逐个补参数。
   */
  config?: WorkbenchConfig
}

export function createValuationOperations(deps: ValuationOpsDeps): OperationMap {
  const { ctx, state, access, world } = deps

  /** 面板每一次确认抽屉共用一份预览注册表（交接按 `previewId` 读它）。 */
  const previews = new PreviewRegistry()

  /**
   * 交接状态机。`persist` 把整份记录写进**项目目录**（`<已选工作空间>/<projectId>/交接记录.json`）：
   * 路径由 Host 从工作空间与铸号推出，页面与模型都提交不了。
   */
  const store = new HandoffStore({
    now: () => new Date(),
    persist: async ({ projectId, content }) => {
      const selected = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
      if (!selected.ok) return { ok: false, error: selected.error }
      const written = await writePanelCaseFile(access, {
        ctx,
        path: joinLocalPath(joinLocalPath(selected.workspace.path, projectId), HANDOFF_RECORD_FILE),
        content,
        workspaceRoot: selected.workspace.path,
      })
      return { ok: written.ok, error: written.error }
    },
  })

  return {
    ...createIntakeOperations({ ctx, state, access, world, previews }),
    ...createHandoffOperations({
      ctx, state, access, world, previews, store,
      lifecycles: deps.lifecycles, scopes: deps.scopes,
      // 来源策略在**交接那一刻**就交给父会话：登录是可选用能力，父会话必须先知道
      // 配置里有哪些来源、各自是必需还是可选，才能按知识库的降级策略往下走。
      sources: sourceFactsOf(deps.config),
    }),
    // P18：登记表的**显式恢复**（`valuation-project-resume`）。它与上面两块共用同一份
    // `lifecycles` / `scopes` 实例 —— 恢复写进去的绑定，Tool 闭包必须立刻看得到。
    ...createResumeOperations({
      ctx, state, lifecycles: deps.lifecycles, scopes: deps.scopes,
    }),
  }
}

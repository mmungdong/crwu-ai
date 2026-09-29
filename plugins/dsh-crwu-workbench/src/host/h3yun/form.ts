import type { Context } from '@deepseek-ai/cordis'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkbenchState } from '../state/types.ts'
import { discoverForm } from './discover.ts'

/**
 * 氚云表单 code 的**插件实例级解析器**。
 *
 * 为什么需要一个实例（而不是各处直接调 `discoverForm`）：
 * 1. **只发现一次**：`crwu h3yun forms search` 实测要跑十几到六十秒。列表、审核启动、
 *    业务 Tool 都会问「表单 code 是什么」，各查一次就是三倍等待；
 * 2. **并发共享同一个 in-flight Promise**：同一个 tick 里列表与审核启动同时发起时，
 *    必须共用一次探测，而不是并行搜两遍（用户口径：不要在同一个事实上重复取数）；
 * 3. **`schemaCode` 属于 Host 基础设施状态**，不是模型该推断的业务参数 —— 所以它只能
 *    从这里（Host）流向 Tool，绝不能出现在模型的工具参数里。
 *
 * 失败**不缓存**：失败可能只是那一次 CLI 没跑起来（沙箱、审批、网络），下一次显式调用
 * 允许重试 —— 缓存失败会把一次瞬时故障变成永久的「无法定位表单」。
 */

export interface FormResolveResult {
  ok: boolean
  code: string
  name: string
  error: string
  escalated: boolean
}

export interface FormResolverDeps {
  ctx: Context
  config: WorkbenchConfig
  state: WorkbenchState
  /** 当前是否已授权读本机凭据（授权可以在启动后才给，所以用 thunk 现读）。 */
  /** Broker（协议 18）：表单定位属于 `h3yun.forms.read`，提权由操作身份决定。 */
  access: LocalAccessBroker
  /** 执行世界平台；探测是异步且只做一次，所以也走 thunk。 */
  platform: () => Promise<string>
  /** 提权执行必须绑定的工作目录。 */
  workdir: () => Promise<string>
}

export class H3yunFormResolver {
  private inflight: Promise<FormResolveResult> | null = null
  private readonly deps: FormResolverDeps

  // 显式字段赋值，**不用 TS 参数属性**：本仓的源码要能被 Node 直接 strip-types 执行
  // （`node --test` 不构建），参数属性属于需要代码生成的语法。
  constructor(deps: FormResolverDeps) {
    this.deps = deps
  }

  /**
   * 拿到表单 code：已缓存直接复用；为空时**只发起一次**发现，并让并发调用共享它。
   */
  async ensure(): Promise<FormResolveResult> {
    const { state } = this.deps
    if (state.formCode !== '') {
      return { ok: true, code: state.formCode, name: state.formName, error: '', escalated: false }
    }
    if (this.inflight !== null) return await this.inflight
    const pending = this.discover()
    this.inflight = pending
    try {
      return await pending
    } finally {
      // 无论成功失败都放开 in-flight：成功时 `state.formCode` 已经填上（后续走缓存分支），
      // 失败时允许下一次调用重试。
      this.inflight = null
    }
  }

  private async discover(): Promise<FormResolveResult> {
    const workdir = await this.deps.workdir()
    const found = await discoverForm(this.deps.ctx, this.deps.config.formName, {
      access: this.deps.access,
      platform: await this.deps.platform(),
      ...(workdir === '' ? {} : { workdir }),
    })
    if (!found.ok) {
      return { ok: false, code: '', name: '', error: found.error, escalated: found.escalated }
    }
    // 缓存进插件状态：它是「报告审核」这一个表单的 code，跨请求复用；界面也用它显示表单名。
    this.deps.state.formCode = found.code
    this.deps.state.formName = found.name
    return { ok: true, code: found.code, name: found.name, error: '', escalated: found.escalated }
  }
}

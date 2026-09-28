import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bootstrapTools } from './bootstrap.ts'
import { capabilitiesTool } from './capabilities.ts'
import { dingtalkTools } from './dingtalk.ts'
import { h3yunTools } from './h3yun.ts'
import { ifindTool } from './ifind.ts'
import { knowledgeTools } from './knowledge.ts'
import { ossTools } from './oss.ts'
import { REQUIRED_AUDIT_TOOLS } from './consts.ts'
import type { ToolDeps } from './types.ts'

/**
 * CRWU Tool 的注册与注销。
 *
 * **只走 DSH 自己的注册表**（`ctx.tools.register` / `defineTool`），不自造私有 registry：
 * 只有注册进 `ctx.tools`，schema 才会自动进入 Agent 的 system prompt，也才会走
 * `tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` 这条
 * policy pipeline（审批、超时、取消都在那里）。
 *
 * 注册在 `apply()` 生命周期内完成，返回的 disposer 交回 `ctx.effect()`：
 * 插件卸载 / 热重载时**逐个注销**，不留半截注册表（否则重载后同名工具会撞车）。
 */
export function registerCrwuTools(ctx: Context, deps: ToolDeps): () => void {
  const registry = ctx.get('tools') as ToolRuntime | undefined
  if (registry === undefined) {
    // `tools` 是硬依赖（PLUGIN_INJECT），不该走到这里；真走到就明确说出来，
    // 绝不让审核链在没有结构化工具的情况下继续。
    throw new Error('Host tools 服务不可用：CRWU 审核链路要求 @deepseek-ai/dsh-tools 已装配')
  }

  const definitions: ToolDefinition[] = [
    capabilitiesTool(deps),
    ...bootstrapTools(deps),
    ...h3yunTools(deps),
    ...knowledgeTools(deps),
    ifindTool(deps),
    ...ossTools(deps),
    ...dingtalkTools(deps),
  ]

  const disposers = definitions.map((definition) => registry.register(definition))
  return () => {
    // 逆序注销：后注册的先摘掉，避免中途失败留下「一半注册」的假象。
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        // 注销失败不能阻断插件卸载（Cordis 生命周期里抛错会让整棵子树卡住）；
        // 但要留一条可查的记录，因为它是「重载后工具仍在」的唯一线索。
        ctx.logger?.warn?.('CRWU 工具注销失败：%o', error)
      }
    }
  }
}

/** 注册的工具名（测试与错误信息共用一处）。 */
export function crwuToolNames(): string[] {
  return [...REQUIRED_AUDIT_TOOLS]
}

/**
 * 审核 Agent 真正可见的必需工具。
 *
 * 判据是 registry 的 scope resolver（`ctx.tools.get(name, agent)`）而不是「插件注册过没有」：
 * provider 可能给子代理收窄工具集，只看注册表会漏掉那一类失败。返回缺失名单，空数组 = 齐备。
 */
export function missingAuditTools(ctx: Context, agent: Agent | undefined): string[] {
  const registry = ctx.get('tools') as { get?: (name: string, scope?: unknown) => unknown } | undefined
  const get = registry?.get
  if (typeof get !== 'function') return [...REQUIRED_AUDIT_TOOLS]
  return REQUIRED_AUDIT_TOOLS.filter((name) => {
    try {
      // scope 直接给 **Agent 对象**：DSH 的 scoped 路由就是拿 agent 当 key
      // （`scopeTarget(base, exec.agent)`）。传 `agent.ctx` 会落到别的层，读出来全是「不可见」。
      return get.call(registry, name, agent) === undefined
    } catch (error) {
      void error
      return true
    }
  })
}

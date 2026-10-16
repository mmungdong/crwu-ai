import { existsSync } from 'node:fs'
import { text } from '../../../../shared/utils/value.ts'
import type { Context } from '@deepseek-ai/cordis'
import { bundledBinaryPath } from '../../../core/platform/bin-dir.ts'
import type { ToolDeps } from '../../../tools/common/types.ts'
import { CAPABILITY_CATALOGUE, type CapabilityFacts } from './capabilities.ts'
import { VALUATION_CHILD_TOOLS } from '../../../tools/report-evaluation/consts.ts'

/**
 * **能力门禁的"真实事实"**（设计稿 §8.1，计划 Task 8）。
 *
 * 门禁的价值全在"事实"这两个字上：`registeredTools` 必须来自**实际注册表**，
 * `visibleTools` 必须来自**实际 scoped 查询**，`adapters` 必须来自**真的装配了什么**，
 * `providerHealthy` 必须来自**这一轮真的记下来的来源状态**。
 *
 * 任何一项读不到就当成"没有"（fail closed）—— 把读不到写成 true 会让
 * `checkMethodCapabilities` 得出"能力齐备"的结论，而那正是"抓完才发现工具不存在"的起点。
 */

export interface CapabilityFactInput {
  ctx: Context
  deps: ToolDeps
  /** 调用方 Agent（scoped 查询用它；没有就只查未收窄的注册表）。 */
  agent?: unknown
  /** 本轮估值的 id（用来读来源状态；拿不到就没有"健康来源"）。 */
  valuationId: string
}

export interface CapabilityFactResult {
  facts: CapabilityFacts
  /** 读事实时发现的问题（进报告的技术过程，不进员工界面）。 */
  notes: string[]
}

/** 工具名 → 是否注册（`scoped=false`）/ 是否在当前作用域可见（`scoped=true`）。 */
function toolLookup(ctx: Context, scoped: boolean, agent?: unknown): (name: string) => boolean {
  const registry = ctx.get('tools') as { get?: (name: string, scope?: unknown) => unknown } | undefined
  const get = registry?.get
  if (typeof get !== 'function') return () => false
  return (name: string): boolean => {
    try {
      return scoped ? get.call(registry, name, agent) !== undefined : get.call(registry, name) !== undefined
    } catch (error) {
      void error
      return false
    }
  }
}

/** 目录里所有需要的工具名（能力目录 + 估值链路必需集）。 */
function requiredToolNames(): string[] {
  const names = new Set<string>(VALUATION_CHILD_TOOLS)
  for (const row of CAPABILITY_CATALOGUE) {
    if (row.registeredTool !== '') names.add(row.registeredTool)
  }
  return [...names]
}

export async function capabilityFactsOf(input: CapabilityFactInput): Promise<CapabilityFactResult> {
  const { ctx, deps } = input
  const notes: string[] = []
  const names = requiredToolNames()
  const registered = toolLookup(ctx, false, input.agent)
  const visible = toolLookup(ctx, true, input.agent)
  const registeredTools = names.filter((name) => registered(name))
  const visibleTools = names.filter((name) => visible(name))
  if (visibleTools.length === 0) {
    notes.push('读不到任何可见工具：能力门禁按"什么都没有"处理')
  }

  // 适配器只看**真的装配了什么**。
  const adapters: string[] = []
  if (deps.python !== undefined) adapters.push('python.runtime')
  if (deps.browserRuntime !== undefined) {
    adapters.push('browser.cli')
    if (deps.browserRuntime.coordinator !== undefined) adapters.push('browser.challenge.script')
  }
  let platform = ''
  try {
    platform = text(deps.world.cached().platform)
  } catch {
    platform = ''
  }
  if (platform === '') {
    try {
      platform = await deps.world.platform()
    } catch (error) {
      notes.push(`读不到本机平台：无法核对 dws 二进制是否随包可用（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  if (platform !== '') {
    try {
      // 随包二进制：**绝不回退 PATH 上的同名命令**（否则"能力可用"取决于员工机器上装了什么）。
      if (existsSync(bundledBinaryPath(platform, 'dws'))) {
        adapters.push('dws.read', 'dws.download')
      } else {
        notes.push('随包 dws 二进制不存在：知识读写能力按不可用处理')
      }
    } catch (error) {
      notes.push(`核对随包二进制时出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 来源健康：只认这一轮**真的**记成 authenticated 的来源。
  const providerHealthy: Record<string, boolean> = {}
  const record = deps.valuationLifecycles?.get(input.valuationId)
  for (const [id, state] of Object.entries(record?.providerStates ?? {}) as Array<[string, { state: string }]>) {
    providerHealthy[id] = state.state === 'authenticated'
  }
  if (Object.keys(providerHealthy).length === 0) {
    notes.push('这一轮还没有确认过任何来源状态：来源相关能力按"尚未验证"处理（未登录 / 未探测都不算可用）')
  }

  return {
    facts: { registeredTools, visibleTools, adapters, providerHealthy },
    notes,
  }
}

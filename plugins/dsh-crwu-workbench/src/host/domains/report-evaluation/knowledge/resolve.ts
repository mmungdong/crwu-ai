import { text } from '../../../../shared/utils/value.ts'
import {
  routesForMethod,
  VALUATION_KNOWLEDGE_ROUTES,
  type KnowledgeRoute,
  type ValuationMethodKey,
} from './route.ts'
import {
  buildKnowledgeSource,
  byteLength,
  knowledgeSnapshotDigest,
  type KnowledgeSource,
} from './snapshot.ts'

/**
 * 知识路由的**决策层**（纯逻辑，I/O 由 `KnowledgeProbe` 注入）。
 *
 * 顺序与降级口径（照业务口径逐条实现，不发明规则）：
 *
 * ```text
 * 该路由需要吗（按方法裁剪）
 *   → DSW 有该节点且有正文 → source = 'dws'（权威）
 *   → 否则读技能自带 references → source = 'local'
 *   → 两边都没有：必需路由 → **停止估值**；其它 → 记 capability gap 继续
 * ```
 *
 * 三条容易写错的地方，这里刻意做成显式判据：
 * 1. **空正文不算"有"**。节点存在但导出为空（权限、占位节点）时若算命中，
 *    子会话会拿到一段空上下文，然后"按规范"编出一套说法 —— 那正是要避免的。
 * 2. **探测失败 ≠ 节点不存在**。前者是能力/基础设施缺口（要报出来），
 *    后者是可以走本地 fallback 的正常降级。两者都写成"没有"，运维就查不出知识库挂过。
 * 3. **必需路由缺了就是停止**，不是"继续 + 缺口" —— 缺了通用口径的结果没有可信度。
 */

export interface KnowledgeProbeResult {
  /** 真的拿到了**非空**正文。 */
  found: boolean
  body?: string
  updatedAt?: string
  /** 探测失败的原因（不可达 / 权限 / 命令失败）；`found: false` 且非空时按"失败"记。 */
  error?: string
}

export interface KnowledgeProbe {
  /** 从业务知识库取一份节点正文。 */
  dws(route: KnowledgeRoute): Promise<KnowledgeProbeResult> | KnowledgeProbeResult
  /** 读技能自带的参考文件。 */
  local(route: KnowledgeRoute): Promise<KnowledgeProbeResult> | KnowledgeProbeResult
}

/** 要落盘的正文（调用方负责写文件；决策层不碰 fs）。 */
export interface KnowledgeBody {
  route: string
  node: string
  /** 相对案例目录的落点，例如 `知识快照/02-市场法.md`。 */
  file: string
  body: string
  source: 'dws' | 'local'
}

export interface ResolvedKnowledge {
  /** false = **必须停止估值**（必需知识两边都缺）。 */
  ok: boolean
  error: string
  sources: KnowledgeSource[]
  bodies: KnowledgeBody[]
  capabilityGaps: string[]
  warnings: string[]
  /** 整份快照指纹（按路由排序后算）。 */
  digest: string
}

/** 落点文件名：去掉库内编号前缀里的斜杠风险，保留可读编号。 */
export function knowledgeFileName(route: KnowledgeRoute): string {
  const safe = route.node.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return `${safe}.md`
}

/** 空正文 → 未命中（见口径 1）。 */
function hit(result: KnowledgeProbeResult | undefined): boolean {
  return result?.found === true && text(result.body).trim() !== ''
}

async function safely(run: () => Promise<KnowledgeProbeResult> | KnowledgeProbeResult): Promise<KnowledgeProbeResult> {
  try {
    return await run()
  } catch (error) {
    return { found: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface ResolveKnowledgeInput {
  method: ValuationMethodKey
  probe: KnowledgeProbe
  /** 要检查的路由；缺省按方法裁剪。测试可显式给。 */
  routes?: readonly KnowledgeRoute[]
  /** 正文落点目录（相对案例目录），用于填 `file` 字段。 */
  dir?: string
}

export async function resolveKnowledgePlan(input: ResolveKnowledgeInput): Promise<ResolvedKnowledge> {
  const dir = text(input.dir) || '知识快照'
  const routes = input.routes ?? routesForMethod(input.method)
  const sources: KnowledgeSource[] = []
  const bodies: KnowledgeBody[] = []
  const gaps: string[] = []
  const warnings: string[] = []
  const missingRequired: KnowledgeRoute[] = []

  // 全部路由都探一遍再决定要不要停：缺必需知识时如果当场返回，证据里就只有"缺 01"，
  // 而运维真正想知道的往往是"一共缺哪几份、另外几份是从库里拿的还是本地兜的"。
  // 代价只是几次探针调用，而这条路径本来就要遍历七条。
  for (const route of routes) {
    const dws = await safely(() => input.probe.dws(route))
    if (hit(dws)) {
      const body = text(dws.body)
      const file = `${dir}/${knowledgeFileName(route)}`
      sources.push(buildKnowledgeSource({
        route, source: 'dws', body, file,
        ...(text(dws.updatedAt) === '' ? {} : { updatedAt: text(dws.updatedAt) }),
      }))
      bodies.push({ route: route.route, node: route.node, file, body, source: 'dws' })
      continue
    }
    // 探测**失败**（不是"没有这个节点"）：如实记一条缺口，再走本地 fallback。
    // 两者混为一谈的话，"知识库挂过"这件事在证据里就永远看不见。
    const probeError = text(dws.error)
    if (probeError !== '') {
      gaps.push(`知识库读取失败（${route.route}）：${probeError}；本轮改用技能自带参考文件`)
    }

    const local = await safely(() => input.probe.local(route))
    if (hit(local)) {
      const body = text(local.body)
      const file = `${dir}/${knowledgeFileName(route)}`
      sources.push(buildKnowledgeSource({
        route, source: 'local', body, file,
        ...(text(local.updatedAt) === '' ? {} : { updatedAt: text(local.updatedAt) }),
      }))
      bodies.push({ route: route.route, node: route.node, file, body, source: 'local' })
      if (probeError === '') {
        warnings.push(`${route.route}：知识库里没有这个节点，本轮用技能自带参考文件`)
      }
      continue
    }

    // 两边都没有。
    const reason = probeError !== '' ? `知识库读取失败且本地参考也缺失（${probeError}）` : '知识库与本地参考都没有这份正文'
    sources.push(buildKnowledgeSource({
      route, source: 'missing', body: '', file: '', missingReason: reason,
    }))
    if (route.required) {
      missingRequired.push(route)
      gaps.push(`缺少必需知识：${route.route}`)
    } else {
      gaps.push(`缺少业务知识「${route.route}」（${route.when}）：${reason}`)
    }
  }

  const digest = knowledgeSnapshotDigest(sources)
  if (missingRequired.length > 0) {
    const names = missingRequired.map((route) => `「${route.route}」`).join('、')
    return {
      ok: false,
      error: `缺少必需的业务知识${names}：估值已停止 —— `
        + '没有通用口径就产出的数字无法核对，需要先把这份规范放进知识库或随技能发布。',
      sources,
      bodies,
      capabilityGaps: gaps,
      warnings,
      digest,
    }
  }

  return { ok: true, error: '', sources, bodies, capabilityGaps: gaps, warnings, digest }
}

/**
 * 全部路由的检查清单（不做取数）：给界面/提示词说明"这一轮需要哪些知识"。
 *
 * 与 `resolveKnowledgePlan` 共用 `routesForMethod`，于是"需要哪些"只有一个判据。
 */
export function knowledgeRouteChecklist(method: ValuationMethodKey): Array<{
  route: string
  node: string
  required: boolean
  when: string
}> {
  return routesForMethod(method).map((route) => ({
    route: route.route, node: route.node, required: route.required, when: route.when,
  }))
}

/** 正文总量（诊断用：太大时应当分批注入，而不是全塞进提示词）。 */
export function knowledgeBodyBytes(bodies: readonly KnowledgeBody[]): number {
  return bodies.reduce((total, item) => total + byteLength(item.body), 0)
}

/** 全部库内节点名（技能自检与路由表核对用）。 */
export function knowledgeNodeNames(): string[] {
  return VALUATION_KNOWLEDGE_ROUTES.map((route) => route.node)
}

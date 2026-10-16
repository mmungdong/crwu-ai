import { text } from '../../../../shared/utils/value.ts'
import type { Blocker, ValuationPlan } from '../../../../shared/contracts/valuation-project.ts'

/**
 * **方法所需能力的门禁**（设计稿 §8.1，计划 Task 8）。
 *
 * ## 为什么"写在提示词里的能力清单"不算实现
 *
 * 方法文档声明"我需要 `market.residential.detail`"。如果这个声明只落在 Prompt 里，
 * Agent 完全可以在能力缺席时照样去抓网页 —— 抓到一半才发现 Tool 不存在，于是开始
 * 自由试错（装库、拼命令、推选择器）。那正是被明确禁止的路径。
 *
 * 所以每一项能力都要**三项同时成立**才算可用：
 *
 * 1. **registered** —— Host 真的注册了这个 Tool（读实际注册表，不读常量名单）；
 * 2. **scoped-visible** —— 当前调用者作用域里它真的可见（Tool filter 的真实结果，
 *    不是"我们以为过滤成这样"）；
 * 3. **actually verified** —— 需要的 adapter 已装配，且要求的 provider 真的健康
 *    （"装了浏览器适配器"不等于"链家现在能用"）。
 *
 * 三项缺一 → `available: false`，并且**在取数之前**产出 blocker。降级项（`degradable`）
 * 不阻断，但会被记进来（例如没有本地重算 provider → `partial`，不是业务失败）。
 */

/** 能力清单里的一项：需要哪个 Tool、哪些 adapter、哪些来源。 */
export interface CapabilityRequirement {
  id: string
  /** 该能力由哪个结构化 Tool 提供（Host 实际注册名）。 */
  registeredTool: string
  /** 必须装配的适配器 id。 */
  adapters: readonly string[]
  /** 必须健康的来源 id；空数组 = 与具体来源无关。 */
  providers?: readonly string[]
  /** 缺失时只降级（进 `partial`），不阻断。 */
  degradable?: boolean
  /** 缺失时给员工看的一句话。 */
  label: string
  /** 补齐动作。 */
  remediation: string
  /** 按设计**明确不可用**的能力（例如尚未实现的土地估值）。 */
  unavailableReason?: string
}

/**
 * 能力目录。键是 capability manifest 的 ID，与 `project/coverage.ts` 列出的必需能力一致。
 *
 * 这是**技术**目录：它只说"跑这条链路要什么"，不含任何业务阈值。
 */
export const CAPABILITY_CATALOGUE: readonly CapabilityRequirement[] = [
  {
    id: 'knowledge.realestate.catalog',
    registeredTool: 'crwu_valuation_knowledge_materialize',
    adapters: ['dws.read'],
    label: '业务知识库目录读取',
    remediation: '确认 dws 随包可用且本机已登录；知识正文一律实时取回，不落缓存。',
  },
  {
    id: 'knowledge.realestate.method-selection',
    registeredTool: 'crwu_valuation_knowledge_materialize',
    adapters: ['dws.read'],
    label: '房地产评估方法选择方案',
    remediation: '在业务知识库补齐「01 房地产评估方法选择方案」正文后再跑方法判定。',
  },
  {
    id: 'browser.auth.status',
    registeredTool: 'crwu_valuation_browser_preflight',
    adapters: ['browser.cli'],
    label: '来源登录状态检查',
    remediation: '确认 `crwu browser` 随包可用；登录由员工在可见窗口完成，插件不代持凭据。',
  },
  {
    id: 'market.residential.search',
    registeredTool: 'crwu_valuation_market_search',
    adapters: ['browser.cli'],
    providers: ['lianjia'],
    label: '住宅可比案例检索',
    remediation: '确认来源适配器已装配且站点清单包含该来源；检索范围必须来自知识快照。',
  },
  {
    id: 'market.residential.detail',
    registeredTool: 'crwu_valuation_market_capture',
    adapters: ['browser.cli'],
    label: '房源详情取证',
    remediation: '确认浏览器通道可用；详情必须取回最终 URL 与业务字段，列表页记录不等于详情取证成功。',
  },
  {
    id: 'browser.page.screenshot',
    registeredTool: 'crwu_valuation_market_capture',
    adapters: ['browser.cli'],
    label: '页面截图留证',
    remediation: '确认截图通道可用；缺截图时按知识允许的替代证据处理，否则本方案中断或 partial。',
  },
  {
    id: 'browser.challenge.recover',
    registeredTool: 'crwu_valuation_browser_recover',
    adapters: ['browser.cli', 'browser.challenge.script'],
    label: '可见人机验证恢复',
    remediation: '确认 CLI 的 `recover` 子命令、embed 的固定探针与策略适配器都已装配；'
      + '未装配时**不得**让 Agent 现场生成解法。',
    // 挑战恢复是"先尝试、失败转人工"的能力：它缺席时仍可让员工在可见窗口完成验证，
    // 但必须显式记缺口，不能假装自动处理过。
    degradable: true,
  },
  {
    id: 'parameters.market-index.read',
    registeredTool: 'crwu_valuation_knowledge_materialize',
    adapters: ['dws.read'],
    label: '市场状况与税费参数',
    remediation: '在业务知识库补齐「04 参数与税费」下的参数文件；缺参数不许按记忆补数。',
  },
  {
    id: 'template.xlsx.materialize',
    registeredTool: 'crwu_valuation_template_materialize',
    adapters: ['dws.download'],
    label: '计算表模板下载',
    remediation: '确认索引里存在**已发布**的住宅市场法模板；空目录、TODO 标题、预留正文都不是可用模板。',
  },
  {
    id: 'valuation.market.calculate',
    registeredTool: 'crwu_run_python_script',
    adapters: ['python.runtime'],
    label: '市场法脚本计算',
    remediation: '确认 DSH 自带 Python 可用；计算由脚本执行，业务阈值与参数来自本轮知识快照。',
  },
  {
    id: 'workbook.recalculate',
    registeredTool: 'crwu_valuation_finalize',
    adapters: ['excel.local', 'libreoffice.local'],
    label: '计算表重算',
    remediation: '装一个受 Broker 验证的本地表格程序；没有它时保留公式正确的底稿并标「待重算」，'
      + '报告只能到 partial，不能称正式完成。',
    // 明确可降级：缺重算 provider 是 `partial`，不是业务失败（设计稿 §10.3）。
    degradable: true,
  },
  {
    id: 'land.valuation.execute',
    registeredTool: '',
    adapters: [],
    label: '土地估值',
    remediation: '先实现并验证土地 Skill、结构化 Tool、知识路由与模板，再按三个互斥价值范围重跑该方案。',
    unavailableReason: '土地估值 Skill 尚未实现：没有方法正文、知识路由、结构化 Tool 与计算表模板。',
  },
]

export function requirementOf(id: string): CapabilityRequirement | undefined {
  return CAPABILITY_CATALOGUE.find((item) => item.id === text(id))
}

/** 当前部署的**真实事实**（全部来自实际读取，不是常量声明）。 */
export interface CapabilityFacts {
  /** Host 实际注册的 Tool 名。 */
  registeredTools: readonly string[]
  /** 当前调用者作用域内**真正可见**的 Tool 名（Tool filter 的结果）。 */
  visibleTools: readonly string[]
  /** 已装配的适配器 id。 */
  adapters: readonly string[]
  /** 来源健康状态（`true` 才代表"现在能用"）。 */
  providerHealthy: Record<string, boolean>
}

export interface CapabilityMissing {
  id: string
  label: string
  registeredTool: string
  /** 逐条原因（"注册了但作用域不可见"必须与"没注册"分开）。 */
  reasons: string[]
  degradable: boolean
  blocker: Blocker
}

export interface CapabilityCheck {
  ok: boolean
  available: string[]
  degradable: string[]
  missing: CapabilityMissing[]
  /** 只保留非降级缺口对应的 blocker（可以直接进报告）。 */
  blockers: Blocker[]
}

/**
 * 方法需要哪些能力（来自知识快照的声明 + 方案的物业类型/路径）。
 *
 * `knowledge.capabilityIds` 是**知识文档声明的**所需能力；这里与覆盖矩阵的必需能力取并集，
 * 于是"知识漏声明"不会让门禁漏检，而"知识多声明"会被如实检查。
 */
export interface PlanCapabilityDemand {
  projectId: string
  planId: string
  propertyType: string
  valuationPath: string
  method: string
  /** 知识声明需要的能力 ID。 */
  capabilityIds: readonly string[]
  /** 覆盖矩阵算出的必需能力 ID（`assessCoverage().requiredCapabilities`）。 */
  requiredCapabilities: readonly string[]
  /** 知识明确不要求截图时置 false。 */
  screenshotRequired: boolean
}

function missingBlocker(
  plan: ValuationPlan,
  requirement: CapabilityRequirement,
  reasons: readonly string[],
): Blocker {
  return {
    kind: 'capability-missing',
    stage: 'retrieval',
    code: `valuation.capability.${requirement.id}`,
    capabilityId: requirement.id,
    missing: [`能力「${requirement.label}」（${requirement.id}）`],
    checked: [
      `registeredTool:${requirement.registeredTool || '(未定义)'}`,
      `adapters:${requirement.adapters.join(',') || '(无)'}`,
      ...(requirement.providers === undefined ? [] : [`providers:${requirement.providers.join(',')}`]),
      `plan:${plan.planId}`,
    ],
    reason: `${reasons.join('；')}。方法需要「${requirement.label}」，当前部署无法提供。`,
    remediation: requirement.remediation,
  }
}

/**
 * 逐项核对能力。**在取数之前调用**：缺席的能力必须在抓网页之前变成 blocker。
 */
export function checkMethodCapabilities(
  plan: ValuationPlan,
  demand: PlanCapabilityDemand,
  facts: CapabilityFacts,
): CapabilityCheck {
  const registered = new Set(facts.registeredTools.map((item) => text(item)))
  const visible = new Set(facts.visibleTools.map((item) => text(item)))
  const adapters = new Set(facts.adapters.map((item) => text(item)))
  const wanted = new Set<string>([...demand.requiredCapabilities, ...demand.capabilityIds].map((item) => text(item)))
  if (demand.screenshotRequired) wanted.add('browser.page.screenshot')
  wanted.delete('')

  const available: string[] = []
  const degradable: string[] = []
  const missing: CapabilityMissing[] = []

  for (const id of wanted) {
    const requirement = requirementOf(id)
    if (requirement === undefined) {
      // 认不出来的能力 ID：**不猜**它能用。认不出来本身就是缺口 —— 而且它多半意味着
      // 知识文档与 Host 能力目录已经漂移，这比"某个 Tool 没装"更需要人看一眼。
      const reason = '能力目录里没有这个 capability ID（可能是知识文档写错了 ID）'
      missing.push({
        id, label: id, registeredTool: '', reasons: [reason], degradable: false,
        blocker: {
          kind: 'capability-missing',
          stage: 'retrieval',
          code: `valuation.capability.unknown.${id}`,
          capabilityId: id,
          missing: [`能力目录里没有的 capability ID「${id}」`],
          checked: ['capability:CAPABILITY_CATALOGUE', `plan:${plan.planId}`],
          reason: `${reason}：方法声明的能力必须能被 Host 逐项核对，认不出来的一律按缺失处理。`,
          remediation: '核对知识文档声明的 capability ID 与 Host 的能力目录，二者必须逐字一致后再重跑本方案。',
        },
      })
      continue
    }
    const reasons: string[] = []
    if (text(requirement.unavailableReason) !== '') reasons.push(text(requirement.unavailableReason))
    if (text(requirement.registeredTool) === '') {
      reasons.push('该能力没有对应的结构化 Tool')
    } else {
      if (!registered.has(requirement.registeredTool)) {
        reasons.push(`Tool「${requirement.registeredTool}」没有注册`)
      } else if (!visible.has(requirement.registeredTool)) {
        // 注册了但当前作用域不可见 —— 与"没注册"是两件不同的事，排查方向完全不同。
        reasons.push(`Tool「${requirement.registeredTool}」已注册，但不在当前作用域可见范围内`)
      }
    }
    for (const adapter of requirement.adapters) {
      if (!adapters.has(adapter)) reasons.push(`适配器「${adapter}」未装配`)
    }
    for (const provider of requirement.providers ?? []) {
      if (facts.providerHealthy[provider] !== true) {
        reasons.push(`来源「${provider}」当前不可用（未登录 / 未验证 / 探测失败）`)
      }
    }

    if (reasons.length === 0) {
      available.push(id)
      continue
    }
    const isDegradable = requirement.degradable === true
    if (isDegradable) degradable.push(id)
    else {
      missing.push({
        id, label: requirement.label, registeredTool: requirement.registeredTool,
        reasons, degradable: false,
        blocker: missingBlocker(plan, requirement, reasons),
      })
    }
  }

  return {
    ok: missing.length === 0,
    available,
    degradable,
    missing,
    blockers: missing.map((item) => item.blocker),
  }
}

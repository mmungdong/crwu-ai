/**
 * 房地产估值的**业务知识路由表**。
 *
 * 这一层是"知识从哪儿来"的唯一事实源，三条口径：
 *
 * 1. **知识内容不进插件**。这里只有库内路径与本地参考文件名的**映射**，没有一行业务正文 ——
 *    正文由 DSW 实时取，或读技能自带的 `references/`。
 * 2. **库内路径逐字固定**。它们是业务知识库里的真实节点名，不做模糊匹配（不折叠大小写、
 *    不折叠全半角、不按前缀猜）。
 * 3. **本地 fallback 显式列表**，绝不按文件名反推业务节点。
 *    本地文件的编号与库内编号**故意不一致**（`07-成本法` 对应本地 `07-cost-method.md`，
 *    而 `04-案例选取` 对应本地 `04-case-selection.md`）—— 要是按编号或文件名去猜，
 *    成本法会读到案例选取的正文，而且不会有任何报错。所以映射只能**逐个写死**。
 */

/** 知识来源：DSW 实时拉取，还是技能自带参考文件。 */
export type KnowledgeOrigin = 'dws' | 'local' | 'missing'

export interface KnowledgeRoute {
  /** 库内子域下的节点名（逐字）。 */
  node: string
  /** 完整业务路由：`估值与测算/房地产/<node>`（结果 JSON 与快照索引里用它）。 */
  route: string
  /** 技能内的本地参考文件（相对于技能目录）。 */
  localReference: string
  /**
   * **必需**知识：两边都缺时必须停止估值。
   *
   * 只有 `01-房地产估值通用` 是必需的：它定义了口径与红线（价值内涵、权属、基准日、
   * 不伪造结论）。缺了它，"按规范完成"这句话就无从谈起 —— 与其产出不可信的数字，不如停下来。
   */
  required: boolean
  /** 什么时候需要它（写进快照索引，子会话据此按需读）。 */
  when: string
  /** 只在这些方法下需要；空数组 = 任何方法都需要。 */
  methods: readonly ValuationMethodKey[]
}

export type ValuationMethodKey = 'auto' | 'market' | 'income' | 'cost'

/** 知识库子域的固定前缀。 */
export const KNOWLEDGE_SUBDOMAIN = '估值与测算/房地产'

/**
 * 知识库名称。
 *
 * 与审核链路默认的「中瑞世联评估审核知识库」**不是同一个库** —— 业务知识在
 * 「中瑞世联业务知识库」下。名称在这里只写一次，工具与测试共用。
 */
export const VALUATION_KNOWLEDGE_SPACE = '中瑞世联业务知识库'

/** 估值案例目录内的知识快照目录与索引文件名。 */
export const KNOWLEDGE_SNAPSHOT_DIR = '知识快照'
export const KNOWLEDGE_INDEX_FILE = '.知识来源.json'

/** 七条路由（顺序即展示顺序）。 */
export const VALUATION_KNOWLEDGE_ROUTES: readonly KnowledgeRoute[] = [
  {
    node: '01-房地产估值通用',
    route: `${KNOWLEDGE_SUBDOMAIN}/01-房地产估值通用`,
    localReference: 'references/01-realestate-valuation.md',
    required: true,
    when: '每次估值开始时必读',
    methods: [],
  },
  {
    node: '02-市场法',
    route: `${KNOWLEDGE_SUBDOMAIN}/02-市场法`,
    localReference: 'references/02-market-method.md',
    required: false,
    when: '采用市场法时必读',
    methods: ['auto', 'market'],
  },
  {
    node: '03-收益法',
    route: `${KNOWLEDGE_SUBDOMAIN}/03-收益法`,
    localReference: 'references/03-income-method.md',
    required: false,
    when: '采用收益法时必读',
    methods: ['auto', 'income'],
  },
  {
    node: '04-成本法',
    route: `${KNOWLEDGE_SUBDOMAIN}/04-成本法`,
    // ⚠️ 本地文件是 `07-cost-method.md`：编号与库内不同，**不能**按编号推导。
    localReference: 'references/07-cost-method.md',
    required: false,
    when: '采用成本法时必读',
    methods: ['auto', 'cost'],
  },
  {
    node: '05-案例选取',
    route: `${KNOWLEDGE_SUBDOMAIN}/05-案例选取`,
    localReference: 'references/04-case-selection.md',
    required: false,
    when: '整理候选案例时必读',
    methods: [],
  },
  {
    node: '06-参数与税费',
    route: `${KNOWLEDGE_SUBDOMAIN}/06-参数与税费`,
    localReference: 'references/05-parameter-mapping.md',
    required: false,
    when: '填参数与税费口径时必读',
    methods: [],
  },
  {
    node: '07-计算表模板',
    route: `${KNOWLEDGE_SUBDOMAIN}/07-计算表模板`,
    localReference: 'references/06-workbook-contract.md',
    required: false,
    when: '填表与勾稽时必读',
    methods: [],
  },
]

/** 必需路由（用于"两边都缺就停止"的判据）。 */
export const REQUIRED_KNOWLEDGE_ROUTES = VALUATION_KNOWLEDGE_ROUTES.filter((item) => item.required)

/** 按库内节点名找路由（逐字匹配；找不到返回 `undefined`）。 */
export function routeByNode(node: string): KnowledgeRoute | undefined {
  const wanted = String(node ?? '').trim()
  return VALUATION_KNOWLEDGE_ROUTES.find((item) => item.node === wanted)
}

/** 按完整业务路由找（逐字匹配）。 */
export function routeByPath(route: string): KnowledgeRoute | undefined {
  const wanted = String(route ?? '').trim()
  return VALUATION_KNOWLEDGE_ROUTES.find((item) => item.route === wanted)
}

/**
 * 这一轮需要哪些路由。
 *
 * 判据是"用户选的方法"：选市场法就不必读收益法正文（少一次取数、少一段无关上下文）。
 * `auto` 需要全部方法类知识 —— 方法由 AI 判定，缺哪一份都可能判错。
 * 非方法类（01/05/06/07）任何方法都需要。
 */
export function routesForMethod(method: ValuationMethodKey): KnowledgeRoute[] {
  return VALUATION_KNOWLEDGE_ROUTES.filter(
    (item) => item.methods.length === 0 || item.methods.includes(method),
  )
}

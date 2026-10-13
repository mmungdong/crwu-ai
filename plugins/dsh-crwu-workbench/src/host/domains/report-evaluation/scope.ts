import { text } from '../../../shared/utils/value.ts'

/**
 * 报告评估（房地产估值）的**案例 scope**（协议 32）。
 *
 * 与 `local-audit/scope.ts` 同一个理由、同一种形状：案例内 Tool（`crwu_run_python_script`、
 * 以后的 `crwu_valuation_*`）判断"这条会话能用哪个案例目录"时，需要的唯一能力就是一个只读查询。
 * 门禁是安全边界，它只认识这个窄接口 —— 不认识估值是怎么发起、冻结、取消的。
 *
 * 为什么估值也要有自己的 scope（它的案例目录本来就在工作空间下、普通判据也认）：
 * 普通判据是"`<工作空间>/<流水号>` 且**不等于**工作空间根"—— 它认的是**形状**，不是**归属**。
 * 于是同一条估值会话可以把 `caseDir` 指向**另一个**估值/审核案例目录，只要形状对。
 * 估值会话的归属必须是"本轮估值自己那一个目录"，所以这里按会话 id 逐字绑定。
 */

export interface ValuationScope {
  valuationId: string
  /** 本轮估值的案例目录：`<已选工作区>/<valuationId>`。 */
  casePath: string
  /** 绑定的会话（估值子会话）。 */
  sessionId: string
  workspaceId: string
  workspacePath: string
  /**
   * **确认抽屉确认时冻结的输入快照**。
   *
   * 它是这一层唯一不可变的东西：方法 / 基准日 / 补充提示词 / 资料清单都在里面，
   * 子会话只能消费，不能改写（改写的入口不存在 —— 本层没有 setter）。
   */
  snapshot: ValuationSnapshot
  openedAt: number
}

/** 冻结的估值输入（确认抽屉按下"确认并开始估值"那一刻的事实）。 */
export interface ValuationSnapshot {
  valuationId: string
  method: ValuationMethod
  /** 用户选择的基准日；未选择时是**空串**（绝不从资料里补一个）。 */
  baseDate: string
  supplementalPrompt: string
  /** 输入清单指纹（`buildIntakeManifest().digest`）。 */
  digest: string
  files: ReadonlyArray<{
    fileName: string
    relativePath: string
    kind: string
    sizeBytes: number
    sha256: string
  }>
  frozenAt: string
}

export type ValuationMethod = 'auto' | 'market' | 'income' | 'cost'

export const VALUATION_METHODS: readonly ValuationMethod[] = ['auto', 'market', 'income', 'cost']

/** 方法在界面与结果里的名字。 */
export function valuationMethodLabel(method: ValuationMethod): string {
  switch (method) {
    case 'auto': return '自动判定'
    case 'market': return '市场法'
    case 'income': return '收益法'
    case 'cost': return '成本法'
  }
}

/** 取值是否是一个合法的方法（模型/界面提交的值一律走这里收窄）。 */
export function isValuationMethod(value: unknown): value is ValuationMethod {
  return (VALUATION_METHODS as readonly string[]).includes(text(value))
}

/**
 * 案例 scope 的只读查询面（门禁只依赖它）。
 */
export interface ValuationScopeRegistry {
  scopeOf(sessionId: string): ValuationScope | undefined
  get(valuationId: string): ValuationScope | undefined
}

/**
 * 进程内注册表。
 *
 * 两条与审核链路一致的约束：
 *   - **随插件生命周期**：它是 `apply()` 里造出来交给 Tool 闭包的实例，插件卸载即消失
 *     （跨进程重启后旧会话再也拿不到 scope，这是刻意的：重启后 Host 的记录不可信）；
 *   - **有界**：估值一轮只开一个 scope，但员工可能连着开很多轮而不结束。超过上限就按
 *     `openedAt` 淘汰最旧的 —— 淘汰掉的是"还没结束的估值会话"的访问权（它会当场失败，
 *     不会拿到错的案例目录），比无界增长到把进程拖垮安全。
 */
export class ValuationScopes implements ValuationScopeRegistry {
  private readonly bySession = new Map<string, ValuationScope>()
  private readonly byId = new Map<string, ValuationScope>()
  private readonly maxEntries: number

  // 显式字段而不是构造函数参数属性：测试用 Node 原生**剥离类型**加载 `.ts`，
  // 参数属性不在剥离范围内（会直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
  constructor(maxEntries = 64) {
    this.maxEntries = maxEntries
  }

  open(scope: ValuationScope): void {
    const previous = this.byId.get(scope.valuationId)
    if (previous !== undefined) this.close(scope.valuationId)
    this.bySession.set(scope.sessionId, scope)
    this.byId.set(scope.valuationId, scope)
    this.prune()
  }

  scopeOf(sessionId: string): ValuationScope | undefined {
    return sessionId === '' ? undefined : this.bySession.get(sessionId)
  }

  get(valuationId: string): ValuationScope | undefined {
    return valuationId === '' ? undefined : this.byId.get(valuationId)
  }

  /** 结束一轮估值：释放它的案例访问权（下一个案例内调用立刻 fail closed）。 */
  close(valuationId: string): boolean {
    const scope = this.byId.get(valuationId)
    if (scope === undefined) return false
    this.byId.delete(valuationId)
    // 只删指向自己的那一条：同一会话被复用到另一轮估值时，不能把新 scope 一起抹掉。
    if (this.bySession.get(scope.sessionId)?.valuationId === valuationId) {
      this.bySession.delete(scope.sessionId)
    }
    return true
  }

  get size(): number {
    return this.byId.size
  }

  /** 淘汰最旧的，直到回到上限之内。 */
  private prune(): void {
    while (this.byId.size > this.maxEntries) {
      let oldest: ValuationScope | undefined
      for (const scope of this.byId.values()) {
        if (oldest === undefined || scope.openedAt < oldest.openedAt) oldest = scope
      }
      if (oldest === undefined) return
      this.close(oldest.valuationId)
    }
  }
}

/**
 * 估值 id 的形状：`估值-<yyyymmdd>-<hhmmss>-<4 位十六进制>`。
 *
 * 为什么不用纯 uuid：它是**目录名**，员工要在工作区里一眼认出"这是哪一轮"。
 * 为什么仍要随机后缀：同一秒内连开两轮不能撞目录（撞了会写到同一个案例里）。
 */
export function mintValuationId(now: Date, random: () => number = Math.random): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = pad(Math.floor(random() * 0xffff), 4).replace(/[^0-9a-f]/gi, '0')
  return `估值-${date}-${time}-${suffix.slice(0, 4).toLowerCase()}`
}

/**
 * 估值 id 能不能当作**单段目录名**。
 *
 * 判据与流水号一致（`caseDirOf` 会把 `..`、绝对路径与分隔符直接抛掉，但这里显式判一次，
 * 好让失败理由落在"id 不合法"上，而不是"案例目录算不出来"）。
 */
export function isSafeValuationId(value: unknown): boolean {
  const raw = text(value).trim()
  if (raw === '' || raw.length > 128) return false
  if (raw === '.' || raw === '..') return false
  return !/[\\/]/.test(raw) && !raw.includes('..')
}

/**
 * 冻结输入快照的**一致性核对**（协议 32 · 方案 §5.4 / §16）。
 *
 * ## 为什么需要它
 *
 * "确认后输入快照不可变"原先只有两层保障：① 子会话**没有参数**能改方法 / 基准日 / 补充要求；
 * ② `valuation-start` 在建会话**之前**核对一次确认指纹。两层都对，但都管不到一件事：
 * `估值输入.json` 是**案例目录里的一个普通文件**，而估值会话对案例目录有写权限 ——
 * 谁都可以改它，而**改完之后没有任何地方会知道**。子会话自己读的就是这份文件。
 *
 * 所以这里做的是**让篡改可见**：把磁盘上的文件与宿主内存里的那一份逐字段比一遍，
 * 不一致就如实报出来（而不是假装快照天然不可变）。宿主那一份才是权威 —— 它由
 * `valuation-start` 在确认那一刻写死，子会话改不到。
 *
 * 比对的字段只有**会影响结论**的四个：方法 / 基准日 / 补充要求 / 输入清单指纹。
 * `frozenAt` 之类不参与比对（它不是判据，只是一个时间戳）。
 */
export interface FrozenInputLike {
  method?: unknown
  baseDate?: unknown
  supplementalPrompt?: unknown
  digest?: unknown
}

/** 快照被改过时返回一句**能读懂**的话；一致返回空串。 */
export function frozenInputMismatch(
  expected: FrozenInputLike,
  actual: FrozenInputLike | null,
): string {
  if (actual === null) return '案例目录里的 `估值输入.json` 不见了：本轮估值的输入快照缺失'
  const pairs: Array<[string, unknown, unknown]> = [
    ['方法', expected.method, actual.method],
    ['基准日', expected.baseDate, actual.baseDate],
    ['补充要求', expected.supplementalPrompt, actual.supplementalPrompt],
    ['输入清单指纹', expected.digest, actual.digest],
  ]
  const changed = pairs
    .filter(([, want, got]) => String(want ?? '') !== String(got ?? ''))
    .map(([label, want, got]) => `${label}（宿主记录：${String(want ?? '') || '空'} → 文件里：${String(got ?? '') || '空'}）`)
  if (changed.length === 0) return ''
  return `本轮估值的输入快照被改过：${changed.join('；')}。`
    + '输入在确认那一刻就冻结了，改动不生效 —— 请以宿主记录的那一份为准并说明为何要改。'
}

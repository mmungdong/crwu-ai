import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { basenameLocalPath, joinLocalPath } from '../../../shared/utils/local-path.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { ensureDirectory, writeCaseText } from '../common/case-files.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { failure, renderJson, type ToolFailure } from '../common/outcome.ts'
import { callerSession, credentialsTrusted, toolContext, type ToolDeps } from '../common/types.ts'
import { recordCapabilityGap, recordPhase, recordProviderState } from './record.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { allProviders, siteOf } from '../../domains/report-evaluation/browser/providers.ts'
import { fetchTransport } from '../../domains/report-evaluation/browser/fetch-transport.ts'
import { browserTransportForTask } from '../../domains/report-evaluation/browser/browser-transport.ts'
import { fileSystem, readTextIfExists } from '../../core/fs/paths.ts'
import { narrowProviders } from '../../domains/report-evaluation/browser/provider.ts'
import { providerCityStatus, resolveBusinessCity } from '../../domains/report-evaluation/market/city.ts'
import { MARKET_ATTEMPTS, withAttempts } from '../../domains/report-evaluation/browser/retry.ts'
import {
  BUDGET_FILE, MARKET_CANDIDATE_LIMIT, MARKET_PAGE_LIMIT,
  budgetFromJson, budgetMatches, emptyBudget, pageAllowanceOf, recordPage, recordQualified,
  type MarketBudget,
} from '../../domains/report-evaluation/market/budget.ts'
import {
  decidePhase, loginGapText, providerLabel, type MarketProviderId, type ProviderRun,
} from '../../domains/report-evaluation/browser/login-state.ts'
import {
  EVIDENCE_DIR, SCREENSHOT_GAP, captureScreenshot, evidenceExists, saveEvidence, type ValuationScreenshotResult,
} from '../../domains/report-evaluation/browser/capture.ts'
import type { MarketFetchResult, MarketTransport, RawListing } from '../../domains/report-evaluation/browser/provider.ts'
import {
  caseCounts, dedupeAcrossSources, normalizeCase, type ValuationCase,
} from '../../domains/report-evaluation/market/normalize.ts'
import { listingIdOf } from '../../domains/report-evaluation/market/site-parsers.ts'
import { canonicalListingUrl } from '../../domains/report-evaluation/market/candidates.ts'
import { hardExclusionOf, normalizeSelectionRule, selectCandidates } from '../../domains/report-evaluation/market/select.ts'
import {
  LIST_LEDGER_SCHEMA, LIST_PAGE_SCHEMA, pageKeyOf, parseListLedger, parseListPageSnapshot,
  scopeKeyOf, unionRows, type ListLedger, type ListPageSnapshot, type ListScope,
} from '../../domains/report-evaluation/market/list-snapshot.ts'
import { VALUATION_CASES_FILE, VALUATION_TOOL_NAMES } from './consts.ts'
import { planDirRelative } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import { checkMethodCapabilities, type PlanCapabilityDemand } from '../../domains/report-evaluation/execution/capabilities.ts'
import { capabilityFactsOf } from '../../domains/report-evaluation/execution/facts.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'

/**
 * `crwu_valuation_market_search` 与 `crwu_valuation_market_capture`（协议 32）。
 *
 * ## 三轮之间只传递"能核对的东西"
 *
 * 每个分页最多尝试 `MARKET_ATTEMPTS`（2）次；每次尝试前记 URL、失败后记原因。
 * 两次都失败时**不是**简单跳过：由 `decidePhase` 按**真实类别**分流 ——
 * 被登录墙挡住 → `needsLogin`（去登录）；登录状态没能确认（网络 / 验证码 / 站点错误）
 * → `unconfirmed`（按类别处置，**不是**去登录）；已确认放行 → 记能力缺口继续其他来源。
 * 前两类都停在 `browser-login-required`（状态机里"暂停等人、可恢复"的那一格）。
 *
 * 每一页是**独立**的取数任务（`retrievalTaskId` 绑 项目/方案/来源/页面），并逐页回执：
 * 人工完成网页验证之后，调用方据此继续**同一个页面任务**。
 *
 * ## 案例是"证据 + 标准化字段"，不是模型读出来的
 *
 * 结构化数据来自页面里明确声明的 JSON-LD（`market/jsonld.ts`），字段标准化由
 * `market/normalize.ts` 做。两者都不做任何推测，所以**不会出现编造的案例**；
 * 页面没有结构化数据时结果是"0 条 + 一条缺口"，而不是"看着像就写下来"。
 *
 * ## 挂牌价与成交价
 *
 * 每条案例都带 `transactionType`（`market/normalize.ts` 的纪律）。这里把计数一并回给上层，
 * 好让界面与结果 JSON 都能直接看出"其中真正的成交案例有几条"。
 *
 * ## 派生目录在建 / 写之前就绪
 *
 * `来源证据/`、`来源证据/页面/` 与方案目录本身由本工具**幂等创建**（经 Broker），
 * 因为 `crwu browser fetch --out/--dump` 是另一个进程在落盘、不会替我们建父目录。
 * 建不出来是**文件错误**（`errorKind: 'file'`），与登录 / 验证码完全无关。
 */

interface SearchArgs {
  caseDir?: unknown
  /** 方案 id：证据与截图按方案隔离（设计稿 §11.1）。缺省落在案例根，并在警告里说明。 */
  planId?: unknown
  keyword?: unknown
  city?: unknown
  providers?: unknown
  maxPages?: unknown
  startPage?: unknown
  maxAttempts?: unknown
  /** 样本分组（按估值对象与样本用途分；出售与租金分开）。预算按它分账。 */
  group?: unknown
  /** 择优规则（名额 / 优先级 / 渠道顺序全部来自知识正文）。 */
  selection?: unknown
  /** 检索轮次（缺省 = 沿用当前轮）。只有用户要求补搜 / 换规则时才开新一轮。 */
  round?: unknown
  /** 知识声明本方案需要的能力 ID（**取数之前**逐项核对，缺了就地阻断）。 */
  requiredCapabilities?: unknown
  /** 本轮知识是否要求页面截图留证。 */
  screenshotRequired?: unknown
  propertyType?: unknown
  method?: unknown
}

interface SearchCase {
  source: string
  source_label: string
  url: string
  title: string
  community: string
  purpose: string
  property_nature: string
  building_area: number | null
  floor: string
  total_floors: string
  built_year: string
  decoration: string
  price: number | null
  unit_price: number | null
  transaction_type: string
  published_at: string
  captured_at: string
  evidence: string
  /**
   * 这条案例**没有**页面证据（证据没留存下来）。
   *
   * 为什么要显式标出来而不是留一个空 `evidence`：空串既可能表示"没留存"，也可能表示
   * "这段代码漏了赋值"，事后从结果文件上分不出是哪种。而 §10.3/§16 要求每条案例都有证据 ——
   * 没有证据的案例不能当可比实例用，这个事实必须能被复核的人看见。
   */
  evidence_missing: boolean
  /**
   * **页面截图**（§7.4）：相对案例目录的路径；没有截图能力或截图失败时为空串。
   *
   * 与 `evidence` 分开两列而不是混用：HTML 字节 / 指纹 / JSON-LD **不是截图**，
   * 两者在争议复核时的证明力不一样。
   */
  screenshot: string
  /** 截图的内容指纹（`sha256:<hex>`）；没有时为空串。 */
  screenshot_digest: string
  /** 截图采集时刻（ISO）；没有时为空串。 */
  screenshot_captured_at: string
  /**
   * 显式标记"这条案例没有截图"。
   *
   * 与 `evidence_missing` 同一条纪律：空串既可能表示"没截"，也可能表示"忘了赋值"，
   * 分不出来就没法判断证据是否齐备。缺截图能力时**所有**案例都标 true。
   */
  screenshot_missing: boolean
  keep_reason: string
  drop_reason: string
  notes: string[]
}

/**
 * 一条**逐页取数任务**的回执（相对案例目录）。
 *
 * 为什么要逐页留台账：人工完成网页验证之后，"继续哪一个任务"必须能对上原页面 ——
 * 只回一句"失败了"时，模型既拿不到稳定任务 id，也无从知道断在哪一页。
 */
interface RetrievalTaskReport {
  providerId: string
  /** 页面任务号：`1..N` = 检索分页；`0` = 公开预检页。 */
  pageNo: number
  url: string
  retrievalTaskId: string
  /** `fetched` = 这一页取到并解析过；`failed` = 两次尝试后仍未取到（要继续的就是它）。 */
  state: string
}

interface ProviderReport {
  id: string
  label: string
  login: string
  fetchedPages: number
  failedPages: number
  caseCount: number
  attemptLimit: number
  detail: string
  urls: string[]
  notes: string[]
  /** 本来源**要恢复的那个页面任务**（没有待处理的失败时为空串）。 */
  retrievalTaskId: string
  /** 本来源逐页的取数任务回执。 */
  retrievalTasks: RetrievalTaskReport[]
  /** 本来源下一步该做什么（空串 = 不需要人工动作）。 */
  nextAction: string
  /** 这个来源的适配器依据：`archived-capture`（有归档字节）/ `public-pattern`（只有公开路径约定）。 */
  evidence: 'archived-capture' | 'public-pattern'
  /** 这个来源的城市解析结果：`resolved` / `not-covered` / `unresolved`（还没适配）/ `invalid`。 */
  cityStatus: 'resolved' | 'not-covered' | 'unresolved' | 'invalid'
  /** 城市解析的原因（`resolved` 时为空串）。 */
  cityReason: string
  /** 这个来源的城市表页（`resolved` 时为空串）。 */
  citySourcePage: string
  /** 城市表的依据（`archived-capture` / `public-pattern` / 空串）。 */
  citySourceEvidence: string
  /** 本来源在本分组本轮的预算账（Host 持久）。 */
  budget: {
    pagesUsed: number
    candidatesUsed: number
    pageLimit: number
    candidateLimit: number
    stoppedBy: string
    reason: string
  }
}

interface SearchResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  casesPath: string
  phase: string
  canProceed: boolean
  keyword: string
  city: string
  cases: SearchCase[]
  counts: Record<string, number>
  /**
   * 跨站去重**合并掉了**几条（§7.3）。
   *
   * 单独给一个数字，而不是只留在 warnings 文案里：调用方与结果契约要能核对
   * "取到 12 条、合并 3 条、采用 9 条"这条账。
   */
  dedupedAway: number
  selection: {
    present: boolean
    error: string
    maxAdopted: number
    order: string[]
    adopted: string[]
    rejected: Array<{ url: string; reason: string }>
    notes: string[]
    assessments: Array<{ url: string; status: string; reason: string; knowledgeRef: string }>
  }
  /** 业务城市 → 站点城市标识的解析结论（`resolved` / `unresolved`）。 */
  cityStatus: string
  /** 解析出的站点城市标识（进 URL 的那个）。 */
  cityCode: string
  /** 解析不出来时给出的候选（`名称=标识`），供模型改提。 */
  cityCandidates: string[]
  /** 解析依据的站点城市页。 */
  cityPage: string
  providers: ProviderReport[]
  /** 确实"没登录 / 被登录墙挡住"的来源（**只有这一类的处置是去登录**）。 */
  needsLogin: string[]
  /**
   * 登录状态**没能确认**的来源（网络不可达 / 验证码 / 站点错误）。
   *
   * 与 `needsLogin` 分开是刻意的：把它们一起说成"请登录"会让员工反复登录一个没坏的账号，
   * 而真实的下一步（人工过验证、换网络、等站点恢复）永远不会被执行。
   */
  unconfirmed: string[]
  /** 本轮要继续的取数任务（等待人工处理后恢复的那一条）；没有则为空串。 */
  retrievalTaskId: string
  /** 逐页取数任务台账（含 `retrievalTaskId`，模型据此调用恢复工具）。 */
  retrievalTasks: RetrievalTaskReport[]
  /** 每一类"需要人工"的来源各自的下一步动作。 */
  nextActions: string[]
  capabilityGaps: string[]
  warnings: string[]
}

/** 案例 → 结果契约的键名（`估值案例.json` 用下划线风格，见 Skill 的输出契约）。 */
export function caseToJson(item: ValuationCase): SearchCase {
  return {
    source: item.source,
    source_label: item.sourceLabel,
    url: item.url,
    title: item.title,
    community: item.community,
    purpose: item.purpose,
    property_nature: item.propertyNature,
    building_area: item.buildingArea,
    floor: item.floor,
    total_floors: item.totalFloors,
    built_year: item.builtYear,
    decoration: item.decoration,
    price: item.price,
    unit_price: item.unitPrice,
    transaction_type: item.transactionType,
    published_at: item.publishedAt,
    captured_at: item.capturedAt,
    evidence: item.evidence,
    evidence_missing: item.evidence.trim() === '',
    screenshot: item.screenshot,
    screenshot_digest: item.screenshotDigest,
    screenshot_captured_at: item.screenshotCapturedAt,
    screenshot_missing: item.screenshot.trim() === '',
    keep_reason: item.keepReason,
    drop_reason: item.dropReason,
    notes: [...item.notes],
  }
}

/** Serialized case → normalized case (mirror of `caseToJson`), used to replay snapshots. */
export function caseFromJson(item: SearchCase): ValuationCase {
  return {
    source: item.source as MarketProviderId,
    sourceLabel: item.source_label,
    url: item.url,
    title: item.title,
    community: item.community,
    purpose: item.purpose,
    propertyNature: item.property_nature,
    buildingArea: item.building_area,
    floor: item.floor,
    totalFloors: item.total_floors,
    builtYear: item.built_year,
    decoration: item.decoration,
    price: item.price,
    unitPrice: item.unit_price,
    transactionType: item.transaction_type as ValuationCase['transactionType'],
    publishedAt: item.published_at,
    capturedAt: item.captured_at,
    evidence: item.evidence,
    screenshot: item.screenshot,
    screenshotDigest: item.screenshot_digest,
    screenshotCapturedAt: item.screenshot_captured_at,
    keepReason: item.keep_reason,
    dropReason: item.drop_reason,
    notes: [...(item.notes ?? [])],
  }
}

function idleResult(): SearchResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', casesPath: '', phase: '', canProceed: false,
    keyword: '', city: '', cases: [], counts: {}, dedupedAway: 0, providers: [], needsLogin: [],
    selection: { present: false, error: '', maxAdopted: 0, order: [], adopted: [], rejected: [], notes: [], assessments: [] },
    cityStatus: '', cityCode: '', cityCandidates: [], cityPage: '',
    unconfirmed: [], retrievalTaskId: '', retrievalTasks: [], nextActions: [],
    capabilityGaps: [], warnings: [],
  }
}

/** 页面证据的落点子目录（相对案例目录）。 */
const PAGE_DIR = '来源证据/页面'

/** Durable list-snapshot directory inside the plan/case root. */
const SNAPSHOT_DIR = '列表快照'

/**
 * 一次取数任务的**身份**（来源 + 页面 + 项目 + 方案 + 检索要素）。
 *
 * 为什么要全都在里面：恢复预算挂在 `retrievalTaskId` 上（`challenge-recovery.ts`），
 * 只用"来源 + 城市 + 关键字"会让两个项目里查同一个小区**共用同一份预算** ——
 * 第二个项目连一次自动尝试都拿不到，而这件事从回执上完全看不出来。
 */
export interface RetrievalTaskIdentity {
  /** 项目归属（Host 铸号；缺 scope 时退到案例目录名）。 */
  projectId: string
  /** 方案归属；没有方案时为空串。 */
  planId: string
  providerId: string
  /** 页面任务号：`1..N` = 检索分页；`0` = 公开预检页（与检索页分开，恢复才不会救错页面）。 */
  pageNo: number
  keyword: string
  city: string
}

/**
 * 取数任务 id：由**身份**派生，而不是时间戳或随机值。
 *
 * 稳定性是刻意的：员工在可见窗口里完成验证之后，"继续同一个任务"这件事必须能对上 ——
 * 用时间戳或随机 id 会让恢复变成"另起一个任务"，于是断点与预算都对不上。
 * 字符集收到安全范围内（它同时是证据文件名前缀、CLI `--task-id` 与恢复记录的键）；
 * 截断后追加身份指纹，保证截断不会把两个不同任务折叠成同一个。
 */
export function retrievalTaskIdOf(identity: RetrievalTaskIdentity): string {
  const pageNo = Math.max(0, Math.trunc(Number(identity.pageNo) || 0))
  const raw = [
    text(identity.projectId), text(identity.planId), text(identity.providerId),
    `p${String(pageNo)}`, text(identity.city), text(identity.keyword),
  ].join('|')
  const safe = raw.replace(/[^0-9A-Za-z_|\u4e00-\u9fff-]/g, '_').slice(0, 96)
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8)
  return `search:${safe}-${digest}`
}

export function valuationMarketSearchTools(deps: ToolDeps, transport?: MarketTransport) {
  /**
   * 抓取通道（**按来源 × 页面任务**建，不是全局一条）。
   *
   * 优先级：测试注入 > 浏览器 runtime > 直连 fetch。
   *
   * 为什么必须按来源分开：浏览器通道把挑战恢复的预算与断点挂在
   * `(providerId, retrievalTaskId)` 上。一条共享的通道会让"链家被打断"和
   * "房天下被打断"共用一个预算，于是第二个来源连一次自动尝试都拿不到。
   *
   * 为什么还要按**页面**分开：预检页与第 1 页检索页是两件不同的事。共用一个任务 id 时，
   * 协调器会复用第一次登记的 URL —— 恢复"检索页"实际上又去访问了预检页。
   *
   * 直连 fetch 是**没有浏览器通道时**的退化路径（v1 行为）：它能取到公开页面，
   * 但遇到可见人机验证只能如实失败 —— 那种情况下 `notes` 会说清是"没有浏览器通道"。
   */
  /**
   * 站点清单坏掉时**以清单问题失败**，不退回直连 fetch。
   *
   * `createValuationBrowserRuntime` 在 `loadBrowserSites` 失败时仍然返回 runtime，
   * 失败信息只在 `sitesError` 里。若这里不看它，取数会拿着一个不存在的 `--sites` 路径去调
   * `crwu browser`，员工看到的是一条 CLI 参数错误 —— 而真正的原因是站点清单没有加载成功。
   *
   * 也**不**退回 `fetchTransport`：那条通道自报 UA 且没有浏览器身份，链家会直接判成非浏览器
   * 流量；用它"兜底"只会制造一个更难解释的失败。
   */
  const sitesFailure = (): ToolFailure | null => {
    const error = text(deps.browserRuntime?.sitesError)
    if (error === '') return null
    return failure('capability-gap', `站点清单加载失败：${error}`)
  }
  const pickTransport = (providerId: string, task: { pageNo: number; keyword: string; city: string; caseRoot: string; projectId: string; planId: string }): MarketTransport => {
    if (transport !== undefined) return transport
    const runtime = deps.browserRuntime
    if (runtime === undefined) return fetchTransport({})
    const ctx = deps.ctx
    return browserTransportForTask(
      {
        client: runtime.toolClient,
        coordinator: runtime.coordinator,
        readPage: async (absolutePath) => await readTextIfExists(ctx, absolutePath),
      },
      {
        // 任务 id 由**项目 / 方案 / 来源 / 页面 / 检索要素**派生：中途被验证打断后，
        // 员工继续的就是这一条（不重建会话、不重传资料），而跨项目查同一个小区不会共用预算。
        retrievalTaskId: retrievalTaskIdOf({
          projectId: task.projectId, planId: task.planId, providerId,
          pageNo: task.pageNo, keyword: task.keyword, city: task.city,
        }),
        providerId,
        caseRoot: task.caseRoot,
        pageDir: PAGE_DIR,
      },
    )
  }

  const search = defineTool({
    name: VALUATION_TOOL_NAMES.marketSearch,
    description: [
      '在房天下 / 安居客 / 链家检索同区域可比案例，把页面里**明确声明**的结构化房源',
      '取回、标准化并落盘到案例目录的 估值案例.json；同时把页面证据存进 来源证据/。',
      `每个分页最多尝试 ${MARKET_ATTEMPTS} 次；两次都失败且登录状态未确认时返回 phase=browser-login-required。`,
      '页面没有结构化数据时返回 0 条 + 能力缺口 —— 绝不按标题猜价格与面积。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      planId: { type: 'string', description: '方案 id：证据与截图落在 方案/<planId>/ 下；缺省落在案例根（finalize 按方案读取会判缺证据）。' },
      requiredCapabilities: {
        type: 'array', items: { type: 'string' },
        description: '知识声明本方案需要的能力 ID（如 market.residential.detail、browser.page.screenshot）：取数前逐项核对，缺一项就阻断。',
      },
      screenshotRequired: { type: 'boolean', description: '显式 false 跳过列表截图；未提供时保留旧任务截图行为。' },
      propertyType: { type: 'string', description: '物业类型（能力门禁的报告用；缺省 residential）。' },
      method: { type: 'string', description: '采用的方法（能力门禁的报告用；缺省 market）。' },
      keyword: { type: 'string', required: true, description: '检索关键字（小区名或地址）。' },
      city: { type: 'string', required: true, description: '城市（站点侧标识，如 beijing / 北京）。' },
      providers: { type: 'array', items: { type: 'string' }, description: '来源 id 清单；缺省全部三家。' },
      startPage: { type: 'integer', description: '本轮开始读取的实际页码，缺省1；继续检索时保留原分组与轮次的累计预算。' },
      maxAttempts: { type: 'integer', description: '每页最多尝试次数，仅1或2；缺省2。模板工作流指定1，故障后由员工显式恢复。' },
      maxPages: {
        type: 'integer',
        description: `本轮最多再翻几页（上限 ${MARKET_PAGE_LIMIT}）。真正的停止判据是 Host 持有的预算`
          + `（同组同轮每来源 ${MARKET_PAGE_LIMIT} 页 / ${MARKET_CANDIDATE_LIMIT} 条，任一触顶即停），`
          + '换词与重试都不重置。',
      },
      group: {
        type: 'string',
        description: '样本分组（按估值对象与样本用途分；出售与租金分开，缺省 sale）。预算按它分账。',
      },
      round: {
        type: 'integer',
        description: '检索轮次（缺省沿用当前轮 = 1）。只有用户要求补搜或换规则时才开新一轮 —— '
          + '换关键字**不算**新一轮，预算继续累计。',
      },
      selection: {
        type: 'object',
        additionalProperties: true,
        description: '本轮的**择优规则**（名额 / 优先级 / 渠道顺序**全部来自知识正文**）：'
          + '{ maxAdopted, order: [{ key }], sourceOrder }。给了就对全部候选做一次批量筛选，'
          + '返回入选、落选（逐条理由）与说明；不改变 cases（相近未达标的候选仍要列给用户按编号选）。'
          + '代码里没有默认名额与默认优先级：缺一项就拒绝，不按"惯例"补。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          casesPath: { type: 'string', required: true, description: `案例清单：${VALUATION_CASES_FILE}` },
          phase: { type: 'string', required: true, description: 'running / browser-login-required / completed' },
          canProceed: { type: 'boolean', required: true, description: 'false = 需要先在默认浏览器登录再继续' },
          keyword: { type: 'string', required: true },
          city: { type: 'string', required: true },
          cases: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                source_label: { type: 'string', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string', required: true },
                community: { type: 'string', required: true },
                purpose: { type: 'string', required: true },
                property_nature: { type: 'string', required: true },
                building_area: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                floor: { type: 'string', required: true },
                total_floors: { type: 'string', required: true },
                built_year: { type: 'string', required: true },
                decoration: { type: 'string', required: true },
                price: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                unit_price: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                transaction_type: { type: 'string', required: true, description: '挂牌 / 成交 / 询价 / 未知' },
                published_at: { type: 'string', required: true },
                captured_at: { type: 'string', required: true },
                evidence: { type: 'string', required: true, description: '页面证据（相对案例目录）' },
                evidence_missing: { type: 'boolean', required: true, description: 'true = 这条案例没有留存页面证据，不得直接当可比实例' },
                screenshot: { type: 'string', required: true, description: '页面截图（相对案例目录）；没有截图能力或截图失败时为空串' },
                screenshot_digest: { type: 'string', required: true, description: '截图内容指纹；没有时为空串' },
                screenshot_captured_at: { type: 'string', required: true, description: '截图采集时刻（ISO）；没有时为空串' },
                screenshot_missing: { type: 'boolean', required: true, description: 'true = 这条案例没有截图（与 evidence_missing 同一条纪律）' },
                keep_reason: { type: 'string', required: true },
                drop_reason: { type: 'string', required: true },
                notes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          counts: { type: 'object', required: true, additionalProperties: true },
          dedupedAway: { type: 'integer', required: true, description: '跨站去重合并掉的条数' },
          selection: {
            type: 'object', required: true,
            description: '批量筛选与优选结果（没给择优规则时 present=false；cases 不变）',
            additionalProperties: false,
            properties: {
              present: { type: 'boolean', required: true },
              error: { type: 'string', required: true },
              maxAdopted: { type: 'integer', required: true, description: '本轮名额（由知识声明）' },
              order: { type: 'array', required: true, items: { type: 'string' }, description: '优先级顺序（由知识声明）' },
              adopted: { type: 'array', required: true, items: { type: 'string' }, description: '入选案例的 URL' },
              rejected: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    reason: { type: 'string', required: true, description: '落选理由（硬性排除 / 名次与名额）' },
                  },
                },
              },
              notes: { type: 'array', required: true, items: { type: 'string' } },
              assessments: {
                type: 'array', required: true,
                description: '本轮知识评估（url / status / reason / knowledgeRef）：采用与否只能由它加事实门禁决定',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    status: { type: 'string', required: true, description: 'qualified / near-miss / excluded' },
                    reason: { type: 'string', required: true },
                    knowledgeRef: { type: 'string', required: true, description: '知识正文出处（非空），不是默认值' },
                  },
                },
              },
            },
          },
          cityStatus: {
            type: 'string', required: true,
            description: '业务城市解析结论：resolved / not-covered（公布列表里没有）/ invalid / unavailable。'
              + '逐来源能不能用看 providers[].cityStatus —— "该来源不覆盖"不等于"输入非法"。',
          },
          cityCode: { type: 'string', required: true, description: '解析出的站点城市标识（进 URL 的那个）' },
          cityCandidates: {
            type: 'array', required: true, items: { type: 'string' },
            description: '解析不出来时的候选（名称=标识），按它改提业务城市',
          },
          cityPage: { type: 'string', required: true, description: '解析依据的站点城市页' },
          providers: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                login: { type: 'string', required: true },
                fetchedPages: { type: 'integer', required: true },
                failedPages: { type: 'integer', required: true },
                caseCount: { type: 'integer', required: true },
                attemptLimit: { type: 'integer', required: true },
                detail: { type: 'string', required: true },
                urls: { type: 'array', required: true, items: { type: 'string' } },
                notes: { type: 'array', required: true, items: { type: 'string' } },
                retrievalTaskId: { type: 'string', required: true, description: '本来源要恢复的页面任务；没有待处理失败时为空串' },
                retrievalTasks: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      providerId: { type: 'string', required: true },
                      pageNo: { type: 'integer', required: true },
                      url: { type: 'string', required: true },
                      retrievalTaskId: { type: 'string', required: true },
                      state: { type: 'string', required: true, description: 'fetched / failed' },
                    },
                  },
                },
                nextAction: { type: 'string', required: true, description: '本来源下一步动作；不需要人工动作时为空串' },
                evidence: {
                  type: 'string', required: true,
                  description: '该来源适配器的依据：archived-capture（有归档真实字节）/ '
                    + 'public-pattern（只有公开路径约定，尚未真机验收）',
                },
                cityStatus: {
                  type: 'string', required: true,
                  description: '该来源的城市解析结果：resolved / not-covered（该来源不覆盖这个地区）/ unresolved / invalid',
                },
                cityReason: { type: 'string', required: true, description: '城市解析的原因；resolved 时为空串' },
                citySourcePage: {
                  type: 'string', required: true,
                  description: '该来源的城市表页（resolved 时为空串）：报告要能说明"这个城市标识是哪来的"',
                },
                citySourceEvidence: {
                  type: 'string', required: true,
                  description: '城市表的依据：archived-capture（有归档字节）/ public-pattern（尚未适配）/ 空串',
                },
                budget: {
                  type: 'object', required: true,
                  description: '该来源在本分组本轮的预算账（Host 持久；换词 / 重试 / 验证恢复都不重置）',
                  additionalProperties: false,
                  properties: {
                    pagesUsed: { type: 'integer', required: true },
                    candidatesUsed: { type: 'integer', required: true },
                    pageLimit: { type: 'integer', required: true },
                    candidateLimit: { type: 'integer', required: true },
                    stoppedBy: { type: 'string', required: true, description: "'' / 'page-limit' / 'candidate-limit'" },
                    reason: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          needsLogin: { type: 'array', required: true, items: { type: 'string' } },
          unconfirmed: { type: 'array', required: true, items: { type: 'string' } },
          retrievalTaskId: { type: 'string', required: true, description: '本轮要继续的取数任务（等待人工处理后恢复）；没有则为空串' },
          retrievalTasks: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                providerId: { type: 'string', required: true },
                pageNo: { type: 'integer', required: true },
                url: { type: 'string', required: true },
                retrievalTaskId: { type: 'string', required: true },
                state: { type: 'string', required: true, description: 'fetched / failed' },
              },
            },
          },
          nextActions: { type: 'array', required: true, items: { type: 'string' } },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: SearchArgs, exec): Promise<SearchResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()
      if (args.maxAttempts !== undefined && args.maxAttempts !== 1 && args.maxAttempts !== MARKET_ATTEMPTS) return { ...base, ...failure('input', 'maxAttempts 必须是1或2') }
      const attemptLimit = args.maxAttempts === 1 ? 1 : MARKET_ATTEMPTS
      if (args.startPage !== undefined && (typeof args.startPage !== 'number' || !Number.isSafeInteger(args.startPage) || args.startPage < 1 || args.startPage > MARKET_PAGE_LIMIT)) return { ...base, ...failure('input', 'startPage 必须是技术页数上限内的正整数') }
      const keyword = text(args.keyword).trim()
      const city = text(args.city).trim()
      if (keyword === '' || city === '') {
        return { ...base, ...failure('input', 'keyword 与 city 都必须给出：检索需要明确的区域与对象') }
      }
      // 清单坏掉时**先于任何页面访问**失败：下面的 `resolveBusinessCity` 就会发请求。
      const blocked = sitesFailure()
      if (blocked !== null) return { ...base, ...blocked }
      // Validate the selection rule before any I/O (city resolution may network).
      const earlySelection = args.selection === undefined || args.selection === null
        ? null
        : normalizeSelectionRule(args.selection)
      if (earlySelection !== null && !earlySelection.ok) {
        return { ...base, ...failure('input', earlySelection.error) }
      }
      // 授权门禁（协议 18 同一条口径）：未授权时**一个外部请求都不发**。
      // 它必须先于城市解析 —— 城市解析本身就会发请求。
      if (!credentialsTrusted(deps)) {
        return { ...base, ...failure('policy', '尚未在本机访问授权里允许工作台访问本机能力：请在面板授权后再检索外部案例。') }
      }
      // 城市标识由**适配器**解析，而不是要求模型猜 `bj` / `beijing`（P7）。
      // 映射从站点自己公布的**城市页**派生（进程内缓存）；解析不出来就如实拒绝并给候选，
      // 绝不默认北京 —— 猜错城市等于在错的房源池里选可比案例。
      // **各来源独立解析地区**（协议 39）：一次解析结果 + 逐来源的状态判定。
      //
      // 旧行为是"解析不出来就整个调用失败（input）" —— 那会把"链家不做这个地区"写成
      // "你的输入非法"，于是替代来源（安居客 / 房天下）根本没机会跑。
      // 现在：解析不出来只让**受影响的那些来源**不可用，逐来源记状态与原因，其余照常。
      // City resolution is deferred until AFTER local validation and the scoped ledger read:
      // the ledger may already hold verified resolver facts, and a rejected caller/provider/plan
      // must not trigger any city network. Ledger reading does not need the resolved code.
      type CityResolutionFacts = Awaited<ReturnType<typeof resolveBusinessCity>>
      let cityResolved: CityResolutionFacts = {
        status: 'invalid', ok: false, input: city, code: '', via: '',
        reason: '城市尚未解析', candidates: [], page: '',
      }
      let siteCity = ''
      const cityFor = (providerId: string) => providerCityStatus(cityResolved, providerId)

      const picked = narrowProviders(args.providers)
      if (!picked.ok) return { ...base, ...failure('input', picked.error) }

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：案例检索只能在估值子会话里进行') }
      }
      const caseDir = access.casePath
      // 证据 / 截图 / 案例清单按**方案**隔离：写进别的方案的目录等于让 finalize 读到不属于它的证据。
      const planId = text(args.planId).trim()
      const planRelative = planId === '' ? '' : planDirRelative(planId)
      if (planId !== '' && planRelative === '') {
        return { ...base, ...failure('input', `planId 不是单段安全标识：「${planId}」`) }
      }
      const planRoot = planRelative === '' ? caseDir : joinLocalPath(caseDir, planRelative)
      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }

      // 缺省只翻 **1** 页：翻页是"再调一次工具"的决定，不是一次调用就把配额吃满。
      // 累计口径由 Host 的持久预算回答（同组同轮 10 页 / 20 条，任一触顶即停）。
      const requestedPages = typeof args.maxPages === 'number' && Number.isFinite(args.maxPages)
        ? Math.max(1, Math.min(Math.trunc(args.maxPages), MARKET_PAGE_LIMIT))
        : 1

      const startPage = typeof args.startPage === 'number' ? args.startPage : 1
      const endPage = Math.min(MARKET_PAGE_LIMIT, startPage + requestedPages - 1)

      // 项目归属只从 Host 的 scope 取（模型提交不了它）：取数任务的预算与断点挂在它上面。
      const valuationScope = deps.valuationScopes?.scopeOf(callerIdentity(exec).childId)
      const projectId = text(valuationScope?.projectId) || text(valuationScope?.valuationId) || basenameLocalPath(caseDir)

      // URL 模板吃的是**站点城市标识**；任务身份仍按业务城市算（模型重提同一个城市 → 同一个断点）。
      const providerFor = (id: string, pageNo: number) =>
        allProviders({
          transport: pickTransport(id, { pageNo, keyword, city: siteCity, caseRoot: planRoot, projectId, planId }),
        }).find((provider) => provider.id === id)
      const taskIdOf = (providerId: string, pageNo: number): string =>
        retrievalTaskIdOf({ projectId, planId, providerId, pageNo, keyword, city })

      // **能力门禁：在任何网络请求之前**。
      // 方法正文声明的能力（截图、详情、参数读取…）必须逐项在**真实注册表 + 真实适配器 +
      // 这一轮的来源状态**上核对通过。缺席的能力在这里变成阻断，而不是"抓到一半才发现工具不存在"。
      const declared = Array.isArray(args.requiredCapabilities)
        ? args.requiredCapabilities.map((item) => text(item)).filter((item) => item !== '')
        : []
      const demand: PlanCapabilityDemand = {
        projectId: text(valuationScope?.projectId) || text(valuationScope?.valuationId),
        planId,
        propertyType: (text(args.propertyType) || 'residential') as PlanCapabilityDemand['propertyType'],
        valuationPath: 'combined',
        method: text(args.method) || 'market',
        capabilityIds: declared,
        // 门禁**按知识声明的 ID** 逐项核对（设计稿 §8.1）：没声明就没有要核对的项。
        // 本工具自身的存在性由注册表保证（不注册就调不到），不在这里重复判。
        requiredCapabilities: [],
        screenshotRequired: args.screenshotRequired === true,
      }
      const gate = checkMethodCapabilities(
        {
          planId, title: '', propertyType: text(demand.propertyType) as never, objectIds: [], methodRequest: 'market',
          methodAssessment: null, baseDate: null, valuationPath: 'combined', groupReason: '',
          groupEvidenceRefs: [], conflicts: [], status: 'ready-for-retrieval',
        },
        demand,
        (await capabilityFactsOf({
          ctx, deps, agent: exec.agent, valuationId: text(valuationScope?.valuationId),
        })).facts,
      )
      // 缺口分两类：
      // - **工具 / 适配器缺席** → 现在就必须阻断（继续跑只会"抓到一半才发现工具不存在"）；
      // - **来源尚未确认登录** → 不在门禁里硬判：本工具紧接着会逐来源探测公开检索页，
      //   由 `decidePhase` 给出可恢复的 `browser-login-required`。在门禁里硬判会让
      //   "面板门禁还没跑过"变成"永远不能取数"，而那条路径本来就能自愈。
      const providerOnly = (reasons: readonly string[]): boolean =>
        reasons.length > 0 && reasons.every((reason) => reason.includes('来源「'))
      const hardMisses = gate.missing.filter((row) => !providerOnly(row.reasons))
      const softMisses = gate.missing.filter((row) => providerOnly(row.reasons))
      if (hardMisses.length > 0) {
        return {
          ...base,
          ...failure('capability-gap',
            `取数之前的能力门禁没有通过：${hardMisses.map((row) => `${row.label}（${row.reasons.join('；')}）`).join('；')}`),
          caseDir,
          capabilityGaps: hardMisses.map((row) => `${row.id}: ${row.reasons.join('；')}`),
        }
      }
      const gateNotes = [
        ...softMisses.map((row) => `来源尚未确认：${row.label}（${row.reasons.join('；')}）—— 由本工具的逐来源预检现场判定`),
        ...(gate.degradable.length === 0 ? [] : [`降级能力（不影响本轮取数）：${gate.degradable.join('、')}`]),
      ]

      // **派生目录：在 fetch / shot / dump 之前幂等创建**。
      //
      // 为什么必须在写之前：`crwu browser fetch --out/--dump` 是**另一个进程**在用
      // `os.WriteFile` 落盘，它不会替我们建父目录 —— 首次运行时 `来源证据/页面/` 不存在，
      // 结果是 `ENOENT`，而那个报错会被当成"页面取不到"，一路走到登录/验证码的处置上。
      // 所以目录准备**不放进重试循环**，失败时单独归类（`file`），绝不按登录/验证码重试。
      const platform = await deps.world.platform()
      const workdir = await deps.world.workdir()
      // 方案目录本身也要建：`估值案例.json` 直接写在它下面（首次运行时它还不存在）。
      const derivedDirs = [
        planRoot,
        joinLocalPath(planRoot, EVIDENCE_DIR),
        joinLocalPath(planRoot, PAGE_DIR),
        joinLocalPath(planRoot, SNAPSHOT_DIR),
        joinLocalPath(planRoot, `${SNAPSHOT_DIR}/pages`),
      ]
      for (const dir of derivedDirs) {
        const made = await ensureDirectory(deps.access, dir, { workdir, platform, ...writeOptions })
        if (!made.ok) {
          return {
            ...base,
            ...failure('file', `派生目录创建失败：${made.error}（${dir}）`
              + ' —— 这是文件 / 目录错误，不是网站登录或验证码问题：'
              + '不要按登录重试，先修正目录权限或工作空间再重新检索。'),
            caseDir,
          }
        }
      }

      const reports: ProviderReport[] = []
      const runs: ProviderRun[] = []
      const cases: ValuationCase[] = []
      const gaps: string[] = [...gateNotes]
      const retrievalTasks: RetrievalTaskReport[] = []
      const nextActions: string[] = []
      // 有注入的截图通道时不再报"没有截图能力"：那会变成一句与事实相反的固定文案。
      const warnings: string[] = deps.screenshot === undefined ? [SCREENSHOT_GAP] : []
      // ── 检索预算（协议 39 / §5.2）：Host 持有并持久，换词 / 重试 / 恢复都不重置 ──
      //
      // 键里**没有关键字、没有页码、没有尝试次数**：所以"换个词再翻一遍"读到的是同一份账。
      // 分组按估值对象与样本用途分（出售与租金分开），轮次只在用户要求补搜 / 换规则时才 +1。
      const sampleGroup = text(args.group).trim() || 'sale'
      const requestedRound = typeof args.round === 'number' && Number.isFinite(args.round)
        ? Math.max(1, Math.trunc(args.round))
        : 1
      const budgetPath = joinLocalPath(planRoot, BUDGET_FILE)
      // Typed durable read: missing / readable / error. `readTextIfExists` swallows read errors,
      // which would make inaccessible durable data look fresh.
      const durableRead = async (path: string): Promise<{ state: 'missing' | 'readable' | 'error'; text: string; error: string }> => {
        const fs = fileSystem(ctx)
        if (fs === undefined) return { state: 'error', text: '', error: 'Host 文件服务不可用' }
        let info: unknown
        try {
          info = await fs.stat(await fs.resolve(path))
        } catch (error) {
          return { state: 'error', text: '', error: String(error) }
        }
        if (info === undefined) return { state: 'missing', text: '', error: '' }
        try {
          return { state: 'readable', text: await fs.readText(await fs.resolve(path)), error: '' }
        } catch (error) {
          return { state: 'error', text: '', error: String(error) }
        }
      }
      const budgetRead = await durableRead(budgetPath)
      if (budgetRead.state === 'error') {
        return {
          ...base, ...failure('file', `取数预算读取失败（${budgetRead.error}）：请人工修复（不得重置预算）`),
          caseDir,
        }
      }
      const storedBudget = budgetRead.state === 'readable' ? budgetRead.text : ''
      let budget: MarketBudget = emptyBudget({
        projectId, planId, group: sampleGroup, round: requestedRound, city,
        updatedAt: new Date().toISOString(),
      })
      if (storedBudget.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(storedBudget)
        } catch (error) {
          // A corrupted mirror must block explicitly; silently starting a new account would
          // re-spend the whole budget.
          return {
            ...base, ...failure('file',
              `取数预算读不出来（JSON 非法）：${error instanceof Error ? error.message : String(error)}`
              + '：请人工核对或删除后再试（不得按新账重算）'),
            caseDir,
          }
        }
        const previous = budgetFromJson(parsed)
        if (previous !== null && budgetMatches(previous, {
          projectId, planId, group: sampleGroup, round: requestedRound, city,
        })) {
          budget = previous
        } else if (previous !== null) {
          // 分组 / 轮次 / 方案 / 城市不同：**不复用**旧账（那会把别的对象的预算算进来），
          // 但如实说清换了一份账。
          warnings.push(`本轮的分组 / 轮次 / 方案 / 城市与已有的${BUDGET_FILE}不同（已有 `
            + `${previous.planId || '未记录'} / ${previous.group} / 第 ${String(previous.round)} 轮）：`
            + '按新的账本计预算。')
        } else {
          return {
            ...base, ...failure('file',
              `取数预算结构不认识：请人工核对或删除后再试（不得按新账重算）`),
            caseDir,
          }
        }
      }
      if (planId === '') {
        warnings.push('没有给 planId：证据、截图与案例清单写在案例根下。finalize 按方案目录读取时'
          + '会把它们算作"这个方案没有证据"，所以只应在临时诊断时省略。')
      }

      // ── Durable list snapshots + cumulative ledger (protocol 40) ─────────────
      const scope: ListScope = { projectId, planId, group: sampleGroup, round: requestedRound, city }
      const ledgerDir = joinLocalPath(planRoot, SNAPSHOT_DIR)
      const pagesDir = joinLocalPath(planRoot, `${SNAPSHOT_DIR}/pages`)
      const ledgerPath = joinLocalPath(ledgerDir, `${scopeKeyOf(scope)}.json`)
      const ledgerRead = await durableRead(ledgerPath)
      if (ledgerRead.state === 'error') {
        return {
          ...base, ...failure('file',
            `列表台账无法读取（${ledgerRead.error}）：请人工修复（不得静默重置）`),
          caseDir,
        }
      }
      const storedLedger = ledgerRead.state === 'readable' ? ledgerRead.text : ''
      let ledgerRows: unknown[] = []
      let ledgerBudget: MarketBudget | undefined
      let ledgerPages: Record<string, ListPageSnapshot> = {}
      let ledgerCityResolution: CityResolutionFacts | undefined
      if (storedLedger.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(storedLedger)
        } catch (error) {
          return {
            ...base, ...failure('file',
              `列表台账读不出来（JSON 非法）：${error instanceof Error ? error.message : String(error)}`
              + '：请人工修复或删除后再试（不得静默重置）'),
            caseDir,
          }
        }
        const ledger = parseListLedger(parsed, scope)
        if (ledger === null) {
          return { ...base, ...failure('file', '列表台账结构/身份不匹配：请人工核对，不得静默重置'), caseDir }
        }
        ledgerRows = ledger.rows
        ledgerBudget = ledger.budget
        ledgerPages = { ...(ledger.pages ?? {}) }
        ledgerCityResolution = ledger.cityResolution
      }
      // Canonical ledger owns the per-scope budget; the single 取数预算.json file is only a
      // compatibility mirror, so switching scopes must not reset this scope's budget.
      if (ledgerBudget !== undefined) {
        budget = ledgerBudget
      } else if (storedLedger.trim() !== '' && !budgetMatches(budget, {
        projectId, planId, group: sampleGroup, round: requestedRound, city,
      })) {
        // Old beta ledger without a budget and a mirror that is not this scope: never start
        // this scope from zero (that would silently re-spend the whole budget).
        return {
          ...base, ...failure('file',
            '列表台账缺少预算（旧版格式），且现有 取数预算.json 不属于本分组 / 轮次：'
            + '请人工核对或删除旧台账后再试（不得从零重算预算）'),
          caseDir,
        }
      }
      const priorLedgerRows = [...ledgerRows]
      let persistenceFailure = ''
      const rowUrlOf = (row: unknown): string => text((row as { url?: unknown } | null)?.url)
      const assessmentByUrl = new Map(
        (earlySelection?.rule?.assessments ?? []).map((item) => [item.url, item]),
      )
      const qualifiedFingerprintOf = (item: ValuationCase): string => {
        const assessment = assessmentByUrl.get(item.url)
        if (assessment === undefined || assessment.status !== 'qualified') return ''
        if (hardExclusionOf(item) !== '') return ''
        // Strong identity: canonical URL, never weak community/area/price facts.
        return canonicalListingUrl(item.url) || text(item.url)
      }
      const persistLedger = async (): Promise<boolean> => {
        const doc: ListLedger = {
          schemaVersion: LIST_LEDGER_SCHEMA, scope, city,
          updatedAt: new Date().toISOString(), rows: ledgerRows,
          budget,
          ...(Object.keys(ledgerPages).length === 0 ? {} : { pages: ledgerPages }),
          ...(ledgerCityResolution === undefined ? {} : { cityResolution: ledgerCityResolution }),
        }
        const expected = canonicalJson(doc)
        const written = await writeCaseText(ctx, ledgerPath, expected, writeOptions)
        if (!written.ok) {
          persistenceFailure = `列表台账没能落盘（${written.error}）：环境写入失败，已停止继续取数`
          return false
        }
        const readback = await durableRead(ledgerPath)
        if (readback.state !== 'readable' || readback.text !== expected) {
          persistenceFailure = '列表台账回读与写入不一致：环境写入失败，已停止继续取数'
          return false
        }
        return true
      }
      const pageSnapshotPathOf = (providerId: string, pageNo: number): { taskId: string; path: string } => {
        // Scope identity includes group/round/business city so a different scope never replays stale pages.
        const taskId = `${taskIdOf(providerId, pageNo)}|g:${sampleGroup}|r:${String(requestedRound)}|c:${city}`
        return { taskId, path: joinLocalPath(pagesDir, `${pageKeyOf({ providerId, taskId })}.json`) }
      }

      // Resolve the city only now that local validation + the scoped ledger read are done, and
      // reuse verified persisted facts when the input city matches.
      if (ledgerCityResolution !== undefined && text(ledgerCityResolution.input) === city) {
        cityResolved = ledgerCityResolution
      } else {
        cityResolved = await resolveBusinessCity(city, { transport: transport ?? fetchTransport({}) })
        if (cityResolved.status === 'resolved' && cityResolved.ok && cityResolved.code !== '') {
          ledgerCityResolution = cityResolved
          if (!(await persistLedger())) {
            return { ...base, ...failure('file', persistenceFailure || '列表台账落盘失败'), caseDir }
          }
        }
      }
      siteCity = cityResolved.status === 'resolved' ? cityResolved.code : ''

      providerLoop: for (const id of picked.ids) {
        // **逐来源的城市可用性**：不可用的来源不发任何请求，逐条如实记状态与原因。
        const cityState = cityFor(id)
        if (cityState.status !== 'ok') {
          const label = providerLabel(id as MarketProviderId)
          // **不覆盖**与**还没适配**必须分开说：混同会让员工以为这家不做这个地区。
          const gap = cityState.status === 'not-covered'
            ? `${label}：**该来源不覆盖**「${cityResolved.input}」这个地区 —— ${cityState.reason}`
              + '本轮跳过这一家，继续其他来源；若确有该地区，请在入口 Wiki 的渠道说明里更新来源顺序。'
            : `${label}：**这个来源的城市表还没适配**（能力缺口，不是"该来源不覆盖这个地区"）—— `
              + cityState.reason
          gaps.push(gap)
          reports.push({
            id, label, login: 'unknown', fetchedPages: 0, failedPages: 0, caseCount: 0,
            attemptLimit, detail: cityState.reason, urls: [], notes: [cityState.reason],
            retrievalTaskId: '', retrievalTasks: [], nextAction: '',
            evidence: siteOf(id as MarketProviderId).evidence,
            cityStatus: cityState.status === 'not-covered' ? 'not-covered' : 'unresolved',
            cityReason: cityState.reason,
            citySourcePage: cityState.sourcePage,
            citySourceEvidence: cityState.evidence,
            budget: {
              pagesUsed: 0, candidatesUsed: 0,
              pageLimit: MARKET_PAGE_LIMIT, candidateLimit: MARKET_CANDIDATE_LIMIT,
              stoppedBy: '', reason: '',
            },
          })
          if (cityState.status === 'not-covered' || cityState.status === 'unsupported') {
            const action = `改用其他来源，或提交${label}自己的城市标识（例如 bj）后重试；**不要**擅自换城市。`
            if (!nextActions.includes(action)) nextActions.push(action)
          }
          continue
        }
        // 预检是**独立页面任务**（`pageNo: 0`）：与检索页共用任务 id 会让恢复救错页面。
        const provider = providerFor(id, 0)
        if (provider === undefined) continue
        const urls: string[] = []
        const notes: string[] = []
        const providerTasks: RetrievalTaskReport[] = []
        let fetchedPages = 0
        let failedPages = 0
        // 解析通道的失败类别要**分开记**：`template-stale`（站点改版）与 `no-results`
        //（确实没有房源）指向完全不同的下一步动作。
        const parseFailures: string[] = []

        // Replay known successful pages BEFORE budget limits or preflight network.
        const cachedPages = new Map<number, ListPageSnapshot>()
        let snapshotProblem = ''
        for (let pageNo = startPage; pageNo <= endPage; pageNo += 1) {
          const { taskId, path } = pageSnapshotPathOf(provider.id, pageNo)
          const mirrorRead = await durableRead(path)
          if (mirrorRead.state === 'error') {
            snapshotProblem = `${providerLabel(provider.id)} 第 ${pageNo} 页列表快照无法读取：请人工修复（不得静默重取）`
            break
          }
          let snapshot: ListPageSnapshot | null = null
          if (mirrorRead.state === 'readable' && mirrorRead.text.trim() !== '') {
            let parsed: unknown
            try {
              parsed = JSON.parse(mirrorRead.text)
            } catch {
              snapshotProblem = `${providerLabel(provider.id)} 第 ${pageNo} 页列表快照无法解析：请人工修复或删除后再试（不得静默重取）`
              break
            }
            snapshot = parseListPageSnapshot(parsed, { providerId: provider.id, taskId })
            if (snapshot === null) {
              snapshotProblem = `${providerLabel(provider.id)} 第 ${pageNo} 页列表快照身份/结构不匹配：请人工核对（不得静默重取）`
              break
            }
          } else {
            // Mirror missing: restore it locally from the canonical ledger page (no browser).
            snapshot = ledgerPages[taskId] ?? null
            if (snapshot === null) continue
            const rebuilt = await writeCaseText(ctx, path, canonicalJson(snapshot), writeOptions)
            const verify = rebuilt.ok ? await durableRead(path) : { state: 'error' as const, text: '', error: rebuilt.error }
            if (!rebuilt.ok || verify.state !== 'readable' || verify.text !== canonicalJson(snapshot)) {
              snapshotProblem = `${providerLabel(provider.id)} 第 ${pageNo} 页列表快照从台账恢复失败：请人工修复（不得静默重取）`
              break
            }
          }
          const evidenceRead = await durableRead(joinLocalPath(planRoot, snapshot.evidenceFile))
          if (evidenceRead.state !== 'readable' || evidenceRead.text.trim() === '') {
            snapshotProblem = `${providerLabel(provider.id)} 第 ${pageNo} 页列表快照的证据已不可读：请人工修复（不得静默重取）`
            break
          }
          const recomputed = `sha256:${createHash('sha256').update(evidenceRead.text, 'utf8').digest('hex')}`
          if (text(snapshot.evidenceDigest) !== '' && recomputed !== text(snapshot.evidenceDigest)) {
            snapshotProblem = `${providerLabel(provider.id)} 第 ${pageNo} 页列表快照的证据字节已变化（指纹不符）：`
              + '请人工核对（不得静默重取）'
            break
          }
          cachedPages.set(pageNo, snapshot)
        }
        if (snapshotProblem !== '') {
          return { ...base, ...failure('file', snapshotProblem), caseDir }
        }
        const fullyCached = cachedPages.size >= endPage - startPage + 1
        const verdict = fullyCached
          ? { state: 'unknown' as const, detail: '本轮全部命中已成功落盘的列表快照：未访问站点，登录状态未重新探测' }
          : await provider.preflight()

        // 本来源的预算账（Host 持久；换词 / 重试 / 恢复都不重置）。
        let allowance = pageAllowanceOf(budget, provider.id)
        let stoppedBy = ''
        let stopReason = ''

        for (let pageNo = startPage; pageNo <= endPage; pageNo += 1) {
          const retrievalTaskId = taskIdOf(provider.id, pageNo)

          // Replay: no budget page increment, no transport, no screenshot.
          const cached = cachedPages.get(pageNo)
          if (cached !== undefined) {
            const items = cached.rows.map((row) => caseFromJson(row as SearchCase))
            notes.push(`第 ${pageNo} 页命中已成功落盘的列表快照：未访问站点`)
            urls.push(cached.url)
            const cachedEntry: RetrievalTaskReport = {
              providerId: provider.id, pageNo, url: cached.url, retrievalTaskId, state: 'fetched',
            }
            providerTasks.push(cachedEntry)
            retrievalTasks.push(cachedEntry)
            for (const item of items) cases.push(item)
            ledgerRows = unionRows(ledgerRows, cached.rows, rowUrlOf)
            const cachedQualified = items.map(qualifiedFingerprintOf).filter((item) => item !== '')
            budget = recordQualified(budget, provider.id, cachedQualified, new Date().toISOString()).budget
            if (!(await persistLedger())) break providerLoop
            const cachedBudget = await writeCaseText(ctx, budgetPath, canonicalJson({
              ...budget, updatedAt: budget.updatedAt,
            }), writeOptions)
            if (!cachedBudget.ok) {
              persistenceFailure = `检索预算镜像没能落盘（${cachedBudget.error}）：环境写入失败，已停止继续取数`
              break
            }
            continue
          }

          // **触顶即停**：页数或候选数任一到达上限就不再发请求。
          // 预算不是目标：足够支持选组时本来也该提前停，所以这里只做"不许超"。
          allowance = pageAllowanceOf(budget, provider.id)
          if (!allowance.allowed) {
            stoppedBy = allowance.stoppedBy
            stopReason = allowance.reason
            notes.push(allowance.reason)
            break
          }
          // 每一页有**自己的**取数任务：恢复的是被打断的那一页，不是"这个来源的某一页"。
          const pageProvider = providerFor(provider.id, pageNo) ?? provider
          const outcome = await withAttempts(async () => await pageProvider.searchPage(
            { keyword, city: siteCity, maxPages: requestedPages }, pageNo, signal,
          ), {
            attempts: attemptLimit,
            onFailure: (attempt, error) => { notes.push(`第 ${pageNo} 页第 ${attempt} 次失败：${error}`) },
          })
          if (!outcome.ok) {
            failedPages += 1
            const entry: RetrievalTaskReport = {
              providerId: provider.id, pageNo, url: '', retrievalTaskId, state: 'failed',
            }
            providerTasks.push(entry)
            retrievalTasks.push(entry)
            continue
          }
          fetchedPages += 1
          const fetched = outcome.value
          notes.push(...(fetched?.notes ?? []))
          const raw: RawListing[] = fetched?.raw ?? []
          if (text(fetched?.failureKind) !== '') parseFailures.push(text(fetched?.failureKind))
          const pageUrl = text(fetched?.url) || `${provider.id}#page-${pageNo}`
          urls.push(pageUrl)
          const entry: RetrievalTaskReport = {
            providerId: provider.id, pageNo, url: pageUrl, retrievalTaskId, state: 'fetched',
          }
          providerTasks.push(entry)
          retrievalTasks.push(entry)
          // 每一页都留证据：案例链接会过期，页面字节才是本轮取数的凭据。
          const evidence = await saveEvidence({
            ctx, casePath: planRoot, source: provider.id, url: pageUrl,
            body: text(fetched?.body), status: fetched?.status ?? 0, ...writeOptions,
          })
          if (!evidence.ok) {
            gaps.push(`${providerLabel(provider.id)}：第 ${pageNo} 页证据没能留存（${evidence.error}）`
              + ' —— 该页案例已标记 `evidence_missing`，**不得**直接当可比实例使用')
          }
          // **页面级截图**（§7.4）：每成功列表页一次，图里是这一页的列表，供该页每条引用；
          // 它不是逐套房源的详情页证据，不能当成交证明。正常取数不抢前台。
          const shot: ValuationScreenshotResult = args.screenshotRequired === false ? { ok: false, error: '本轮列表不要求截图', file: '', digest: '', bytes: 0, capturedAt: '' } : await captureScreenshot(
            deps.screenshot,
            {
              url: pageUrl, casePath: planRoot, source: provider.id,
              caseId: `${provider.id}-${String(pageNo)}-page`,
              ...(session === undefined ? {} : { session }),
              ...(signal === undefined ? {} : { signal }),
            },
            async (file) => await evidenceExists(ctx, planRoot, file),
          )
          if (args.screenshotRequired !== false && !shot.ok && deps.screenshot !== undefined) {
            gaps.push(`${providerLabel(provider.id)} 第 ${pageNo} 页列表截图未成功`
              + `（${shot.error}）：该页案例已标 \`screenshot_missing\`，不得当作已取证`)
          }
          const pageItems: ValuationCase[] = []
          for (const listing of raw) {
            const item = normalizeCase(listing)
            // 案例指向**本页**的证据文件：那是它被读到的出处。
            if (evidence.ok) item.evidence = evidence.file
            if (shot.ok) {
              item.screenshot = shot.file
              item.screenshotDigest = shot.digest
              item.screenshotCapturedAt = shot.capturedAt
            }
            item.notes = [
              ...item.notes,
              `页面截图对应列表页 ${pageUrl}`,
              `本行定位：标题「${item.title}」链接 ${item.url}`,
            ]
            pageItems.push(item)
            cases.push(item)
          }
          const pageRows = pageItems.map(caseToJson)
          // Build the canonical page snapshot first so the ledger commit owns the full page.
          const pageRef = pageSnapshotPathOf(provider.id, pageNo)
          const snapshot: ListPageSnapshot | null = (evidence.ok && pageRows.length > 0)
            ? {
              schemaVersion: LIST_PAGE_SCHEMA, providerId: provider.id, taskId: pageRef.taskId,
              pageNo, url: pageUrl, capturedAt: new Date().toISOString(),
              evidenceFile: evidence.file, evidenceDigest: evidence.digest, rows: pageRows,
            }
            : null
          ledgerRows = unionRows(ledgerRows, pageRows, rowUrlOf)
          if (snapshot !== null) ledgerPages[pageRef.taskId] = snapshot
          // Compute the new page budget first, then commit the canonical ledger (rows + pages +
          // budget) before any derived mirror; a write failure stops further browsing.
          const qualified = pageItems.map(qualifiedFingerprintOf).filter((item) => item !== '')
          budget = recordPage(budget, provider.id, qualified, new Date().toISOString()).budget
          if (!(await persistLedger())) break providerLoop
          // Derived page JSON mirror; the canonical ledger already owns the snapshot.
          if (snapshot !== null) {
            const writtenSnapshot = await writeCaseText(ctx, pageRef.path, canonicalJson(snapshot), writeOptions)
            if (!writtenSnapshot.ok) {
              persistenceFailure = `列表快照没能落盘（${writtenSnapshot.error}）：环境写入失败，已停止继续取数`
              break
            }
          }
          const persisted = await writeCaseText(ctx, budgetPath, canonicalJson({
            ...budget, updatedAt: budget.updatedAt,
          }), writeOptions)
          if (!persisted.ok) {
            persistenceFailure = `检索预算镜像没能落盘（${persisted.error}）：环境写入失败，已停止继续取数`
            break
          }
        }

        const finalAllowance = pageAllowanceOf(budget, provider.id)
        if (stoppedBy === '' && !finalAllowance.allowed) {
          stoppedBy = finalAllowance.stoppedBy
          stopReason = finalAllowance.reason
        }
        if (stoppedBy !== '') {
          gaps.push(`${providerLabel(provider.id)}：本轮检索预算触顶（${stoppedBy}）—— ${stopReason}`)
        }

        const site = siteOf(provider.id)
        if (site.evidence === 'public-pattern') {
          // **没验收就说没验收**：可以尝试取数，但"这个来源已经可用"这句话不允许出现。
          gaps.push(`${providerLabel(provider.id)}：该来源的适配器**尚未真机验收**（依据：公开的站点路径`
            + `约定，没有归档字节）。${site.evidenceNote}在授权环境里跑通一次真实检索并核对选择器之前，`
            + '本来源的 0 命中 / 解析失败都按能力缺口处置，不得当成"该小区没有房源"。')
        }
        const run: ProviderRun = {
          id: provider.id,
          login: verdict.state,
          failedPages,
          fetchedPages,
          caseCount: cases.length,
          attemptLimit,
          detail: verdict.detail,
        }
        runs.push(run)
        // **本来源要恢复的那个页面任务**：第一个两次都没取到的分页；没有就是空串。
        const pendingTask = providerTasks.find((item) => item.state === 'failed')
        // 下一步动作按**真实类别**给：登录墙才说去登录，其余（网络 / 验证码 / 站点错误）
        // 说"看详情按类别处置" —— 把它们也说成"请登录"会让员工白登录一轮。
        const nextAction = failedPages === 0
          ? ''
          : verdict.state === 'unauthenticated'
            ? '在默认浏览器登录该来源，然后点「重新检查并继续」'
            : '按该来源详情里的真实类别处置（网络不可达换网络 / 需要人工过人机验证 / 站点错误稍后重试），'
              + '然后点「重新检查并继续」。**不要**把它当成"没登录"去重新登录。'
        if (nextAction !== '' && !nextActions.includes(nextAction)) nextActions.push(nextAction)
        reports.push({
          id: provider.id,
          label: providerLabel(provider.id),
          login: verdict.state,
          fetchedPages,
          failedPages,
          caseCount: cases.length,
          attemptLimit,
          detail: verdict.detail,
          urls,
          notes,
          retrievalTaskId: pendingTask?.retrievalTaskId ?? '',
          retrievalTasks: providerTasks,
          nextAction,
          evidence: siteOf(provider.id).evidence,
          cityStatus: 'resolved',
          cityReason: '',
          citySourcePage: '',
          citySourceEvidence: '',
          budget: {
            pagesUsed: finalAllowance.pagesUsed,
            candidatesUsed: finalAllowance.candidatesUsed,
            pageLimit: finalAllowance.pageLimit,
            candidateLimit: finalAllowance.candidateLimit,
            stoppedBy,
            reason: stopReason,
          },
        })
        if (failedPages > 0) gaps.push(loginGapText(run))
        if (fetchedPages > 0 && cases.length === 0) {
          gaps.push(parseFailures.includes('template-stale')
            ? `${providerLabel(provider.id)}：结果页结构在、但固定选择器 0 命中 —— 站点模板可能已改版`
              + '（template-stale）。这不是"该小区没有房源"：**不要**按标题猜价格，也不要据此判定无可比案例；'
              + '先更新来源适配器的选择器再重跑。'
            : parseFailures.includes('no-results')
              ? `${providerLabel(provider.id)}：站点明确回答了"没有结果"（no-results）：按知识规则处理候选不足。`
              : `${providerLabel(provider.id)}：页面取到了，但没有可用的结构化房源数据（不猜测）`)
        }
        // Environment write failed for this provider: stop remaining providers too.
        if (persistenceFailure !== '') break providerLoop
      }

      const decision = decidePhase(runs)

      // **把结论写回轮次**：面板轮询的是宿主的事实，工具只回给模型的话界面永远停在"正在跑"。
      // 来源状态、能力缺口、阶段三样都要写 —— 尤其 `browser-login-required`：
      // 它是"用户需要在默认浏览器登录"这个可恢复状态的**唯一**来源（只有工具知道请求失败了）。
      const writebacks = [
        ...reports.map((item) => recordProviderState(deps, exec, item.id, {
          state: item.login,
          attempts: item.attemptLimit,
          detail: item.detail,
        })),
        ...gaps.map((gap) => recordCapabilityGap(deps, exec, gap)),
        recordPhase(deps, exec, decision.phase, { progressDetail: decision.detail }),
      ]
      // **写不回去也要说**：静默的后果是界面与子会话看到的事实不一致，而没有任何地方会提这件事。
      for (const item of writebacks.filter((entry) => !entry.ok)) {
        warnings.push(`轮次状态没能回写（界面会少一条状态）：${item.reason}`)
      }

      // **本次调用观察到的行**先做一次同 URL 去重，再并入本方案的累计台账。
      const mergedObserved = dedupeAcrossSources(cases)
      const mergedAway = cases.length - mergedObserved.length
      if (mergedAway > 0) {
        warnings.push(`跨站去重：合并了 ${String(mergedAway)} 条在多个来源重复出现的同一房源（不算独立案例）`)
      }
      const ledgerMerged = unionRows(ledgerRows, mergedObserved.map(caseToJson), rowUrlOf)
      if (ledgerMerged.length !== ledgerRows.length) ledgerRows = ledgerMerged
      // Recompute the cumulative pool from the prior ledger + this call so weak-identity
      // suspicion notes survive; same canonical URL merges deterministically.
      const priorCases = priorLedgerRows.map((row) => caseFromJson(row as SearchCase))
      const outputCases = dedupeAcrossSources([...priorCases, ...cases])
      ledgerRows = outputCases.map(caseToJson)
      if (persistenceFailure !== '') {
        // The canonical ledger already holds committed facts; do not retry or overwrite them.
        return {
          ...base, ...failure('file', persistenceFailure), caseDir,
          cases: outputCases.map(caseToJson), providers: reports,
        }
      }
      if (!(await persistLedger())) {
        return {
          ...base, ...failure('file', persistenceFailure || '累计台账没能落盘：环境写入失败'), caseDir,
          cases: outputCases.map(caseToJson), providers: reports,
        }
      }

      // **批量筛选与优选**：对**累计候选池**应用本轮知识评估；未评估一律不采用。
      let selection: SearchResult['selection'] = {
        present: false, error: '', maxAdopted: 0, order: [], adopted: [], rejected: [], notes: [], assessments: [],
      }
      if (earlySelection !== null && earlySelection.rule !== null) {
        const rule = earlySelection.rule
        const picked2 = selectCandidates(outputCases, rule)
        selection = {
          present: true,
          error: '',
          maxAdopted: rule.maxAdopted,
          order: rule.order.map((item) => item.key),
          adopted: picked2.adopted.map((item) => item.url),
          rejected: picked2.rejected.map((item) => ({ url: item.case.url, reason: item.reason })),
          notes: picked2.notes,
          assessments: picked2.assessments.map((item) => ({
            url: item.url, status: item.status, reason: item.reason, knowledgeRef: item.knowledgeRef,
          })),
        }
      }

      const casesPath = joinLocalPath(planRoot, VALUATION_CASES_FILE)
      const written = await writeCaseText(ctx, casesPath, canonicalJson({
        schema: 'crwu.valuation.cases.v1',
        keyword,
        city,
        providers: reports,
        phase: decision.phase,
        counts: caseCounts(outputCases),
        dedupedAway: mergedAway,
        // 落盘的是一份**好读的**筛选视图：入选 / 落选（带理由）/ 说明；没给规则时是 null。
        selection: selection.present ? selection : null,
        cases: outputCases.map(caseToJson),
        capabilityGaps: gaps,
      }), writeOptions)
      if (!written.ok) return { ...base, ...failure('infrastructure', `案例清单落盘失败：${written.error}`) }

      return {
        ok: true,
        errorKind: '',
        error: '',
        caseDir,
        casesPath,
        phase: decision.phase,
        canProceed: decision.canProceed,
        keyword,
        city,
        // 顶层是**这次业务城市解析的总结**；逐来源能不能用看 `providers[].cityStatus`。
        cityStatus: cityResolved.status,
        cityCode: siteCity,
        cityCandidates: cityResolved.candidates.map((item) => `${item.name}=${item.key}`),
        cityPage: cityResolved.page,
        cases: outputCases.map(caseToJson),
        counts: caseCounts(outputCases),
        dedupedAway: mergedAway,
        selection,
        providers: reports,
        needsLogin: decision.needsLogin,
        unconfirmed: decision.unconfirmed,
        retrievalTaskId: reports.find((item) => item.retrievalTaskId !== '')?.retrievalTaskId ?? '',
        retrievalTasks,
        nextActions,
        capabilityGaps: gaps,
        warnings,
      }
    },
  })

  const capture = defineTool({
    name: VALUATION_TOOL_NAMES.marketCapture,
    description: [
      '把一条外部页面的**证据**取下来存进方案的 来源证据/（页面字节 + 内容指纹）。',
      '给了 caseId 且页面是可读的有效详情时，另截一次详情页并写进 推理结果/图片/ 的图片清单；',
      '截图能力缺失或失败只记缺口，**绝不**用 HTML 冒充截图。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      planId: { type: 'string', description: '方案 id：证据落在 方案/<planId>/来源证据/ 下；缺省落在案例根。' },
      source: { type: 'string', required: true, description: '来源 id（fang / anjuke / lianjia）。' },
      url: { type: 'string', required: true, description: '要留证的完整 URL（必须属于该来源的白名单站点）。' },
      caseId: { type: 'string', description: '稳定的案例 id：给了就把详情页截图与该案例关联；缺省只留 HTML 证据。' },
      displayName: { type: 'string', description: '人可读案例名称（只作目录标签与清单展示，不参与身份）。' },
      maxAttempts: { type: 'integer', description: '详情最多尝试次数，仅1或2；缺省2。模板工作流指定1，故障后由员工显式恢复。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          file: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          status: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          sourceUrl: { type: 'string', required: true, description: '取证时回读的最终 URL（详情页 URL）' },
          screenshot: { type: 'string', required: true, description: '详情页截图相对案例目录的路径；没截到为空串' },
          screenshotDigest: { type: 'string', required: true, description: '详情页截图指纹；没截到为空串' },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(
      args: { caseDir?: unknown; planId?: unknown; source?: unknown; url?: unknown; caseId?: unknown; displayName?: unknown; maxAttempts?: unknown },
      exec,
    ) {
      const ctx = toolContext(deps.ctx, exec)
      const source = text(args.source)
      const url = text(args.url).trim()
      const caseId = text(args.caseId).trim()
      const displayName = text(args.displayName).trim()
      const empty = {
        ok: false, errorKind: '', error: '', caseDir: '', file: '', digest: '', bytes: 0, status: 0,
        url, sourceUrl: '', screenshot: '', screenshotDigest: '',
        // 有注入的截图通道时不再写"本部署没有截图能力"（那句会与事实相反）。
        capabilityGaps: deps.screenshot === undefined ? [SCREENSHOT_GAP] as string[] : [] as string[],
      }
      if (args.maxAttempts !== undefined && args.maxAttempts !== 1 && args.maxAttempts !== MARKET_ATTEMPTS) return { ...empty, ...failure('input', 'maxAttempts 必须是1或2') }
      const attemptLimit = args.maxAttempts === 1 ? 1 : MARKET_ATTEMPTS
      if (canonicalListingUrl(url) === '') {
        return { ...empty, ...failure('input', `不是有效的 http/https 详情页地址：「${url}」`) }
      }
      if (!credentialsTrusted(deps)) {
        return { ...empty, ...failure('policy', '尚未在本机访问授权里允许工作台访问本机能力：请在面板授权后再取证。') }
      }
      const picked = narrowProviders([source])
      if (!picked.ok) return { ...empty, ...failure('input', picked.error) }
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...empty, ...access }
      if (access.kind !== 'valuation') {
        return { ...empty, ...failure('policy', '这条会话不是本轮估值会话：取证只能在估值子会话里进行') }
      }
      // 与 `market_search` 同一套方案隔离：证据必须落在方案目录里，否则 finalize 读不到。
      const planId = text(args.planId).trim()
      const planRelative = planId === '' ? '' : planDirRelative(planId)
      if (planId !== '' && planRelative === '') {
        return { ...empty, ...failure('input', `planId 不是单段安全标识：「${planId}」`) }
      }
      const planRoot = planRelative === '' ? access.casePath : joinLocalPath(access.casePath, planRelative)
      // Validate the existing screenshot manifest BEFORE any network/screenshot: corrupt or
      // foreign data must fail closed, never be overwritten or silently re-fetched.
      const manifestPath = joinLocalPath(planRoot, '推理结果/图片/图片清单.json')
      const expectedPlan = planId || '(case-root)'
      const fs = fileSystem(ctx)
      if (fs === undefined) {
        return { ...empty, ...failure('infrastructure', 'Host 文件服务不可用：无法核对图片清单'), caseDir: access.casePath }
      }
      let manifestInfo: unknown
      try {
        manifestInfo = await fs.stat(await fs.resolve(manifestPath))
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code !== 'ENOENT' && code !== 'not-found') {
          return {
            ...empty, ...failure('file', `图片清单无法探测（${String(error)}）：停止本次取证`),
            caseDir: access.casePath,
          }
        }
      }
      let existingEntries: unknown[] = []
      if (manifestInfo !== undefined) {
        let stored = ''
        try {
          stored = await fs.readText(await fs.resolve(manifestPath))
        } catch (error) {
          return {
            ...empty, ...failure('file', `图片清单存在但读不出来（${String(error)}）：停止本次取证`),
            caseDir: access.casePath,
          }
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(stored)
        } catch (error) {
          return {
            ...empty, ...failure('file',
              `图片清单已存在但无法解析（${error instanceof Error ? error.message : String(error)}）：`
              + '请人工修复或删除后再取证（不得覆盖）'),
            caseDir: access.casePath,
          }
        }
        const doc = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
          ? parsed as Record<string, unknown> : null
        if (doc === null
          || doc.schemaVersion !== 'crwu.valuation.screenshot-manifest.v1'
          || text(doc.planId) !== expectedPlan
          || !Array.isArray(doc.entries)) {
          return { ...empty, ...failure('file', '图片清单结构/身份不匹配：请人工修复（不得覆盖）'), caseDir: access.casePath }
        }
        const required = ['caseId', 'provider', 'sourceUrl', 'capturedAt', 'relativePath', 'digest', 'validity']
        for (const item of doc.entries as unknown[]) {
          const record = (item !== null && typeof item === 'object' && !Array.isArray(item))
            ? item as Record<string, unknown> : null
          if (record === null
            || required.some((key) => text(record[key]) === '')
            || canonicalListingUrl(text(record.sourceUrl)) === '') {
            return {
              ...empty, ...failure('file', '图片清单条目不完整/来源地址不合法：请人工修复（不得覆盖）'),
              caseDir: access.casePath,
            }
          }
        }
        existingEntries = doc.entries as unknown[]
      }
      const session = callerSession(exec)
      const signal = exec.signal
      // 与检索同一条纪律：证据目录在写之前幂等创建（首次运行时它还不存在），
      // 失败单独归类为文件错误，不混进"页面取不到"。
      const made = await ensureDirectory(deps.access, joinLocalPath(planRoot, EVIDENCE_DIR), {
        workdir: await deps.world.workdir(),
        platform: await deps.world.platform(),
        ...(session === undefined ? {} : { session }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!made.ok) {
        return {
          ...empty, ...failure('file',
            `证据目录创建失败：${made.error} —— 这是文件 / 目录错误，不是网站登录或验证码问题。`),
          caseDir: access.casePath,
        }
      }
      const scopeRef = deps.valuationScopes?.scopeOf(callerIdentity(exec).childId)
      const captureTransport = pickTransport(picked.ids[0], {
        pageNo: 0, keyword: '', city: '', caseRoot: planRoot,
        projectId: text(scopeRef?.projectId) || text(scopeRef?.valuationId) || basenameLocalPath(access.casePath),
        planId,
      })
      const outcome = await withAttempts(async () => {
        const result: MarketFetchResult = await captureTransport(url, { ...(signal === undefined ? {} : { signal }) })
        // Typed non-OK results are not retried blindly: captcha/login/blocked/unreadable/
        // not-found are final. Unclassified failures may still be transient, so keep one retry.
        const finalKind = ['captcha', 'login', 'blocked', 'unreadable', 'not-found']
          .includes(text(result.failureKind))
        if (!result.ok && !finalKind) throw new Error(result.error || `HTTP ${result.status}`)
        return result
      }, { attempts: attemptLimit })
      if (!outcome.ok) {
        return {
          ...empty, ...failure('cli', `${providerLabel(picked.ids[0])} 页面取不到（已尝试 ${outcome.attempts} 次）：${outcome.errors.join('；')}`),
        }
      }
      const fetched = outcome.value as MarketFetchResult
      if (!fetched.ok) {
        return {
          ...empty, ...failure('cli',
            `${providerLabel(picked.ids[0])} 页面取不到（${text(fetched.failureKind) || 'unknown'}）：`
            + `${text(fetched.error) || `HTTP ${fetched.status}`}`),
        }
      }
      const finalUrl = text(fetched.url) || url
      const entry = await saveEvidence({
        ctx, casePath: planRoot, source: picked.ids[0], url: finalUrl,
        body: fetched.body, status: fetched.status,
        ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }),
      })
      if (!entry.ok) return { ...empty, ...failure('infrastructure', entry.error) }

      const gaps: string[] = deps.screenshot === undefined ? [SCREENSHOT_GAP] : []
      let screenshot = ''
      let screenshotDigest = ''
      let sourceUrl = ''
      const requestedCanonical = canonicalListingUrl(url)
      const finalCanonical = canonicalListingUrl(finalUrl)
      const finalId = listingIdOf(finalUrl)
      const blockedPage = fetched.captcha === true || fetched.loginRequired === true
        || text(fetched.failureKind) === 'blocked'
      // A valid detail requires the final URL to be a real http(s) URL and the same canonical page.
      const detailIdentityOk = requestedCanonical !== '' && finalCanonical !== ''
        && finalCanonical === requestedCanonical
      if (caseId !== '') {
        if (blockedPage) {
          gaps.push('页面被判为需要登录 / 验证码 / 拦截：这一页不是详情证据，不截图、不关联')
        } else if (!detailIdentityOk) {
          gaps.push(`取回页面重定向到另一条房源或地址不可用（${url} → ${finalUrl || '(空)'}）：不把这一页当作原案例证据`)
        } else {
          // A valid detail page keeps its actual URL even when the image cannot be captured.
          sourceUrl = finalUrl
          if (deps.screenshot === undefined) {
            gaps.push(`案例 ${caseId} 需要详情截图，但本部署没有截图能力：只保留 HTML 证据`)
          } else {
            const shot = await captureScreenshot(deps.screenshot, {
              url: finalUrl, casePath: planRoot, source: picked.ids[0], caseId,
              displayName: displayName || caseId,
              evidenceType: 'detail-screenshot',
              ...(session === undefined ? {} : { session }),
              ...(signal === undefined ? {} : { signal }),
            }, async (file) => await evidenceExists(ctx, planRoot, file))
            if (!shot.ok) {
              gaps.push(`详情页截图未成功（${shot.error}）：本次不声称已留存详情截图`)
            } else if (text(shot.sourceUrl) !== '' && canonicalListingUrl(text(shot.sourceUrl)) !== finalCanonical) {
              gaps.push(`截图能力报告的最终地址与原案例不一致（${text(shot.sourceUrl)}）：不关联该截图`)
            } else {
              const entries = existingEntries
                .filter((item) => text((item as { caseId?: unknown } | null)?.caseId) !== caseId)
              entries.push({
                caseId, displayName: displayName || caseId, provider: picked.ids[0],
                sourceUrl: text(shot.sourceUrl) || finalUrl, capturedAt: shot.capturedAt,
                relativePath: shot.file, digest: shot.digest, bytes: shot.bytes, validity: 'valid',
                listingId: finalId === '' ? null : finalId, evidenceType: 'detail-screenshot',
              })
              // Snapshot the exact JSON bytes before writing; readback must match them exactly.
              const nextManifestJson = canonicalJson({
                schemaVersion: 'crwu.valuation.screenshot-manifest.v1',
                planId: expectedPlan,
                entries,
              })
              const written = await writeCaseText(ctx, manifestPath, nextManifestJson, {
                ...(session === undefined ? {} : { session }),
                ...(signal === undefined ? {} : { signal }),
              })
              if (!written.ok) {
                return {
                  ...empty, ...failure('file',
                    `图片清单落盘失败（${written.error}）：环境写入失败，停止本次取证`),
                  caseDir: access.casePath,
                }
              }
              let readback = ''
              try {
                readback = await fs.readText(await fs.resolve(manifestPath))
              } catch (error) {
                return {
                  ...empty, ...failure('file', `图片清单回读失败（${String(error)}）：停止本次取证`),
                  caseDir: access.casePath,
                }
              }
              if (readback !== nextManifestJson) {
                return { ...empty, ...failure('file', '图片清单回读与写入不一致：停止本次取证'), caseDir: access.casePath }
              }
              screenshot = shot.file
              screenshotDigest = shot.digest
              sourceUrl = text(shot.sourceUrl) || finalUrl
            }
          }
        }
      } else if (deps.screenshot !== undefined) {
        gaps.push('没有给 caseId：这次只留 HTML 证据，图片无法关联到具体案例')
      }
      return {
        ok: true, errorKind: '', error: '', caseDir: access.casePath,
        file: entry.file, digest: entry.digest, bytes: entry.bytes, status: entry.status, url: entry.url,
        sourceUrl, screenshot, screenshotDigest,
        capabilityGaps: gaps,
      }
    },
  })

  return [search, capture]
}

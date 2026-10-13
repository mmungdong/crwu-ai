import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { writeCaseText } from '../common/case-files.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, credentialsTrusted, toolContext, type ToolDeps } from '../common/types.ts'
import { recordCapabilityGap, recordPhase, recordProviderState } from './record.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { allProviders, MARKET_MAX_PAGES } from '../../domains/report-evaluation/browser/providers.ts'
import { fetchTransport } from '../../domains/report-evaluation/browser/fetch-transport.ts'
import { narrowProviders } from '../../domains/report-evaluation/browser/provider.ts'
import { MARKET_ATTEMPTS, withAttempts } from '../../domains/report-evaluation/browser/retry.ts'
import { decidePhase, loginGapText, providerLabel, type ProviderRun } from '../../domains/report-evaluation/browser/login-state.ts'
import { SCREENSHOT_GAP, captureScreenshot, evidenceExists, saveEvidence, type ValuationScreenshotResult } from '../../domains/report-evaluation/browser/capture.ts'
import type { MarketFetchResult, MarketTransport, RawListing } from '../../domains/report-evaluation/browser/provider.ts'
import { caseCounts, dedupeAcrossSources, normalizeCase, type ValuationCase } from '../../domains/report-evaluation/market/normalize.ts'
import { VALUATION_CASES_FILE, VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_market_search` 与 `crwu_valuation_market_capture`（协议 32）。
 *
 * ## 三轮之间只传递"能核对的东西"
 *
 * 每个分页最多尝试 `MARKET_ATTEMPTS`（3）次；每次尝试前记 URL、失败后记原因。
 * 三次都失败时**不是**简单跳过：由 `decidePhase` 判断该来源的登录状态 ——
 * 未确认 → 整轮停在 `browser-login-required`（可恢复）；已确认 → 记能力缺口继续其他来源。
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
 */

interface SearchArgs {
  caseDir?: unknown
  keyword?: unknown
  city?: unknown
  providers?: unknown
  maxPages?: unknown
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
  providers: ProviderReport[]
  needsLogin: string[]
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

function idleResult(): SearchResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', casesPath: '', phase: '', canProceed: false,
    keyword: '', city: '', cases: [], counts: {}, dedupedAway: 0, providers: [], needsLogin: [],
    capabilityGaps: [], warnings: [],
  }
}

export function valuationMarketSearchTools(deps: ToolDeps, transport?: MarketTransport) {
  /** 抓取通道：缺省用全局 fetch；测试注入内存替身。 */
  const pickTransport = (): MarketTransport => transport ?? fetchTransport({})

  const search = defineTool({
    name: VALUATION_TOOL_NAMES.marketSearch,
    description: [
      '在房天下 / 安居客 / 链家·贝壳检索同区域可比案例，把页面里**明确声明**的结构化房源',
      '取回、标准化并落盘到案例目录的 估值案例.json；同时把页面证据存进 来源证据/。',
      `每个分页最多尝试 ${MARKET_ATTEMPTS} 次；三次都失败且登录状态未确认时返回 phase=browser-login-required。`,
      '页面没有结构化数据时返回 0 条 + 能力缺口 —— 绝不按标题猜价格与面积。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      keyword: { type: 'string', required: true, description: '检索关键字（小区名或地址）。' },
      city: { type: 'string', required: true, description: '城市（站点侧标识，如 beijing / 北京）。' },
      providers: { type: 'array', items: { type: 'string' }, description: '来源 id 清单；缺省全部三家。' },
      maxPages: { type: 'integer', description: `每家最多翻几页（上限 ${MARKET_MAX_PAGES}）。` },
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
                keep_reason: { type: 'string', required: true },
                drop_reason: { type: 'string', required: true },
                notes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          counts: { type: 'object', required: true, additionalProperties: true },
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
              },
            },
          },
          needsLogin: { type: 'array', required: true, items: { type: 'string' } },
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: SearchArgs, exec): Promise<SearchResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()
      const keyword = text(args.keyword).trim()
      const city = text(args.city).trim()
      if (keyword === '' || city === '') {
        return { ...base, ...failure('input', 'keyword 与 city 都必须给出：检索需要明确的区域与对象') }
      }
      // 授权门禁（协议 18 同一条口径）：未授权时**一个外部请求都不发**。
      // 外部检索是网络出口，而"未授权时的失败"分不清是站点问题还是权限问题 ——
      // 那种结论一旦进了案例清单就会被当成事实。
      if (!credentialsTrusted(deps)) {
        return { ...base, ...failure('policy', '尚未在本机访问授权里允许工作台访问本机能力：请在面板授权后再检索外部案例。') }
      }

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
      const session = callerSession(exec)
      const signal = (exec as { signal?: AbortSignal }).signal
      const writeOptions = { ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) }

      const requestedPages = typeof args.maxPages === 'number' && Number.isFinite(args.maxPages)
        ? Math.max(1, Math.min(Math.trunc(args.maxPages), MARKET_MAX_PAGES))
        : 1

      const channel = pickTransport()
      const providers = allProviders({ transport: channel })
      const wanted = providers.filter((provider) => picked.ids.includes(provider.id))
      const reports: ProviderReport[] = []
      const runs: ProviderRun[] = []
      const cases: ValuationCase[] = []
      const gaps: string[] = []
      // 有注入的截图通道时不再报"没有截图能力"：那会变成一句与事实相反的固定文案。
      const warnings: string[] = deps.screenshot === undefined ? [SCREENSHOT_GAP] : []

      for (const provider of wanted) {
        const verdict = await provider.preflight()
        const urls: string[] = []
        const notes: string[] = []
        let fetchedPages = 0
        let failedPages = 0

        for (let pageNo = 1; pageNo <= requestedPages; pageNo += 1) {
          const outcome = await withAttempts(async () => await provider.searchPage(
            { keyword, city, maxPages: requestedPages }, pageNo, signal,
          ), {
            attempts: MARKET_ATTEMPTS,
            onFailure: (attempt, error) => { notes.push(`第 ${pageNo} 页第 ${attempt} 次失败：${error}`) },
          })
          if (!outcome.ok) {
            failedPages += 1
            continue
          }
          fetchedPages += 1
          const fetched = outcome.value
          notes.push(...(fetched?.notes ?? []))
          const raw: RawListing[] = fetched?.raw ?? []
          const pageUrl = text(fetched?.url) || `${provider.id}#page-${pageNo}`
          urls.push(pageUrl)
          // 每一页都留证据：案例链接会过期，页面字节才是本轮取数的凭据。
          const evidence = await saveEvidence({
            ctx, casePath: caseDir, source: provider.id, url: pageUrl,
            body: text(fetched?.body), status: fetched?.status ?? 0, ...writeOptions,
          })
          if (!evidence.ok) {
            gaps.push(`${providerLabel(provider.id)}：第 ${pageNo} 页证据没能留存（${evidence.error}）`
              + ' —— 该页案例已标记 `evidence_missing`，**不得**直接当可比实例使用')
          }
          for (const listing of raw) {
            const item = normalizeCase(listing)
            // 案例指向**本页**的证据文件：那是它被读到的出处。
            if (evidence.ok) item.evidence = evidence.file
            // **页面截图**（§7.4）：有注入能力才截；没有就留空，由 `screenshot_missing` 如实标记。
            // 案例关联由 `caseId` 明确给出（同一页面上可能有多套房源），不靠文件名推。
            const caseId = `${provider.id}-${String(pageNo)}-${String(cases.length + 1)}`
            const shot: ValuationScreenshotResult = await captureScreenshot(
              deps.screenshot,
              {
                url: pageUrl, casePath: caseDir, source: provider.id, caseId,
                ...(session === undefined ? {} : { session }),
                ...(signal === undefined ? {} : { signal }),
              },
              async (file) => await evidenceExists(ctx, caseDir, file),
            )
            if (shot.ok) {
              item.screenshot = shot.file
              item.screenshotDigest = shot.digest
              item.screenshotCapturedAt = shot.capturedAt
            } else if (deps.screenshot !== undefined) {
              // 有通道但这次没成功：这是一条**具体案例**的失败，不只是全局缺口。
              gaps.push(`${providerLabel(provider.id)} 的第 ${String(cases.length + 1)} 条候选案例截图未成功`
                + `（${shot.error}）：已标 \`screenshot_missing\`，不得当作已取证`)
            }
            cases.push(item)
          }
        }

        const run: ProviderRun = {
          id: provider.id,
          login: verdict.state,
          failedPages,
          fetchedPages,
          caseCount: cases.length,
          attemptLimit: MARKET_ATTEMPTS,
          detail: verdict.detail,
        }
        runs.push(run)
        reports.push({
          id: provider.id,
          label: providerLabel(provider.id),
          login: verdict.state,
          fetchedPages,
          failedPages,
          caseCount: cases.length,
          attemptLimit: MARKET_ATTEMPTS,
          detail: verdict.detail,
          urls,
          notes,
        })
        if (failedPages > 0) gaps.push(loginGapText(run))
        if (fetchedPages > 0 && cases.length === 0) {
          gaps.push(`${providerLabel(provider.id)}：页面取到了，但没有可用的结构化房源数据（不猜测）`)
        }
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

      // **跨站去重**（§7.3）：链家 / 贝壳（以及别的来源之间）会重复展示同一套房源，
      // 按 URL 去不掉（URL 本来就不同）。所以按"小区 + 面积 + 价格档"合并，只留先出现的那一条，
      // 并把"与哪一条重复"记进留下那条的 notes —— 去重不等于把过程删掉。
      const merged = dedupeAcrossSources(cases)
      const mergedAway = cases.length - merged.length
      if (mergedAway > 0) {
        warnings.push(`跨站去重：合并了 ${String(mergedAway)} 条在多个来源重复出现的同一房源（不算独立案例）`)
      }

      const casesPath = joinLocalPath(caseDir, VALUATION_CASES_FILE)
      const written = await writeCaseText(ctx, casesPath, canonicalJson({
        schema: 'crwu.valuation.cases.v1',
        keyword,
        city,
        providers: reports,
        phase: decision.phase,
        counts: caseCounts(merged),
        dedupedAway: mergedAway,
        cases: merged.map(caseToJson),
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
        cases: merged.map(caseToJson),
        counts: caseCounts(merged),
        dedupedAway: mergedAway,
        providers: reports,
        needsLogin: decision.needsLogin,
        capabilityGaps: gaps,
        warnings,
      }
    },
  })

  const capture = defineTool({
    name: VALUATION_TOOL_NAMES.marketCapture,
    description: [
      '把一条外部页面的**证据**取下来存进案例目录的 来源证据/（页面字节 + 内容指纹）。',
      '本部署没有可用的页面截图能力：证据是 HTML 与指纹，不是截图（会如实写进 capabilityGaps）。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      source: { type: 'string', required: true, description: '来源 id（fang / anjuke / lianjia）。' },
      url: { type: 'string', required: true, description: '要留证的完整 URL（必须属于该来源的白名单站点）。' },
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
          capabilityGaps: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { caseDir?: unknown; source?: unknown; url?: unknown }, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const source = text(args.source)
      const url = text(args.url).trim()
      const empty = {
        ok: false, errorKind: '', error: '', caseDir: '', file: '', digest: '', bytes: 0, status: 0,
        url,
        // 有注入的截图通道时不再写"本部署没有截图能力"（那句会与事实相反）。
        capabilityGaps: deps.screenshot === undefined ? [SCREENSHOT_GAP] as string[] : [] as string[],
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
      const session = callerSession(exec)
      const signal = exec.signal
      const outcome = await withAttempts(async () => {
        const result: MarketFetchResult = await (transport ?? fetchTransport({}))(url, { ...(signal === undefined ? {} : { signal }) })
        if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`)
        return result
      }, { attempts: MARKET_ATTEMPTS })
      if (!outcome.ok) {
        return {
          ...empty, ...failure('cli', `${providerLabel(picked.ids[0])} 页面取不到（已尝试 ${outcome.attempts} 次）：${outcome.errors.join('；')}`),
        }
      }
      const fetched = outcome.value as MarketFetchResult
      const entry = await saveEvidence({
        ctx, casePath: access.casePath, source: picked.ids[0], url: fetched.url || url,
        body: fetched.body, status: fetched.status,
        ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }),
      })
      if (!entry.ok) return { ...empty, ...failure('infrastructure', entry.error) }
      return {
        ok: true, errorKind: '', error: '', caseDir: access.casePath,
        file: entry.file, digest: entry.digest, bytes: entry.bytes, status: entry.status, url: entry.url,
        capabilityGaps: [SCREENSHOT_GAP],
      }
    },
  })

  return [search, capture]
}

import { text } from '../../../shared/utils/value.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { pickDirectory, pickFile, type DirectoryPicker, type FilePicker } from '../local-audit/pick.ts'
import {
  applyArtifacts,
  applyPartialResult,
  applyResult,
  applyStatus,
  backToEdit,
  beginIntake,
  beginScan,
  cancelIntake,
  cancelValuation,
  confirmAndStart,
  initialValuationState,
  intakeFailed,
  intakeReady,
  intakeStage,
  intakeTimedOut,
  providerCheckFailed,
  providerCheckReady,
  isCurrentIntake,
  isValuationMethod,
  markHostStale,
  resetToDraft,
  scanFailed,
  hasAnyArtifact,
  scanReady,
  setBaseDate,
  setMethod,
  setSelection,
  setSupplementalPrompt,
  type ValuationIntakeView,
  type ValuationMethod,
  type ValuationPageState,
  type ValuationResultView,
  type ValuationSelectedFileView,
} from './model/valuation-state.ts'

/**
 * 报告评估页的**控制器**（协议 32）。
 *
 * 与本地审核的控制器同一个形状：纯状态机 + 可注入的 RPC 端口，没有 React、没有 DOM。
 * 好处是这一页最要紧的几条行为可以直接断言：
 *
 * 1. **确认之后输入不可变**：`confirmation` 阶段所有改输入的动作都被状态机拒绝；
 * 2. **失败不丢输入**：intake 失败时选择、方法、基准日、补充要求全部保留（用户改一句再试，
 *    而不是从头再选一遍资料）；
 * 3. **协议不匹配立刻停**：一旦发现宿主是旧构建，整页进入 `stale-host`，不再按旧事实推进。
 *
 * ## 文件选择复用本地审核的选择器
 *
 * 浏览器拿不到绝对路径，目录/文件选择必须走宿主原生对话框 —— 那条路已经在本地审核里做好了
 * （`modules/local-audit/pick.ts`）。这里直接复用，不另造一套：两套选择器迟早会在
 * "回什么形状的路径"上分叉。
 */

/** Host RPC 端口（形状与 Client 门面的八个操作一致）。 */
/** `valuation-files-scan` 应答里每条资料的形状（缺字段时给安全默认）。 */
interface ScanItemLike {
  path?: unknown
  name?: unknown
  kind?: unknown
  sizeBytes?: unknown
  status?: unknown
  reason?: unknown
  fileCount?: unknown
}

export interface ValuationPort extends DirectoryPicker, FilePicker {
  scan?: (input: { paths: string[] }) => Promise<{ ok?: boolean; error?: string; fileCount?: number; items?: unknown[] }>
  /**
   * 资料提取。
   *
   * ⚠️ `baseDate` 必须**逐字**传下去（未选择就是空串）：宿主按它冻结输入、按它决定
   * "要不要按基准日筛选案例"。客户端不拿资料里识别到的日期补一个（§11.5）。
   */
  intake: (input: {
    valuationId: string
    method: ValuationMethod
    baseDate: string
    supplementalPrompt?: string
    paths: string[]
  }) => Promise<Record<string, unknown>>
  preflight?: (input: { openLogin?: string }) => Promise<Record<string, unknown>>
  /**
   * 「重新检查并继续」：宿主侧重新判断这一轮能不能往下走（登录补好了就继续）。
   *
   * 与 `preflight` 分开：`preflight` 只回答"站点现在能不能访问"，这一条会让被登录阻塞的
   * 那一轮**真的接着跑**。合成一条的话，界面上的「重新检查」就只是刷新状态、不解决问题。
   */
  recheck?: () => Promise<Record<string, unknown>>
  start: (input: {
    valuationId: string
    method: ValuationMethod
    baseDate: string
    supplementalPrompt: string
    confirmedSnapshotDigest: string
  }) => Promise<Record<string, unknown>>
  status: (input: { valuationId: string }) => Promise<Record<string, unknown>>
  cancel: (input: { valuationId: string }) => Promise<Record<string, unknown>>
  result: (input: { valuationId: string }) => Promise<Record<string, unknown>>
  openArtifact: (input: { valuationId: string; name: string }) => Promise<Record<string, unknown>>
  /** 本机访问授权 + 环境门禁的结论（未就绪时不允许起估值）。 */
  ready?: () => { ok: boolean; error: string }
  clock?: () => number
  /**
   * 定时器（测试注入假实现；缺省 `setTimeout`）。
   *
   * 提取请求必须有**有限超时**：宿主可能长时间不返回（外部站点探测、Python 提取慢），
   * 没有超时的话用户只能看到一个永远转圈的状态。
   */
  scheduleTimeout?: (handler: () => void, ms: number) => unknown
  clearScheduledTimeout?: (handle: unknown) => void
  /** 提取等待上限；缺省 120s。 */
  intakeTimeoutMs?: number
}

export interface ReportEvaluationController {
  getState: () => ValuationPageState
  subscribe: (listener: (state: ValuationPageState) => void) => () => void
  pickFiles: () => void
  pickFolder: () => void
  removeSelection: (path: string) => void
  setMethod: (method: ValuationMethod) => void
  setBaseDate: (value: string) => void
  setPrompt: (value: string) => void
  /** 「检查并确认」：立即进入提取态并调用 `valuation-intake`。 */
  start: () => void
  /** 「取消提取」：作废在途请求并回到可编辑的草稿态。 */
  cancelIntake: () => void
  /** 重新扫一遍本机选择（拿逐份文件名 / 大小 / 可读性）。 */
  rescan: () => void
  backToEdit: () => void
  confirm: () => void
  cancel: () => void
  recheck: () => void
  openLogin: (providerId: string) => void
  openArtifact: (name: string) => void
  /** 协议代数不匹配时由外层调用。 */
  markStale: () => void
  /** 轮询一次状态（running 时由页面定时调用）。 */
  poll: () => void
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 提取等待上限。
 *
 * 取值理由：`valuation-intake` 做的是本机复制 + Python 提取（不做网站预检 —— 那已经挪到抽屉里）。
 * 一份几十兆的 PDF 加上冷启动的 Python 也就几十秒；两分钟还没回话就属于"卡住了"，
 * 让它继续转圈不如给一个**可恢复**的失败（用户可以直接重新提取，案例目录会复用）。
 */
const DEFAULT_INTAKE_TIMEOUT_MS = 120_000

/** 两次选择是不是同一份（顺序也算：用户重排过选择，旧扫描结论就过期了）。 */
function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** 估值 ID：由 Host 在首次 intake 时铸号并回显；客户端不自己编（目录名要能被 Host 认）。 */
function mintClientValuationId(clock: () => number): string {
  const now = new Date(clock())
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // 后缀只是"同一秒内不撞 ID"：真正的合法性由 Host 的 `isSafeValuationId` 判。
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0').slice(0, 4)
  return `估值-${stamp}-${suffix}`
}

/** 把 Host 的 intake 应答收成抽屉视图（缺字段时给安全默认，不抛）。 */
export function intakeViewOf(payload: Record<string, unknown>, fallback: {
  valuationId: string
  method: ValuationMethod
  baseDate: string
  supplementalPrompt: string
}): ValuationIntakeView {
  const listOf = <T,>(value: unknown, map: (item: Record<string, unknown>) => T): T[] =>
    Array.isArray(value) ? value.flatMap((item) => (item !== null && typeof item === 'object' ? [map(item as Record<string, unknown>)] : [])) : []
  const knowledge = payload.knowledge !== null && typeof payload.knowledge === 'object'
    ? payload.knowledge as Record<string, unknown>
    : {}
  const fields = payload.extractedFields !== null && typeof payload.extractedFields === 'object'
    ? Object.fromEntries(Object.entries(payload.extractedFields as Record<string, unknown>).map(([key, value]) => [key, text(value)]))
    : {}
  return {
    valuationId: text(payload.valuationId) || fallback.valuationId,
    casePath: text(payload.casePath),
    method: text(payload.method) || fallback.method,
    baseDate: text(payload.baseDate) || fallback.baseDate,
    supplementalPrompt: text(payload.supplementalPrompt) || fallback.supplementalPrompt,
    digest: text(payload.digest),
    files: listOf(payload.files, (item) => ({
      fileName: text(item.fileName), relativePath: text(item.relativePath), kind: text(item.kind),
      sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
      status: text(item.status) || 'unparsed', note: text(item.note),
    })),
    extractedFields: fields,
    missingFields: Array.isArray(payload.missingFields) ? payload.missingFields.map((item) => text(item)) : [],
    unparsed: Array.isArray(payload.unparsed) ? payload.unparsed.map((item) => text(item)) : [],
    capabilityGaps: Array.isArray(payload.capabilityGaps) ? payload.capabilityGaps.map((item) => text(item)) : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map((item) => text(item)) : [],
    knowledge: {
      space: text(knowledge.space),
      ready: knowledge.ready === true,
      sources: Array.isArray(knowledge.sources)
        ? knowledge.sources.flatMap((item) => (item !== null && typeof item === 'object'
          ? [{
            route: text((item as Record<string, unknown>).route),
            source: text((item as Record<string, unknown>).source),
            updatedAt: text((item as Record<string, unknown>).updatedAt),
            digest: text((item as Record<string, unknown>).digest),
          }]
          : []))
        : [],
      gaps: Array.isArray(knowledge.gaps) ? knowledge.gaps.map((item) => text(item)) : [],
    },
    providers: listOf(payload.providers, (item) => ({
      id: text(item.id), label: text(item.label), state: text(item.state),
      stateLabel: text(item.stateLabel), detail: text(item.detail),
      loginUrl: text(item.loginUrl),
    })),
    fieldSources: payload.fieldSources !== null && typeof payload.fieldSources === 'object'
      ? Object.fromEntries(Object.entries(payload.fieldSources as Record<string, unknown>).map(([key, value]) => [key, text(value)]))
      : {},
    fieldConflicts: Array.isArray(payload.fieldConflicts)
      ? payload.fieldConflicts.flatMap((item) => (item !== null && typeof item === 'object'
        ? [{
          label: text((item as Record<string, unknown>).label),
          values: Array.isArray((item as Record<string, unknown>).values)
            ? ((item as Record<string, unknown>).values as unknown[]).flatMap((one) => (one !== null && typeof one === 'object'
              ? [{ file: text((one as Record<string, unknown>).file), value: text((one as Record<string, unknown>).value) }]
              : []))
            : [],
        }]
        : []))
      : [],
    prompt: text(payload.prompt),
  }
}

/**
 * 把 `valuation-files-scan` 的 `items` 收成输入页的逐份视图。
 *
 * ## 同名文件加目录摘要
 *
 * 用户原话是"文件显示完整绝对路径，不容易辨认资料"。所以主标题是**文件名**，
 * 只有**重名**的那些才在下面附一行目录摘要（完整路径留在 `title` 与详情里）——
 * 每一行都顶着一长串路径的话，扫一眼还是认不出是哪一份。
 */
export function selectedFilesOf(items: readonly unknown[], fallbackPaths: readonly string[]): ValuationSelectedFileView[] {
  const rows = items.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const raw = item as ScanItemLike
    const path = text(raw.path)
    if (path === '') return []
    return [{
      path,
      name: text(raw.name) || basenameOf(path),
      kind: text(raw.kind),
      sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : 0,
      status: text(raw.status) || 'skipped',
      reason: text(raw.reason),
      fileCount: typeof raw.fileCount === 'number' && Number.isFinite(raw.fileCount) ? raw.fileCount : 1,
    }]
  })
  // 扫描没回话（旧宿主 / 没接线）时退回"只知道路径"的那一份事实：文件名 + 待读取。
  const list = rows.length > 0 ? rows : fallbackPaths.map((path) => ({
    path, name: basenameOf(path), kind: '', sizeBytes: 0, status: 'unknown', reason: '', fileCount: 1,
  }))
  const duplicated = new Map<string, number>()
  for (const row of list) duplicated.set(row.name, (duplicated.get(row.name) ?? 0) + 1)
  return list.map((row) => ({
    ...row,
    status: row.status === 'unknown' ? 'skipped' : row.status,
    dirHint: (duplicated.get(row.name) ?? 0) > 1 ? dirnameOf(row.path) : '',
  }))
}

/** 路径末段（两种分隔符都认；客户端产物不许引 `node:path`）。 */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/** 路径的目录部分（同上，不引 `node:path`）。 */
function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? '' : path.slice(0, index)
}

/** 中介联系方式：五态如实收下来；缺字段给安全默认（**不编**号码）。 */
function contactViewOf(raw: unknown): { state: string; agency: string; person: string; phone: string; detail: string } {
  if (raw === null || typeof raw !== 'object') {
    return { state: '', agency: '', person: '', phone: '', detail: '' }
  }
  const record = raw as Record<string, unknown>
  return {
    state: text(record.state),
    agency: text(record.agency),
    person: text(record.person),
    // 号码原样保留（含脱敏形态）：这里**不做**任何清洗或补全。
    phone: text(record.phone),
    detail: text(record.detail),
  }
}

/** 把 Host 的 result 应答收成结果页视图。 */
export function resultViewOf(payload: Record<string, unknown>): ValuationResultView | null {
  const raw = payload.result
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const artifacts = payload.artifacts !== null && typeof payload.artifacts === 'object'
    ? payload.artifacts as Record<string, unknown>
    : {}
  const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    method: text(record.method),
    methodReason: text(record.methodReason),
    methodScreening: Array.isArray(record.methodScreening)
      ? record.methodScreening.flatMap((item) => (item !== null && typeof item === 'object'
        ? [{
          method: text((item as Record<string, unknown>).method),
          verdict: text((item as Record<string, unknown>).verdict),
          reason: text((item as Record<string, unknown>).reason),
        }]
        : []))
      : [],
    methodConflict: record.methodConflict !== null && typeof record.methodConflict === 'object'
      ? {
        userMethod: text((record.methodConflict as Record<string, unknown>).userMethod),
        adoptedMethod: text((record.methodConflict as Record<string, unknown>).adoptedMethod),
        reason: text((record.methodConflict as Record<string, unknown>).reason),
      }
      : null,
    baseDate: text(record.baseDate),
    unitPrice: numberOrNull(record.unitPrice),
    totalValue: numberOrNull(record.totalValue),
    pricingArea: numberOrNull(record.pricingArea),
    priceUnit: text(record.priceUnit),
    manualConfirmationItems: Array.isArray(record.manual_confirmation_items)
      ? record.manual_confirmation_items.map((item) => text(item)) : [],
    capabilityGaps: Array.isArray(record.capability_gaps) ? record.capability_gaps.map((item) => text(item)) : [],
    cases: Array.isArray(record.cases)
      ? record.cases.flatMap((item) => (item !== null && typeof item === 'object'
        ? [{
          source: text((item as Record<string, unknown>).source),
          sourceLabel: text((item as Record<string, unknown>).source_label),
          url: text((item as Record<string, unknown>).url),
          title: text((item as Record<string, unknown>).title),
          community: text((item as Record<string, unknown>).community),
          transactionType: text((item as Record<string, unknown>).transaction_type),
          usedAsComparable: (item as Record<string, unknown>).used_as_comparable === true,
          unitPrice: numberOrNull((item as Record<string, unknown>).unit_price),
          buildingArea: numberOrNull((item as Record<string, unknown>).building_area),
          keepReason: text((item as Record<string, unknown>).keep_reason),
          dropReason: text((item as Record<string, unknown>).drop_reason),
          status: text((item as Record<string, unknown>).status),
          ruleChecks: Array.isArray((item as Record<string, unknown>).rule_checks)
            ? ((item as Record<string, unknown>).rule_checks as unknown[]).flatMap((one) => (one !== null && typeof one === 'object'
              ? [{
                ruleId: text((one as Record<string, unknown>).rule_id),
                actual: numberOrNull((one as Record<string, unknown>).actual),
                threshold: numberOrNull((one as Record<string, unknown>).threshold),
                verdict: text((one as Record<string, unknown>).verdict),
                reason: text((one as Record<string, unknown>).reason),
              }]
              : []))
            : [],
          capturedAt: text((item as Record<string, unknown>).captured_at),
          evidence: text((item as Record<string, unknown>).evidence),
          evidenceMissing: (item as Record<string, unknown>).evidence_missing === true,
          screenshot: text((item as Record<string, unknown>).screenshot),
          screenshotDigest: text((item as Record<string, unknown>).screenshot_digest),
          screenshotCapturedAt: text((item as Record<string, unknown>).screenshot_captured_at),
          screenshotMissing: (item as Record<string, unknown>).screenshot_missing === true,
          contact: contactViewOf((item as Record<string, unknown>).contact),
        }]
        : []))
      : [],
    artifacts: { html: artifacts.html === true, xlsx: artifacts.xlsx === true, json: artifacts.json === true },
  }
}

export function createReportEvaluationController(
  port: ValuationPort,
  options: { initial?: Partial<ValuationPageState> } = {},
): ReportEvaluationController {
  const clock = port.clock ?? (() => Date.now())
  const scheduleTimeout = port.scheduleTimeout ?? ((handler, ms) => setTimeout(handler, ms))
  const clearScheduledTimeout = port.clearScheduledTimeout
    ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const intakeTimeoutMs = port.intakeTimeoutMs ?? DEFAULT_INTAKE_TIMEOUT_MS
  let state = initialValuationState(options.initial)
  /**
   * 订阅者**集合**，不是单个槽位。
   *
   * 2026-10-13 用户实测：选中资料后文件列表不刷新、确认抽屉也不出来 —— 要切一次页面才看到。
   * 根因就是这里原本只有一个 `listener` 变量，而这一轮面板有**两个**订阅者：
   * 页面外壳（`WorkbenchPanel` 的相位徽标）与估值页本身。React 的 effect 顺序是
   * 子先父后，于是外壳订阅时把估值页那个回调**覆盖**掉 —— 页面再也不重渲染，
   * 直到切页重挂载时重新 `getState()` 才显示新状态。
   *
   * 订阅者数量不该由"谁后订阅"决定：这里改成集合并逐个通知。
   */
  const listeners = new Set<(next: ValuationPageState) => void>()
  /** 提取请求发号器：单调递增，**不回收**（回收会让"上一轮的 3 号"与"这一轮的 3 号"撞上）。 */
  let requestSeq = 0
  /** 当前在途请求的超时句柄；取消 / 完成时清掉。 */
  let intakeTimer: unknown = null

  const write = (next: ValuationPageState): void => {
    state = next
    // 复制一份再遍历：回调里可能会退订（React 卸载时就会），直接遍历会漏掉后面的订阅者。
    for (const notify of [...listeners]) notify(next)
  }
  /** 落地一次状态机结果；被拒时把原因写进 `error`（**不改动别的字段**）。 */
  const apply = (result: { ok: boolean; error: string; state: ValuationPageState }): ValuationPageState => {
    write(result.ok ? result.state : { ...state, error: result.error })
    return state
  }

  /** 清掉在途超时（没有在途请求时是空操作）。 */
  const clearIntakeTimer = (): void => {
    if (intakeTimer === null) return
    clearScheduledTimeout(intakeTimer)
    intakeTimer = null
  }

  /**
   * 扫一遍本机选择，把逐份事实落进 state。
   *
   * 没接 `scan`（旧宿主 / 单测替身）时**不假装扫过**：直接退回"只知道路径"的那一份事实，
   * 界面显示文件名 + 待读取。
   */
  const runScan = (paths: readonly string[]): void => {
    if (paths.length === 0) {
      write({ ...state, files: [], scanState: 'idle', scanError: '' })
      return
    }
    if (port.scan === undefined) {
      const files = selectedFilesOf([], paths)
      write({ ...state, files, scanState: 'ready', scanError: '' })
      return
    }
    apply(beginScan(state))
    const asked = [...paths]
    void Promise.resolve(port.scan({ paths: asked })).then((payload) => {
      // 扫描期间用户又改了选择：这一份结论已经过期，丢掉。
      if (!samePaths(state.selection, asked)) return
      if (payload?.ok === false) {
        apply(scanFailed(state, text(payload.error) || zhCN.valuationScanFailed))
        return
      }
      apply(scanReady(state, selectedFilesOf(payload.items ?? [], asked)))
    }).catch((cause: unknown) => {
      if (!samePaths(state.selection, asked)) return
      apply(scanFailed(state, `${zhCN.valuationScanFailed}：${describe(cause)}`))
    })
  }

  /**
   * 异步查一次外部来源（房天下 / 安居客 / 链家）。
   *
   * 三件事：
   * - **不阻塞**：调用方（进入 `confirmation` 之后）不等它的结果就把抽屉画出来；
   * - **失败不吓人**：查不出来就记「无法检查」，绝不显示成"已登录"；
   * - **不越权**：只回公开状态与公开登录页地址；不读 Cookie、不导出凭据。
   */
  const checkProviders = async (): Promise<void> => {
    if (port.preflight === undefined) {
      apply(providerCheckFailed(state, zhCN.valuationProviderCheckUnsupported))
      return
    }
    try {
      const payload = await port.preflight({})
      if (payload?.ok === false) {
        apply(providerCheckFailed(state, text(payload.error) || zhCN.valuationProviderCheckFailed))
        return
      }
      const view = intakeViewOf({ ...(payload ?? {}), valuationId: state.valuationId }, {
        valuationId: state.valuationId, method: state.method, baseDate: state.baseDate,
        supplementalPrompt: state.supplementalPrompt,
      })
      apply(providerCheckReady(state, view.providers))
    } catch (cause: unknown) {
      apply(providerCheckFailed(state, `${zhCN.valuationProviderCheckFailed}：${describe(cause)}`))
    }
  }

  const controller: ReportEvaluationController = {
    getState: () => state,
    subscribe: (next) => {
      // **不在这里同步回调**：`useSyncExternalStore` 订阅完自己会读一次快照，
      // 而 `useState`/`useEffect` 那两处调用点都先 `getState()` 取了初值。
      // 同步回调放进 React 的订阅路径里只会制造"渲染期间更新别的组件"。
      listeners.add(next)
      return () => { listeners.delete(next) }
    },

    pickFiles: () => {
      // 选择器复用本地审核那一套（浏览器拿不到绝对路径，必须走宿主原生对话框）。
      // 返回的是 `{ ok, paths, unsupported, error }`：不支持时**如实说能力不可用**，
      // 而不是静默什么都不做（那会让用户以为是自己没点中）。
      void pickFile(port).then((picked) => {
        if (!picked.ok) {
          write({ ...state, error: picked.unsupported ? zhCN.valuationPickFilesUnsupported : (picked.error || zhCN.valuationNeedFiles) })
          return
        }
        if (picked.paths.length === 0) return
        apply(setSelection(state, [...state.selection, ...picked.paths]))
        runScan(state.selection)
      }).catch((cause: unknown) => {
        write({ ...state, error: `${zhCN.valuationNeedFiles}（${describe(cause)}）` })
      })
    },
    pickFolder: () => {
      void pickDirectory(port).then((picked) => {
        if (!picked.ok) {
          write({ ...state, error: picked.unsupported ? zhCN.valuationPickFolderUnsupported : (picked.error || zhCN.valuationNeedFiles) })
          return
        }
        if (picked.paths.length === 0) return
        apply(setSelection(state, [...state.selection, ...picked.paths]))
        runScan(state.selection)
      }).catch((cause: unknown) => {
        write({ ...state, error: `${zhCN.valuationNeedFiles}（${describe(cause)}）` })
      })
    },
    removeSelection: (path) => {
      const target = text(path)
      apply(setSelection(state, state.selection.filter((item) => item !== target)))
      runScan(state.selection)
    },
    rescan: () => { runScan(state.selection) },
    setMethod: (method) => { apply(setMethod(state, method)) },
    setBaseDate: (value) => { apply(setBaseDate(state, value)) },
    setPrompt: (value) => { apply(setSupplementalPrompt(state, value)) },

    /**
     * 「检查并确认」。
     *
     * 顺序是**刻意**的（§11.4）：先发号 + 铸 valuationId 写进 state，再进入 `extracting`
     *（同一批 `write` 里发生，所以首帧就能看到"正在提取资料…"和禁用态），最后才发 RPC。
     * 这样做的两个后果都是必需的：
     *
     * - 首帧就有可见反馈：用户点下去不会觉得按钮没反应（这就是那个 bug）；
     * - 提取过程中「取消提取」拿得到 `state.valuationId`，能真的通知宿主取消。
     */
    start: () => {
      const gate = port.ready?.() ?? { ok: true, error: '' }
      if (!gate.ok) {
        write({ ...state, error: gate.error })
        return
      }
      requestSeq += 1
      const requestId = requestSeq
      const valuationId = state.valuationId === '' ? mintClientValuationId(clock) : state.valuationId
      // 同一批里发生：valuationId 落进 state（取消时要用）+ 进入 extracting（首帧反馈）。
      const begun = apply(beginIntake({ ...state, valuationId }, requestId))
      if (begun.phase !== 'extracting') return
      const asked = [...state.selection]
      const method = state.method
      const baseDate = state.baseDate
      const supplementalPrompt = state.supplementalPrompt

      clearIntakeTimer()
      intakeTimer = scheduleTimeout(() => {
        intakeTimer = null
        // 只对**当前**请求超时：换过一次请求之后，旧计时器不该把新请求判死。
        if (!isCurrentIntake(state, requestId)) return
        apply(intakeTimedOut(state))
      }, intakeTimeoutMs)

      void port.intake({
        valuationId,
        method,
        // 基准日**逐字**提交：未选择就是空串，客户端不许拿资料里识别到的日期补一个。
        baseDate,
        supplementalPrompt,
        paths: asked,
      }).then((payload) => {
        // 迟到的响应：用户已经取消 / 返回修改 / 重新提取了 —— 丢掉，不许改现在的状态。
        if (!isCurrentIntake(state, requestId)) return
        clearIntakeTimer()
        if (payload?.ok === false) {
          apply(intakeFailed(state, text(payload.error) || zhCN.valuationPhaseFailed))
          return
        }
        const view = intakeViewOf(payload ?? {}, { valuationId, method, baseDate, supplementalPrompt })
        apply(intakeReady(state, view))
        // 抽屉**已经打开**，来源探测在它打开之后异步跑（§11.2）：
        // 三家站点要联网，绝不能挡在"资料确认信息"前面。
        void checkProviders()
      }).catch((cause: unknown) => {
        if (!isCurrentIntake(state, requestId)) return
        clearIntakeTimer()
        apply(intakeFailed(state, `${zhCN.valuationPhaseFailed}：${describe(cause)}`))
      })
    },

    /**
     * 「取消提取」：客户端立刻回到草稿态，并**作废在途请求**。
     *
     * 宿主侧：如果这一轮已经在案例目录里落了东西，`valuation-cancel` 会把那一轮标记成
     * 已取消；调用失败（例如案例目录还没建）时静默 —— 客户端**不谎称**宿主已停止。
     */
    cancelIntake: () => {
      const valuationId = state.valuationId
      const wasExtracting = state.phase === 'extracting'
      clearIntakeTimer()
      apply(cancelIntake(state))
      if (!wasExtracting || valuationId === '') return
      void port.cancel({ valuationId }).catch(() => undefined)
    },

    backToEdit: () => {
      // 返回修改 = 作废这一次快照：在途请求（如果还有）的响应回来时必须被丢掉。
      clearIntakeTimer()
      apply(resetToDraft(state))
    },

    confirm: () => {
      const intake = state.intake
      if (intake === null) {
        write({ ...state, error: zhCN.valuationNotInConfirmation })
        return
      }
      const confirmed = apply(confirmAndStart(state))
      if (confirmed.phase !== 'queued') return
      void port.start({
        valuationId: state.valuationId,
        method: state.method,
        // 基准日**逐字**提交：未选择就是空串，客户端不许拿资料里识别到的日期补一个。
        baseDate: state.baseDate,
        supplementalPrompt: state.supplementalPrompt,
        confirmedSnapshotDigest: intake.digest,
      }).then((payload) => {
        if (payload?.ok === false) {
          write({ ...state, phase: 'failed', error: text(payload.error) || zhCN.valuationPhaseFailed })
          return
        }
        apply(applyStatus(state, {
          phase: 'running',
          sessionId: text(payload?.sessionId),
          casePath: text(payload?.casePath),
          progress: { stage: zhCN.valuationStageQueued, detail: '', completed: 1, total: 4 },
        }))
      }).catch((cause: unknown) => {
        write({ ...state, phase: 'failed', error: `${zhCN.valuationPhaseFailed}：${describe(cause)}` })
      })
    },

    cancel: () => {
      const valuationId = state.valuationId
      clearIntakeTimer()
      apply(cancelValuation(state))
      if (valuationId === '') return
      void port.cancel({ valuationId }).catch(() => undefined)
    },

    recheck: () => {
      // 「重新检查」= 再问一次宿主：它同时刷新来源状态，并让被阻塞的那一轮继续。
      void checkProviders()
      void port.recheck?.().then((payload) => {
        if (payload?.ok === false) return
        const phase = text(payload.phase)
        if (!isValuationPhase(phase)) return
        apply(applyStatus(state, {
          phase,
          sessionId: text(payload.sessionId),
          casePath: text(payload.casePath),
          progress: payload.progress !== null && typeof payload.progress === 'object'
            ? payload.progress as ValuationPageState['progress']
            : undefined,
          providerStates: payload.providerStates !== null && typeof payload.providerStates === 'object'
            ? payload.providerStates as ValuationPageState['providerStates']
            : undefined,
        }))
      }).catch((cause: unknown) => {
        write({ ...state, error: describe(cause) })
      })
    },

    openLogin: (providerId) => {
      // 打开的是**该站点自己的公开登录页**；不读 Cookie、不导出凭据（宿主侧同一条口径）。
      void port.preflight?.({ openLogin: providerId }).catch((cause: unknown) => {
        write({ ...state, error: describe(cause) })
      })
    },

    openArtifact: (name) => {
      void port.openArtifact({ valuationId: state.valuationId, name }).catch((cause: unknown) => {
        write({ ...state, error: describe(cause) })
      })
    },

    markStale: () => { write(markHostStale(state)) },

    poll: () => {
      if (state.valuationId === '') return
      const extracting = state.phase === 'extracting'
      const requestId = state.intakeRequestId
      void port.status({ valuationId: state.valuationId }).then((payload) => {
        if (payload?.ok === false) return
        const phase = text(payload.phase)
        if (!isValuationPhase(phase)) return
        // 提取阶段只取**阶段文字**，不按宿主阶段改页面：
        // 这一次 RPC 还没回来，页面就该停在"正在提取资料"，等它自己带回收据。
        // （宿主此刻可能已经走到 confirmation，那时抽屉还没有数据，切过去只会闪一下空白。）
        if (extracting) {
          const progress = payload.progress !== null && typeof payload.progress === 'object'
            ? payload.progress as ValuationPageState['progress']
            : undefined
          if (progress !== undefined) apply(intakeStage(state, requestId, progress.stage))
          return
        }
        // 交付件存在性：它是"部分结果"的判据，也是结果页说"缺哪一件"的依据。
        const artifacts = payload.artifacts !== null && typeof payload.artifacts === 'object'
          ? payload.artifacts as { html: boolean; xlsx: boolean; json: boolean }
          : undefined
        if (artifacts !== undefined) apply(applyArtifacts(state, artifacts))
        apply(applyStatus(state, {
          phase,
          sessionId: text(payload.sessionId),
          casePath: text(payload.casePath),
          error: text(payload.recordError),
          progress: payload.progress !== null && typeof payload.progress === 'object'
            ? payload.progress as ValuationPageState['progress']
            : undefined,
          providerStates: payload.providerStates !== null && typeof payload.providerStates === 'object'
            ? payload.providerStates as ValuationPageState['providerStates']
            : undefined,
        }))
        if (phase === 'completed') {
          void port.result({ valuationId: state.valuationId }).then((resultPayload) => {
            const view = resultViewOf(resultPayload ?? {})
            if (view !== null) apply(applyResult(state, view))
          }).catch(() => undefined)
          return
        }
        // **部分结果**（§4）：轮次没跑完（失败 / 取消），但已经有交付件产出 ——
        // 那些产出要看得见，只是阶段保持原样（结果页据此打"阶段结果"的标记，不给正式结论的观感）。
        const partial = (phase === 'failed' || phase === 'cancelled') && hasAnyArtifact(state)
        if (!partial) return
        void port.result({ valuationId: state.valuationId }).then((resultPayload) => {
          // 阶段可能在这一刻又变了（例如用户重新提取）：只在仍是同一轮、且仍没跑完时落地。
          if (state.phase !== 'failed' && state.phase !== 'cancelled') return
          const view = resultViewOf(resultPayload ?? {})
          if (view !== null) apply(applyPartialResult(state, view))
        }).catch(() => undefined)
      }).catch(() => undefined)
    },
  }
  return controller
}

/** Host 的阶段词收窄（认不出来就**不推进**，而不是猜一个）。 */
export function isValuationPhase(value: unknown): value is ValuationPageState['phase'] {
  const raw = text(value)
  return ['draft', 'extracting', 'confirmation', 'queued', 'running', 'browser-login-required',
    'completed', 'failed', 'cancelled', 'stale-host'].includes(raw)
}

/** 方法收窄（供面板把界面值转回控制器入参）。 */
export function asMethod(value: unknown): ValuationMethod | null {
  return isValuationMethod(value) ? value : null
}

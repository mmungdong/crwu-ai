import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import type { OperationArgs, OperationMap } from './types.ts'
import type { LocalAccessBroker } from '../core/access/broker.ts'
import type { WorkbenchState } from '../core/state/types.ts'
import type { WorldFacts } from '../core/platform/world.ts'
import type { PythonRuntimeResolver } from '../core/runtime/python.ts'
import { copyCommand, openExternalCommand } from '../core/platform/shell.ts'
import { fileSystem, isFile, readTextIfExists } from '../core/fs/paths.ts'
import { ensureCaseDirectory, ensurePanelCaseDirectory, writePanelCaseFile } from '../tools/common/case-files.ts'
import { canonicalJson, digestOnly } from '../tools/common/snapshot.ts'
import { scanSelection, nodeLocalAuditFs } from '../domains/local-audit/scan.ts'
import { LOCAL_AUDIT_MAX_FILES } from '../domains/local-audit/consts.ts'
import { workspaceSessionService } from '../core/workspace-session/index.ts'
import { ALL_PROVIDER_IDS, preflightProviders, uncheckedProviders } from '../domains/report-evaluation/browser/preflight.ts'
import { siteOf } from '../domains/report-evaluation/browser/providers.ts'
import { fetchTransport } from '../domains/report-evaluation/browser/fetch-transport.ts'
import type { ValuationScreenshotCapability } from '../domains/report-evaluation/browser/capture.ts'
import type { MarketTransport } from '../domains/report-evaluation/browser/provider.ts'
import { isMarketProviderId, providerLabel } from '../domains/report-evaluation/browser/login-state.ts'
import {
  VALUATION_KNOWLEDGE_SPACE,
  resolveKnowledgePlan,
  localKnowledgeProbe,
  knowledgeSourcesView,
} from '../domains/report-evaluation/knowledge/index.ts'
import { frozenInputMismatch, isSafeValuationId, isValuationMethod, type ValuationMethod } from '../domains/report-evaluation/scope.ts'
import { pythonFileExtractor, runExtraction } from '../domains/report-evaluation/intake/index.ts'
import { ValuationLifecycles } from '../domains/report-evaluation/lifecycle/index.ts'
import type { ValuationRecord } from '../domains/report-evaluation/lifecycle/index.ts'
import type { ValuationPhase } from '../domains/report-evaluation/lifecycle/index.ts'
import { ValuationScopes } from '../domains/report-evaluation/scope.ts'
import { valuationPrompt } from '../domains/report-evaluation/prompt.ts'
import { kindOf, type ValuationFileKind } from '../domains/report-evaluation/intake/classify.ts'
import { buildIntakeManifest, sha256OfBytes } from '../domains/report-evaluation/intake/manifest.ts'
import {
  VALUATION_INPUT_FILE,
  VALUATION_MATERIAL_DIR,
  VALUATION_REPORT_FILE,
  VALUATION_RESULT_FILE,
  VALUATION_WORKBOOK_FILE,
} from '../tools/report-evaluation/consts.ts'
import { VALUATION_OUTPUT_FILES } from '../tools/report-evaluation/artifacts.ts'
import { missingValuationTools, valuationToolsMissingText } from '../tools/report-evaluation/visibility.ts'

/**
 * 报告评估（房地产估值）的八个 Host 操作（协议 32，对应方案 §11）。
 *
 * | 操作 | 做什么 | 谁调 |
 * | --- | --- | --- |
 * | `valuation-files-scan` | 展开一次本机选择（文件夹 → 文件），只回事实 | 面板 |
 * | `valuation-intake` | 校验 → 建案例目录 → 复制资料 → 提取 → 生成输入清单与提取摘要（确认抽屉的数据源） | 面板 |
 * | `valuation-browser-preflight` | 逐家预检外部来源；可代为打开默认浏览器登录 | 面板 |
 *
 * ⚠️ **`valuation-intake` 不碰外部站点**（2026-10-13）：它以前会在返回确认数据**之前**
 * 串行预检房天下 / 安居客 / 链家，每家最多 20 秒 —— 三家连续失败时按钮要等约一分钟才有反应，
 * 用户读到的就是"点了没反应"。现在它只做本机的事（复制 + 提取 + 知识库路由），来源状态先给
 * 三行「尚未检查」，真正的探测由 `valuation-browser-preflight` 在**抽屉打开之后**异步跑。
 * | `valuation-start` | **冻结输入快照** → 建估值会话（统一工作区落点）→ 发固定指令 | 面板 |
 * | `valuation-status` | 阶段 / 进度 / 来源状态 / 缺口 / 协议代数 | 面板（轮询） |
 * | `valuation-cancel` | 取消一轮（终态不可取消） | 面板 |
 * | `valuation-result` | 读结果与交付件存在性 | 面板 |
 * | `valuation-open-artifact` | 用默认程序打开案例目录内的交付件 | 面板 |
 *
 * ## 三条口径
 *
 * 1. **输入在 `valuation-start` 那一刻冻结**。`valuation-intake` 给抽屉看的东西只是预览；
 *    确认后 Host 重新校验并写下 `估值输入.json`，其指纹随会话与结果一起留痕。
 *    子会话拿不到改写方法 / 基准日 / 补充要求的参数（见 `crwu_valuation_case_bootstrap`）。
 * 2. **基准日绝不自作主张**：`baseDate` 为空就写空串，并在结果里要求登记「本次未指定评估基准日」。
 * 3. **落点只走统一会话服务**（协议 32）：`workspaceId` 决定会话落在哪个工作区，
 *    这里不出现 `cwd` 兜底。
 */

export interface ValuationOpsDeps {
  ctx: Context
  state: WorkbenchState
  access: LocalAccessBroker
  world: WorldFacts
  python?: PythonRuntimeResolver
  /** 轮次状态机（进程内，随插件生命周期）。 */
  lifecycles: ValuationLifecycles
  /**
   * 估值案例 scope（子会话的案例归属）。
   *
   * 这里要的是**有写能力**的实现类而不是只读接口：操作表负责开/关 scope，
   * 而工具侧只需要读（`ValuationScopeRegistry` 那个窄接口）。
   */
  scopes: ValuationScopes
  /**
   * 外部来源的抓取通道。
   *
   * 与估值 Tool 同一条口径（`valuationMarketSearchTools(deps, transport?)`）：**缺省走真实
   * `fetch`，测试注入内存替身**。为什么不写死：这两条操作（`valuation-intake` 的登录状态预检、
   * `valuation-browser-preflight`）都要问三家站点，写死之后 ① 面板每开一次确认抽屉都要等真实网络
   * （离线时等到超时），② 这两条操作**没法测** —— 而"没人跑过的操作"正是最容易坏的那一类。
   */
  transport?: MarketTransport
  /**
   * 页面截图通道（§7.4）。
   *
   * 面板侧只用它判断"本部署能不能截图"，从而决定"采用案例缺截图"算不算阻塞完成：
   * 有通道却缺截图 = 任务没做完；没通道 = 已登记的能力缺口（不是子会话的疏漏）。
   */
  screenshot?: ValuationScreenshotCapability
}

/** 提取摘要（确认抽屉逐行显示）。 */
interface IntakeFileView {
  fileName: string
  relativePath: string
  kind: string
  sizeBytes: number
  sha256: string
  /** 解析状态：`parsed` / `unparsed`。 */
  status: string
  /** 提取到的字段数（未解析时为 0）。 */
  fieldCount: number
  note: string
}

interface IntakeView {
  ok: boolean
  errorKind: string
  error: string
  valuationId: string
  casePath: string
  method: string
  baseDate: string
  supplementalPrompt: string
  digest: string
  files: IntakeFileView[]
  /** 提取到的已知信息（标签锚定，全部是字符串）。 */
  extractedFields: Record<string, string>
  /** 界面要展示的要素清单里缺哪些（顺序固定）。 */
  missingFields: string[]
  unparsed: string[]
  capabilityGaps: string[]
  warnings: string[]
  knowledge: {
    space: string
    ready: boolean
    sources: Array<{ route: string; source: string; updatedAt: string; digest: string }>
    gaps: string[]
  }
  providers: Array<{ id: string; label: string; state: string; stateLabel: string; detail: string }>
  /**
   * 每个已知要素**来自哪一份资料**（标签 → 文件名）。
   *
   * 抽屉要求"每项关键事实的来源"（方案 §5.4）。页码 / 工作表位置这一层提取器不给
   * （它只回标签与值），所以这里如实标成"以文件为单位"，并在抽屉里说明这一限制。
   */
  fieldSources: Record<string, string>
  /**
   * **资料之间的冲突**：同一个要素被多份资料给出了不同的值。
   *
   * 以前这里是"首个非空值胜出"、后面不同的一律**静默丢掉**。那很危险：两份资料对"建筑面积"
   * 给了两个数时，用户看到的是一张干净的表，而系统已经替他做了一个他没看见的选择。
   * 现在把冲突如实列出来，并在抽屉里说明"当前采用哪一份"。
   */
  fieldConflicts: Array<{ label: string; values: Array<{ file: string; value: string }> }>
  /**
   * 将要提交给估值会话的**完整业务提示词**。
   *
   * 与 `valuation-start` 用的是**同一个构造器 + 同一批参数**，所以只要快照指纹一致
   *（`valuation-start` 会核对），用户在这里看到的就是执行时逐字发出去的那一份。
   */
  prompt: string
}

/** 确认抽屉要展示的估值要素（缺失时逐条列出）。 */
export const VALUATION_FIELD_KEYS = [
  '坐落', '房屋性质', '用途', '建筑面积', '楼层', '总楼层', '建筑结构',
  '建成年代', '权属信息', '租赁信息', '价格信息', '已知案例线索',
] as const

function methodOf(value: unknown): ValuationMethod | '' {
  const raw = text(value).trim()
  return isValuationMethod(raw) ? raw : ''
}

/** 选择清单（绝对路径，顺序即用户选择顺序）。 */
function selectionOf(args: Record<string, unknown>): string[] {
  const raw = args.paths
  if (!Array.isArray(raw)) return []
  return raw.map((item) => text(item).trim()).filter((item) => item !== '')
}

/** 形态：只回事实，不回路径之外的东西。 */
export function createValuationOperations(deps: ValuationOpsDeps): OperationMap {
  const { ctx, state, access, world } = deps
  const pickTransport = (): MarketTransport => deps.transport ?? fetchTransport({})

  const caseDirOfValuation = async (valuationId: string): Promise<{ ok: boolean; error: string; casePath: string }> => {
    if (!isSafeValuationId(valuationId)) {
      return { ok: false, error: '估值 ID 不合法：必须是单段目录名（不含分隔符与 `..`）', casePath: '' }
    }
    const selected = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
    if (!selected.ok) return { ok: false, error: selected.error, casePath: '' }
    return { ok: true, error: '', casePath: joinLocalPath(selected.workspace.path, valuationId) }
  }

  const operations: OperationMap = {
    // ── ① 扫描本机选择 ──────────────────────────────────────────────────────
    'valuation-files-scan': async (args) => {
      const selection = selectionOf(args)
      if (selection.length === 0) {
        return { ok: true, error: '', errorKind: '', fileCount: 0, limit: LOCAL_AUDIT_MAX_FILES, overLimit: false, readableCount: 0, skippedCount: 0, items: [] }
      }
      const scan = await scanSelection(selection, nodeLocalAuditFs())
      return {
        ok: scan.ok,
        error: scan.ok ? '' : scan.error,
        errorKind: scan.errorKind,
        fileCount: scan.fileCount,
        limit: LOCAL_AUDIT_MAX_FILES,
        overLimit: scan.overLimit,
        readableCount: scan.readableCount,
        skippedCount: scan.skippedCount,
        items: scan.items,
      }
    },

    // ── ② 资料入口：建目录 + 复制 + 清单 + 提取 ────────────────────────────
    'valuation-intake': async (args) => {
      const valuationId = text(args.valuationId).trim()
      const method = methodOf(args.method)
      // 基准日逐字读进来（未选择 = 空串）。**只做形状校验，绝不补一个日期**：
      // 补出来的基准日会改变交易日期修正与收益年限，而那是看不出来的（§11.5）。
      const baseDate = text(args.baseDate).trim()
      const resolved = await caseDirOfValuation(valuationId)
      const empty: IntakeView = {
        ok: false, errorKind: '', error: resolved.error, valuationId, casePath: resolved.casePath,
        method: method || 'auto', baseDate, supplementalPrompt: '', digest: '',
        files: [], extractedFields: {}, missingFields: [...VALUATION_FIELD_KEYS], unparsed: [],
        capabilityGaps: [], warnings: [],
        knowledge: { space: VALUATION_KNOWLEDGE_SPACE, ready: false, sources: [], gaps: [] },
        providers: [],
        fieldSources: {},
        fieldConflicts: [],
        prompt: '',
      }
      if (!resolved.ok) return { ...empty, errorKind: 'input' }
      if (method === '') return { ...empty, errorKind: 'input', error: '评估方法不合法：只允许 auto / market / income / cost' }
      if (baseDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
        return { ...empty, errorKind: 'input', error: `评估基准日形状不对（应为 YYYY-MM-DD）：${baseDate}` }
      }
      const casePath = resolved.casePath
      const workspace = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
      if (!workspace.ok) return { ...empty, errorKind: 'policy', error: workspace.error }

      // 轮次登记必须**早于**任何耗时步骤：阶段要有地方记，取消也要有一条记录可取消。
      if (deps.lifecycles.get(valuationId) === undefined) {
        deps.lifecycles.open({
          valuationId, casePath, workspaceId: workspace.workspace.id, workspacePath: workspace.workspace.path,
          method, baseDate, supplementalPrompt: text(args.supplementalPrompt),
          digest: '',
        })
      }
      advanceThrough(deps.lifecycles, valuationId, ['extracting'])
      noteIntakeStage(deps.lifecycles, valuationId, INTAKE_STAGES.checking)

      // 本机选择先扫一遍：只信**这一次**扫描的结果（两次调用之间用户可能换了选择）。
      const selection = selectionOf(args)
      const scan = selection.length === 0
        ? { ok: false, errorKind: 'input', error: '还没有选择任何资料：请先选择要估值的文件或文件夹。', items: [] as Array<{ path: string; name: string; kind: string; sizeBytes: number; status: string; reason: string; fileCount: number }> }
        : await scanSelection(selection, nodeLocalAuditFs())
      if (!scan.ok) return { ...empty, errorKind: scan.errorKind || 'input', error: scan.error }

      const platform = await world.platform()
      const workdir = await world.workdir()
      const made = await ensureCaseDirectory(access, casePath, { workspace: workspace.workspace.path, probeWorkdir: workdir, platform })
      if (!made.ok) return { ...empty, errorKind: made.errorKind || 'infrastructure', error: `创建估值案例目录失败：${made.error}` }
      const materialDir = joinLocalPath(casePath, VALUATION_MATERIAL_DIR)
      // **面板来源**、逐次声明提权的那一条：不借审核子代理的 `system.case-file.write`
      //（面板没有会话，那条会落回部署默认的沙箱，`mkdir` 被判 `Operation not permitted`）。
      const materialMade = await ensurePanelCaseDirectory(access, materialDir, {
        operation: 'system.valuation-case.directory.write', workdir, platform,
      })
      if (!materialMade.ok) return { ...empty, errorKind: 'infrastructure', error: `创建资料目录失败：${materialMade.error}` }

      // 复制资料进案例目录并算指纹。
      //
      // ⚠️ **必须按字节复制**：`.pdf` / `.xlsx` / 图片都是二进制，走 `readText` + `writeText`
      // 会得到"看起来正常、内容已损坏"的副本，而下游只会说"这份读不出来"。
      // 所以：读字节算指纹走 node fs（与本地审核读员工本机资料是同一条路），
      // 写进案例目录走 Broker 的 `system.valuation-material.copy`（面板来源的那一条）
      // 执行操作系统的复制命令 —— **不能**借审核子代理的 `system.case-file.write`：
      // 那条只允许 `audit-tool`，用了它每一份资料都会被 Broker 拒掉。
      noteIntakeStage(deps.lifecycles, valuationId, INTAKE_STAGES.copying, '', 0, scan.items.length)
      const manifestInputs: Array<{ fileName: string; relativePath: string; kind: ValuationFileKind; sizeBytes: number; sha256: string }> = []
      const files: IntakeFileView[] = []
      const seen = new Set<string>()
      for (const item of scan.items) {
        // 每落一份就更新一次"已复制 N / M"：这是**真实**的完成数量，不是估算的百分比。
        noteIntakeStage(deps.lifecycles, valuationId, INTAKE_STAGES.copying, item.name, files.length, scan.items.length)
        if (item.status !== 'scanned') {
          files.push({
            fileName: item.name, relativePath: '', kind: kindOf(item.name), sizeBytes: item.sizeBytes,
            sha256: '', status: 'unparsed', fieldCount: 0, note: item.reason || '跳过（不可读或不是普通文件）',
          })
          continue
        }
        let relativeName = item.name
        let index = 2
        while (seen.has(relativeName)) {
          const dot = item.name.lastIndexOf('.')
          relativeName = dot <= 0
            ? `${item.name}-${index}`
            : `${item.name.slice(0, dot)}-${index}${item.name.slice(dot)}`
          index += 1
        }
        seen.add(relativeName)
        const relativePath = joinLocalPath(VALUATION_MATERIAL_DIR, relativeName)
        const copied = await copyMaterial(deps, {
          sourcePath: item.path,
          destinationPath: joinLocalPath(casePath, relativePath),
          platform,
          workdir,
        })
        if (!copied.ok) {
          files.push({
            fileName: relativeName, relativePath, kind: kindOf(relativeName), sizeBytes: item.sizeBytes,
            sha256: '', status: 'unparsed', fieldCount: 0, note: copied.error,
          })
          continue
        }
        manifestInputs.push({
          fileName: relativeName, relativePath, kind: kindOf(relativeName),
          sizeBytes: copied.bytes, sha256: copied.digest,
        })
        files.push({
          fileName: relativeName, relativePath, kind: kindOf(relativeName), sizeBytes: copied.bytes,
          sha256: copied.digest, status: 'parsed', fieldCount: 0, note: '',
        })
      }

      const manifest = buildIntakeManifest({ files: manifestInputs })
      // **面板写案例目录里的文件必须逐次声明提权**：面板没有会话，`ctx.fs` 会落到部署默认
      // （workspace-write + 进程 cwd），而案例目录在员工选定的工作空间里 —— 非提权写入被自家
      // 沙箱拦成 `file access denied under workspace-write mode`（2026-10-13 用户实测）。
      const written = await writePanelCaseFile(access, {
        ctx, path: joinLocalPath(casePath, '资料清单.json'), content: canonicalJson(manifest),
        workspaceRoot: workspace.workspace.path, workdir,
      })
      if (!written.ok) {
        return {
          ...empty, files,
          errorKind: written.errorKind === 'policy' ? 'policy' : 'infrastructure',
          error: `输入清单落盘失败：${written.error}`,
        }
      }

      noteIntakeStage(deps.lifecycles, valuationId, INTAKE_STAGES.knowledge)

      // 知识状态：预检知识库（只读），让抽屉能显示"规范来自哪里 / 缺哪一份"。
      // 抽屉本身就是状态机里的「待确认」阶段：`confirmation` 在快照指纹落定后再推。
      const knowledge = await resolveKnowledgePlan({
        method,
        probe: { dws: () => ({ found: false, error: '面板预检不取正文' }), local: localKnowledgeProbe() },
      })
      noteIntakeStage(deps.lifecycles, valuationId, INTAKE_STAGES.preparing)

      // 外部来源：**只给三行"尚未检查"，一次网络都不发**（见文件头的 §11.2 说明）。
      // 真正的探测由抽屉打开之后的 `valuation-browser-preflight` 异步做，结果局部更新。
      const providers = uncheckedProviders(ALL_PROVIDER_IDS)

      // **真的提取一次**，把抽屉的"已知信息"填出来。
      //
      // 为什么必须在确认之前做：抽屉是用户核对输入的唯一机会，而 §5.4 要它显示
      // "PDF/Word/Excel/图片提取出的已知信息 + 缺失信息 + 未解析文件"。不提取的话，
      // 这三块只能是"12 项全缺 + 每份都写着 parsed" —— 那不是核对，是让用户对着空表点确认。
      // （`deps.python` 一直是装配好的，此前只是没人用。）
      noteIntakeStage(deps.lifecycles, valuationId, INTAKE_STAGES.extracting, '', 0, manifestInputs.length)
      const extracted = await runExtraction({
        files: manifestInputs.map((item) => ({
          path: joinLocalPath(casePath, item.relativePath),
          fileName: item.fileName,
          kind: item.kind,
        })),
        extractors: [pythonFileExtractor({
          ctx,
          access: deps.access,
          python: deps.python,
          world: { platform: () => deps.world.platform() },
          casePath,
        })],
      })
      const extractedFields: Record<string, string> = {}
      const fieldSources: Record<string, string> = {}
      // 每个要素的**全部**取值（用来发现冲突；采用哪一个由下面的"首个非空值"决定）。
      const fieldValues: Record<string, Array<{ file: string; value: string }>> = {}
      for (const file of extracted.files) {
        for (const [key, value] of Object.entries(file.extractedFields)) {
          const label = text(key)
          const rendered = text(value)
          if (label === '' || rendered === '') continue
          const seen = fieldValues[label] ?? []
          seen.push({ file: file.fileName, value: rendered })
          fieldValues[label] = seen
          // 首个非空值胜出：多份资料给同一个要素时，先写的那份是用户选择清单里的顺序。
          if (text(extractedFields[label]) === '') {
            extractedFields[label] = rendered
            // 来源与值**同一条判据**：谁的值被采用，来源就是谁。分开判会在多份资料冲突时对不上。
            fieldSources[label] = file.fileName
          }
        }
      }
      // 冲突 = 同一个要素出现了**不止一个不同的值**（值相同的重复不算冲突）。
      const fieldConflicts = Object.entries(fieldValues)
        .filter(([, list]) => new Set(list.map((item) => item.value)).size > 1)
        .map(([label, values]) => ({ label, values }))
      // 文件的"解析状态"要说实话：`parsed` 只在**提取器真的读过它**时才给。
      // 复制成功 != 解析成功 —— 把两者混为一谈，抽屉就会把一份没读过的 PDF 显示成"已解析"。
      const parsedNames = new Set(extracted.files.map((file) => file.fileName))
      for (const item of files) {
        if (item.status !== 'parsed') continue
        if (parsedNames.has(item.fileName)) {
          item.fieldCount = Object.keys(extracted.files.find((file) => file.fileName === item.fileName)?.extractedFields ?? {}).length
          continue
        }
        item.status = 'unparsed'
        item.note = '已归档到案例目录，但内容没有提取出来（详见未解析清单）'
      }
      const gaps = [...knowledge.capabilityGaps, ...extracted.capabilityGaps]
      const warnings: string[] = [...extracted.warnings]
      const unparsed = files.filter((item) => item.status !== 'parsed').map((item) => item.fileName)
      if (unparsed.length > 0) {
        gaps.push(`未解析的资料：${unparsed.join('、')}（读不出来就说读不出来，不许按文件名猜内容）`)
      }
      // 提取结论落盘：抽屉展示的是**预览**，子会话仍会自己再提取一次（那是权威副本）。
      // 记下来是为了让"用户当时看到的是哪些字段"可复核 —— 否则确认与结果之间无据可查。
      const extractWritten = await writePanelCaseFile(access, {
        ctx, path: joinLocalPath(casePath, '资料提取预览.json'),
        workspaceRoot: workspace.workspace.path, workdir,
        content: canonicalJson({
        schema: 'crwu.valuation.extract-preview.v1',
        files: extracted.files.map((file) => ({
          fileName: file.fileName,
          fileType: file.fileType,
          textLength: file.text.length,
          tableCount: file.tables.length,
          imageCount: file.images.length,
          extractedFields: { ...file.extractedFields },
          warnings: [...file.warnings],
        })),
        unparsed: [...extracted.unparsed],
          extractedFields,
          capabilityGaps: [...gaps],
        }),
      })
      if (!extractWritten.ok) warnings.push(`提取预览没能落盘：${extractWritten.error}`)
      const missing = VALUATION_FIELD_KEYS.filter((key) => text(extractedFields[key]) === '')
      // 冲突要能被复核：写明"当前采用哪一份"（首个非空值），而不是让用户对着一张干净的表确认。
      for (const conflict of fieldConflicts) {
        warnings.push(
          `资料冲突：${conflict.label} 在多份资料里不一致（`
          + conflict.values.map((item) => `${item.file}＝${item.value}`).join('；')
          + `），当前采用「${fieldSources[conflict.label] ?? ''}」那一份；请确认后再继续。`,
        )
      }

      // 确认数据已经备齐：现在才把快照指纹写进这一轮，并推进到 `confirmation`。
      const record = deps.lifecycles.get(valuationId)
      if (record !== undefined) {
        deps.lifecycles.update(valuationId, record.phase, {
          progress: { stage: INTAKE_STAGES.preparing, detail: '', completed: 0, total: 0 },
          // 指纹在清单算完之后才知道，这里补进这一轮（`valuation-start` 会用它对账）。
          digest: manifest.digest,
        })
      }
      advanceThrough(deps.lifecycles, valuationId, ['extracting', 'confirmation'])

      return {
        ok: true,
        errorKind: '',
        error: '',
        valuationId,
        casePath,
        method,
        // 回显的是**用户提交的那一份**（未选择就是空串）：抽屉据此显示「本次未指定评估基准日」。
        baseDate,
        supplementalPrompt: text(args.supplementalPrompt),
        digest: manifest.digest,
        files,
        extractedFields,
        missingFields: [...missing],
        unparsed,
        capabilityGaps: gaps,
        warnings,
        knowledge: {
          space: VALUATION_KNOWLEDGE_SPACE,
          ready: knowledge.ok,
          sources: knowledgeSourcesView(knowledge.sources),
          gaps: knowledge.capabilityGaps,
        },
        providers,
        fieldSources,
        fieldConflicts,
        // 提示词用**与 `valuation-start` 同一个构造器、同一批参数**生成：
        // 那里的 `extraction` / `knowledge` / `providers` 也都是常量形态，所以两侧逐字一致。
        prompt: valuationPrompt({
          valuationId, casePath, method, baseDate, supplementalPrompt: text(args.supplementalPrompt),
          digest: manifest.digest,
          files: manifestInputs,
          extraction: manifestInputs.map((file) => ({
            fileName: file.fileName, parsed: true, fieldCount: 0, note: '',
          })),
          knowledge: [],
          knowledgeReady: true,
          providers: [],
          validateScripts: [
            { name: '工作簿契约', script: `${casePath}/scripts/check_workbook_contract.py`, args: [`${casePath}/${VALUATION_WORKBOOK_FILE}`] },
            { name: '结果口径', script: `${casePath}/scripts/validate_result.py`, args: [`${casePath}/${VALUATION_RESULT_FILE}`] },
          ],
        }),
      }
    },

    // ── ③ 外部来源预检（可代开默认浏览器） ────────────────────────────────
    'valuation-browser-preflight': async (args) => {
      const providers = await preflightProviders({ transport: pickTransport(), ids: ALL_PROVIDER_IDS })
      const openLogin = text(args.openLogin).trim()
      let openError = ''
      let opened = false
      if (openLogin !== '') {
        if (!isMarketProviderId(openLogin)) {
          return { ok: false, error: `未知来源：${openLogin}`, providers, opened: false, openError: '' }
        }
        // 面板来源的**特权**操作：只打开站点自己的登录页，不读 Cookie、不碰凭据。
        const run = await access.runShell(
          { operation: 'system.browser.open', source: 'panel', workdir: await world.workdir() },
          openExternalCommand(siteOf(openLogin).loginUrl, await world.platform()),
          { timeoutMs: 30_000, summary: 'system.browser.open' },
        )
        opened = run.ok
        openError = run.ok ? '' : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 200)
      }
      return { ok: true, error: '', providers, opened, openError }
    },

    // ── ④ 开始估值：冻结快照 + 建会话 + 发指令 ────────────────────────────
    'valuation-start': async (args) => {
      const valuationId = text(args.valuationId).trim()
      const method = methodOf(args.method)
      const resolved = await caseDirOfValuation(valuationId)
      if (!resolved.ok) return { ok: false, error: resolved.error, valuationId, casePath: '' }
      if (method === '') return { ok: false, error: '评估方法不合法：只允许 auto / market / income / cost', valuationId, casePath: resolved.casePath }
      const casePath = resolved.casePath

      // 幂等：同一 valuationId **真的已经开过**就直接返回（重复点"确认"不该起两条会话）。
      //
      // ⚠️ "记录存在"≠"已经开过"：`valuation-intake` 为了记阶段与支持取消，**在提取开始前**
      // 就已经开了这条记录（phase 停在 `extracting` / `confirmation`，没有 sessionId）。
      // 早先这里只判 `existing !== undefined`，于是点「确认并开始估值」时直接走了幂等分支：
      // 返回 `ok:true` 但**根本没建会话、没落 `估值输入.json`、没发指令** ——
      // 界面进了"运行中"，实际什么都没跑（2026-10-13 用户实测："点了确认无法自动开始"）。
      //
      // 判据改成"有没有真的开过"：有会话，或阶段已经越过确认。
      const existing = deps.lifecycles.get(valuationId)
      const stubPhases: readonly string[] = ['draft', 'extracting', 'confirmation']
      const alreadyStarted = existing !== undefined
        && (existing.sessionId !== '' || !stubPhases.includes(existing.phase))
      if (alreadyStarted && existing !== undefined) {
        return { ok: true, error: '', valuationId, casePath: existing.casePath, sessionId: existing.sessionId, phase: existing.phase, reused: true }
      }

      const selected = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
      if (!selected.ok) return { ok: false, error: selected.error, valuationId, casePath }
      const workspace = selected.workspace

      // 输入清单必须以**磁盘上的实际内容**为准重算一次（`valuation-intake` 的预览不可信）。
      const manifestView = await readManifest(ctx, casePath)
      if (!manifestView.ok) return { ok: false, error: manifestView.error, valuationId, casePath }
      const confirmed = text(args.confirmedSnapshotDigest).trim()
      if (confirmed !== '' && confirmed !== manifestView.digest) {
        return {
          ok: false,
          error: `输入快照已经变了（确认时 ${confirmed}，现在是 ${manifestView.digest}）：请返回修改并重新确认。`,
          valuationId, casePath,
        }
      }

      // 基准日只认用户提交的值：空就是空，绝不从资料里识别到的日期补一个。
      const baseDate = text(args.baseDate).trim()
      if (baseDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
        return { ok: false, error: `评估基准日形状不对（应为 YYYY-MM-DD）：${baseDate}`, valuationId, casePath }
      }
      const supplementalPrompt = text(args.supplementalPrompt)
      const frozenAt = new Date().toISOString()
      const snapshot = {
        valuationId, method, baseDate, supplementalPrompt,
        digest: manifestView.digest, frozenAt,
        files: manifestView.files,
      }

      // ① 建案例目录并落**冻结输入**（子会话只能读它，见 bootstrap Tool）。
      const platform = await world.platform()
      const made = await ensureCaseDirectory(access, casePath, { workspace: workspace.path, probeWorkdir: await world.workdir(), platform })
      if (!made.ok) return { ok: false, error: `创建估值案例目录失败：${made.error}`, valuationId, casePath }
      const inputWritten = await writePanelCaseFile(access, {
        ctx, path: joinLocalPath(casePath, '估值输入.json'), content: canonicalJson(snapshot),
        workspaceRoot: workspace.path, workdir: await world.workdir(),
      })
      if (!inputWritten.ok) return { ok: false, error: `冻结输入落盘失败：${inputWritten.error}`, valuationId, casePath }

      // ② 工具可见性预检：`VALUATION_CHILD_TOOLS` 写在常量里不等于宿主注册了它们。
      // 缺任何一条就在**创建会话之前**拒绝 —— 让用户看到"缺哪条、去重新自检"，
      // 而不是让估值会话跑到一半才发现工具调不到。
      const missingTools = missingValuationTools(ctx)
      if (missingTools.length > 0) {
        return {
          ok: false,
          error: valuationToolsMissingText(missingTools),
          valuationId, casePath,
        }
      }

      // ③ 建估值会话：**统一工作区落点**（协议 32），失败即停、不留下半截轮次。
      const created = await workspaceSessionService(ctx, state).createSession({
        title: `房地产估值 · ${valuationId}`,
        source: 'report-evaluation',
      })
      if (!created.ok) return { ok: false, error: created.error, valuationId, casePath }
      const sessionId = created.sessionId

      // ④ 登记轮次与案例 scope（估值会话据此拿到自己的案例目录）。
      //
      // 记录可能**已经存在**（intake 建的那条存根）：那种情况下不能 `open`（同一 ID 不许开两轮），
      // 而是把会话号与指纹补进那条存根。两条路径最终落到同一条记录上。
      const opened = existing === undefined
        ? deps.lifecycles.open({
          valuationId, casePath, workspaceId: workspace.id, workspacePath: workspace.path,
          method, baseDate, supplementalPrompt, digest: manifestView.digest, sessionId,
        })
        : deps.lifecycles.update(valuationId, existing.phase, {
          sessionId, digest: manifestView.digest,
        })
      if (!opened.ok) return { ok: false, error: opened.error, valuationId, casePath }
      deps.scopes.open({
        valuationId, casePath, sessionId, workspaceId: workspace.id, workspacePath: workspace.path,
        snapshot: { ...snapshot, files: manifestView.files }, openedAt: Date.now(),
      })
      advanceThrough(deps.lifecycles, valuationId, ['extracting', 'confirmation', 'queued'])
      deps.lifecycles.update(valuationId, 'queued', { progress: { stage: '已排队', detail: '正在准备估值会话', completed: 0, total: 4 } })

      // ⑤ 发固定指令。发送失败要**如实回报**（会话已建好，用户还能手动重试）。
      const prompt = valuationPrompt({
        valuationId, casePath, method, baseDate, supplementalPrompt,
        digest: manifestView.digest,
        files: manifestView.files,
        extraction: manifestView.files.map((file) => ({ fileName: file.fileName, parsed: true, fieldCount: 0, note: '' })),
        knowledge: [],
        knowledgeReady: true,
        providers: [],
        validateScripts: [
          { name: '工作簿契约', script: `${casePath}/scripts/check_workbook_contract.py`, args: [`${casePath}/${VALUATION_WORKBOOK_FILE}`] },
          { name: '结果口径', script: `${casePath}/scripts/validate_result.py`, args: [`${casePath}/${VALUATION_RESULT_FILE}`] },
        ],
      })
      const sendError = await sendPrompt(ctx, sessionId, prompt)
      if (sendError !== '') {
        deps.lifecycles.update(valuationId, 'failed', { error: `发送估值指令失败：${sendError}` })
        return { ok: false, error: `发送估值指令失败：${sendError}`, valuationId, casePath, sessionId }
      }
      deps.lifecycles.update(valuationId, 'running', { progress: { stage: '已启动', detail: '估值子会话已开始工作', completed: 1, total: 4 } })
      return { ok: true, error: '', valuationId, casePath, sessionId, phase: 'running', reused: false, digest: manifestView.digest }
    },

    // ── ⑤ 状态 ──────────────────────────────────────────────────────────────
    'valuation-status': async (args) => {
      const valuationId = text(args.valuationId).trim()
      const record = deps.lifecycles.get(valuationId)
      if (record === undefined) {
        return {
          ok: true, error: '', valuationId, phase: 'draft', workspaceId: '', workspacePath: '', sessionId: '',
          progress: { stage: '', detail: '', completed: 0, total: 0 },
          providerStates: {}, capabilityGaps: [], known: false,
        }
      }
      const artifacts = await artifactPresence(ctx, record.casePath)

      // **完成由宿主判定，不由子会话声称**：三件交付件齐备、且 `估值结果.json` 真的是一份
      // 读得懂的结果，就把这一轮推到 `completed`（终态）。
      //
      // 为什么放在这里：状态是**面板轮询的那一份事实**。子会话没法"报告完成"——
      // 它写完文件就结束了，没有回调；而模型自己说一句"我完成了"不是事实。
      // 判据取"三件齐备 + 结果可解析"，正是结果页需要的东西（缺一件就不该显示结论）。
      // 一旦 completed 就是终态：之后的修订不会把它推回去（`advance` 拒绝非法的回退）。
      // 完成由宿主判定：**不只是"三个文件在不在"** —— 判据见 `confirmCompletion` 的说明。
      const refreshed = record.phase === 'running' && artifacts.html && artifacts.xlsx && artifacts.json
        ? await confirmCompletion(deps, valuationId, record, artifacts)
        : record
      return {
        ok: true,
        error: '',
        valuationId,
        phase: refreshed.phase,
        workspaceId: record.workspaceId,
        workspacePath: record.workspacePath,
        sessionId: record.sessionId,
        progress: refreshed.progress,
        providerStates: refreshed.providerStates,
        capabilityGaps: refreshed.capabilityGaps,
        // 轮次自己的失败原因与操作信封的 `error` 不是一回事：前者是"这一轮为什么失败"，
        // 后者是"这次调用为什么失败"。重名会让界面把两者混着显示。
        recordError: refreshed.error,
        known: true,
        method: refreshed.method,
        baseDate: refreshed.baseDate,
        digest: refreshed.digest,
        casePath: refreshed.casePath,
        artifacts,
      }
    },

    // ── ⑥ 取消 ──────────────────────────────────────────────────────────────
    'valuation-cancel': async (args) => {
      const valuationId = text(args.valuationId).trim()
      const record = deps.lifecycles.get(valuationId)
      if (record === undefined) return { ok: false, error: `没有这一轮估值：${valuationId || '（空 ID）'}` }
      const outcome = deps.lifecycles.cancel(valuationId)
      if (!outcome.ok) return { ok: false, error: outcome.error, phase: record.phase }
      // 停掉会话里的这一轮（尽力而为：拿不到 Agent 就只记状态）。
      let cancelled = false
      if (record.sessionId !== '') {
        const agents = ctx.get('agents') as { get?: (id: string) => { cancel?: (reason: unknown) => void } | undefined } | undefined
        const agent = typeof agents?.get === 'function' ? agents.get(record.sessionId) : undefined
        if (agent !== undefined && typeof agent.cancel === 'function') {
          try {
            agent.cancel({ kind: 'user' })
            cancelled = true
          } catch (error) {
            void error
          }
        }
      }
      deps.scopes.close(valuationId)
      return { ok: true, error: '', phase: 'cancelled', cancelled }
    },

    // ── ⑦ 结果 ──────────────────────────────────────────────────────────────
    'valuation-result': async (args) => {
      const valuationId = text(args.valuationId).trim()
      const record = deps.lifecycles.get(valuationId)
      const casePath = record?.casePath ?? (await caseDirOfValuation(valuationId)).casePath
      if (casePath === '') return { ok: false, error: '拿不到本轮估值的案例目录', result: null, artifacts: { html: false, xlsx: false, json: false } }
      const artifacts = await artifactPresence(ctx, casePath)

      // **核对冻结输入**：`估值输入.json` 是案例目录里的普通文件，而估值会话对案例目录有写权限。
      // 只靠"子会话没有参数能改"管不到这件事 —— 谁都可以改文件，而改完之后没有任何地方会知道。
      // 这里把它与宿主内存里那一份逐字段比一次，不一致就如实报（宿主那一份才是权威）。
      const snapshotProblem = record === undefined
        ? ''
        : frozenInputMismatch(
          { method: record.method, baseDate: record.baseDate, supplementalPrompt: record.supplementalPrompt, digest: record.digest },
          await readFrozenInput(ctx, casePath),
        )
      if (snapshotProblem !== '') deps.lifecycles.addCapabilityGap(valuationId, snapshotProblem)

      const raw = await readTextIfExists(ctx, joinLocalPath(casePath, VALUATION_RESULT_FILE))
      let result: unknown = null
      let parseError = ''
      if (raw.trim() !== '') {
        try {
          result = JSON.parse(raw)
        } catch (error) {
          parseError = `估值结果.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
        }
      }
      const problems = [snapshotProblem, parseError].filter((item) => item !== '')
      return {
        ok: problems.length === 0,
        error: problems.join(' '),
        valuationId,
        casePath,
        phase: record?.phase ?? '',
        artifacts,
        result,
        /** 输入快照是否被改过（界面据此显示一句醒目的提示）。 */
        snapshotTampered: snapshotProblem !== '',
      }
    },

    // ── ⑧ 打开交付件 ────────────────────────────────────────────────────────
    'valuation-open-artifact': async (args) => {
      const valuationId = text(args.valuationId).trim()
      const name = text(args.name).trim()
      if (!(VALUATION_OUTPUT_FILES as readonly string[]).includes(name)) {
        return { ok: false, error: `只允许打开本轮的交付件（${VALUATION_OUTPUT_FILES.join(' / ')}）` }
      }
      const record = deps.lifecycles.get(valuationId)
      const casePath = record?.casePath ?? (await caseDirOfValuation(valuationId)).casePath
      if (casePath === '') return { ok: false, error: '拿不到本轮估值的案例目录' }
      const path = joinLocalPath(casePath, name)
      if (!await isFile(ctx, path)) return { ok: false, error: `这份交付件还不存在：${name}` }
      const run = await access.runShell(
        { operation: 'system.case-file.open', source: 'panel', workdir: await world.workdir() },
        openExternalCommand(path, await world.platform()),
        { timeoutMs: 30_000, summary: 'system.case-file.open' },
      )
      return { ok: run.ok, error: run.ok ? '' : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 200), path }
    },
  }
  return operations
}

/**
 * 把一个员工选中的资料**按字节**复制进案例目录，并返回它的指纹与字节数。
 *
 * 读源文件走 node fs（与本地审核读本机资料同一条路：`system.local-audit-material.snapshot`
 * 就是这套权限语义）；写目标走 Broker 的 `system.case-file.write`，命令由
 * `copyCommand()` 生成（`cp -f` / `Copy-Item -Force`）—— 操作用户自己的复制命令，
 * 不做任何编码转换。复制后**回读后置条件**：命令成功不等于文件真的在。
 */
async function copyMaterial(
  deps: ValuationOpsDeps,
  input: { sourcePath: string; destinationPath: string; platform: string; workdir: string },
): Promise<{ ok: boolean; error: string; digest: string; bytes: number }> {
  let bytes: Buffer
  try {
    bytes = await readFile(input.sourcePath)
  } catch (error) {
    return { ok: false, error: `读取资料失败：${error instanceof Error ? error.message : String(error)}`, digest: '', bytes: 0 }
  }
  if (bytes.length === 0) {
    return { ok: false, error: '这份资料是空文件（0 字节）', digest: '', bytes: 0 }
  }
  const run = await deps.access.runShell(
    // 用估值自己的那条操作（面板来源），不借审核子代理的 `system.case-file.write`。
    { operation: 'system.valuation-material.copy', source: 'panel', workdir: input.workdir },
    copyCommand(input.sourcePath, input.destinationPath, input.platform),
    { timeoutMs: 60_000, summary: 'system.case-file.write' },
  )
  if (!run.ok) {
    return {
      ok: false,
      error: `复制资料失败：${(text(run.stderr) || text(run.error) || '复制命令未成功').slice(0, 200)}`,
      digest: '', bytes: 0,
    }
  }
  if (!await isFile(deps.ctx, input.destinationPath)) {
    return { ok: false, error: '复制命令成功了，但案例目录里没有这份资料（后置条件不成立）', digest: '', bytes: 0 }
  }
  // 指纹按**源文件字节**算：它要能回答"这一轮吃进去的是哪一版资料"。
  const digest = sha256OfBytes(new Uint8Array(bytes))
  return { ok: true, error: '', digest, bytes: bytes.length }
}

/**
 * 沿**合法路径**把一轮估值推到目标阶段。
 *
 * 为什么不能一步到位：状态机的转移表故意不允许跳步（`draft` 直接 `queued` 意味着跳过了
 * 资料入口与确认）。写这条时正是想把 `draft` 直接改成 `queued`，结果被转移表拦下、
 * 状态停在 `draft` 而界面以为已经在跑 —— 这正是转移表要防的那类"看起来正常"的错。
 */
/**
 * 资料提取的**真实阶段**（§11.1 要进度区显示的那几句）。
 *
 * 客户端不自己按计时器切阶段（那是假进度），所以阶段由宿主在真正走到那一步时写进轮次记录，
 * 面板轮询 `valuation-status` 拿到它。顺序就是这里数组的顺序。
 */
const INTAKE_STAGES = {
  checking: '正在检查资料',
  copying: '正在复制资料',
  extracting: '正在提取文件内容',
  knowledge: '正在读取业务规范',
  preparing: '正在准备确认信息',
} as const

/**
 * 记一次提取阶段。
 *
 * 失败**静默**：这一条只是给人看的进度，用户可能已经取消（记录进了终态，更新会被拒）——
 * 为了显示进度而让整轮提取报错是本末倒置。
 */
function noteIntakeStage(
  lifecycles: ValuationLifecycles,
  valuationId: string,
  stage: string,
  detail = '',
  completed = 0,
  total = 0,
): void {
  const record = lifecycles.get(valuationId)
  if (record === undefined) return
  lifecycles.update(valuationId, record.phase, { progress: { stage, detail, completed, total } })
}

function advanceThrough(
  lifecycles: ValuationLifecycles,
  valuationId: string,
  steps: readonly ValuationPhase[],
): void {
  for (const step of steps) {
    const current = lifecycles.get(valuationId)
    if (current === undefined || current.phase === step) continue
    // 非法的一步会被拒绝（例如确认之后再去"提取"）：忽略即可，后面的步骤仍然尝试。
    lifecycles.update(valuationId, step, {})
  }
}

/** 读输入清单并回答"磁盘上现在是什么"（不比 `valuation-intake` 的预览）。 */
async function readManifest(ctx: Context, casePath: string): Promise<{
  ok: boolean
  error: string
  digest: string
  files: Array<{ fileName: string; relativePath: string; kind: string; sizeBytes: number; sha256: string }>
}> {
  const raw = await readTextIfExists(ctx, joinLocalPath(casePath, '资料清单.json'))
  if (raw.trim() === '') return { ok: false, error: '找不到资料清单：请先准备资料（估价入口第 ① 步）。', digest: '', files: [] }
  try {
    const parsed = JSON.parse(raw) as { digest?: unknown; files?: unknown }
    const files = Array.isArray(parsed.files) ? parsed.files : []
    const list = files.flatMap((item) => {
      if (item === null || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      const relativePath = text(record.relativePath)
      if (relativePath === '') return []
      return [{
        fileName: text(record.fileName), relativePath, kind: text(record.kind),
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
        sha256: text(record.sha256),
      }]
    })
    if (list.length === 0) return { ok: false, error: '资料清单里没有任何资料：请先选择要估值的文件。', digest: '', files: [] }
    // 指纹以**清单内容**重算：`资料清单.json` 被改过也能看出来。
    return { ok: true, error: '', digest: text(parsed.digest) || digestOnly(list), files: list }
  } catch (error) {
    return { ok: false, error: `资料清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, digest: '', files: [] }
  }
}

/**
 * 读案例目录里的冻结输入（拿不到 / 不是合法 JSON → `null`）。
 *
 * `null` 不是"没问题"：调用方按 `frozenInputMismatch` 的口径把它当成"快照缺失"报出来 ——
 * 估值会话读的就是这份文件，它不见了等于本轮输入没了。
 */
async function readFrozenInput(ctx: Context, casePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(ctx, joinLocalPath(casePath, VALUATION_INPUT_FILE))
  if (raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch (error) {
    void error
    return null
  }
}

/**
 * 自动完成的**宿主侧判据**（方案 §9）。
 *
 * 以前这里只判"三件齐备 + JSON 读得懂 + `method` 非空"。那不够 ——
 * `completed` 是终态，一旦落下就不会再改，所以它必须代表"这一轮真的到了可交付的形状"。
 * 现在逐条要求（每条都对应 §9 列出的一条）：
 *
 * 1. **交付件三件齐备**（调用方已判）；
 * 2. **结果 JSON 读得懂且方法非空**；
 * 3. **输入与冻结记录一致**（`估值输入.json` 被改过就不算完成）；
 * 4. **采用规则可追溯**：结果里必须列出 `knowledge_sources`（用了哪几份规范）；
 * 5. **采用案例都有证据**：`used_as_comparable` 的案例不能 `evidence` 为空或标着 "没留存"。
 *
 * 不满足时**不推 completed**，而是留在 `running` 并把"还差什么"写进 progress.detail ——
 * 面板轮询读到的是"正在跑 + 差 X"，比一个假的"已完成"有用得多。
 *
 * 重算能力（底稿数字 ↔ JSON 数字）本部署没有，所以它**不**作为自动完成的判据，
 * 而是作为一条能力缺口写进轮次：`completed` 表示"三件齐备且可追溯"，不表示"数字已重算核对过"。
 */
async function confirmCompletion(
  deps: ValuationOpsDeps,
  valuationId: string,
  record: ValuationRecord,
  artifacts: { html: boolean; xlsx: boolean; json: boolean },
): Promise<ValuationRecord> {
  const casePath = record.casePath
  const raw = await readTextIfExists(deps.ctx, joinLocalPath(casePath, VALUATION_RESULT_FILE))
  let parsed: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(raw)
    parsed = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch (error) {
    void error
    parsed = null
  }
  const current = deps.lifecycles.get(valuationId)
  // 调用方已经拿过这一轮；这里查不到只能说明它同时被淘汰了 —— 那时**不动阶段**，原样返回。
  if (current === undefined) return record

  const missing = completionGaps(parsed, deps.screenshot !== undefined)
  // **用户指定的方法不许被静默切换**（§7.2）：结论用的方法与冻结输入里用户选的不一致时，
  // 必须给出 methodConflict（含双方与原因）。宿主这一层兜住 —— 子会话跳过校验脚本也拦得住。
  const userMethod = text(record.method)
  const adoptedMethod = text(parsed?.method)
  if (parsed !== null && userMethod !== '' && userMethod !== 'auto' && adoptedMethod !== ''
      && adoptedMethod !== userMethod && parsed.methodConflict === null) {
    missing.push(`用户指定了 ${userMethod}，结论用的是 ${adoptedMethod}，但结果里没有方法冲突记录：`
      + '要么按用户指定的方法算，要么把冲突与原因写进 methodConflict')
  }
  // **交付校验**（§9「模板错误不得完成」/「计算表重算成功」）：结论由子会话跑
  // `crwu_valuation_artifact_validate` 时写回轮次。没跑过就没有完成 —— 不许把
  // "以后人工打开核对"包装成已完成自动交付。
  if (record.validationPassed !== true) {
    const problems = record.validationProblems ?? []
    missing.push(
      problems.length === 0
        ? '还没有跑过交付校验（工作簿契约 + 结果口径）：请让子会话执行 crwu_valuation_artifact_validate'
        : `交付校验没通过（${String(problems.length)} 项）：${problems.slice(0, 3).join('；')}`,
    )
  }
  // 输入快照一致性：宿主内存里那一份是权威，磁盘上被改过就要如实报出来。
  // （`估值输入.json` 是案例目录里的普通文件，而估值会话对案例目录有写权限。）
  const frozen = await readFrozenInput(deps.ctx, casePath)
  const mismatch = frozenInputMismatch(
    { method: record.method, baseDate: record.baseDate, supplementalPrompt: record.supplementalPrompt, digest: record.digest },
    frozen,
  )
  if (mismatch !== '') missing.push(mismatch)

  if (missing.length > 0) {
    deps.lifecycles.update(valuationId, current.phase, {
      progress: {
        stage: '还差交付条件',
        detail: missing.join('；'),
        completed: 3,
        total: 4,
      },
    })
    return deps.lifecycles.get(valuationId) ?? current
  }

  // 重算能力缺口：本部署没有，如实记进这一轮（不把它包装成"已完成自动核对"）。
  const gaps = completionCapabilityGaps()
  const written = deps.lifecycles.update(valuationId, 'completed', {
    artifacts,
    capabilityGaps: gaps,
    progress: { stage: '已完成', detail: '三件交付件齐备且输入可追溯', completed: 4, total: 4 },
  })
  return written.record ?? current
}

/** 自动完成还差哪几条（空数组 = 可以完成）。 */
export function completionGaps(
  parsed: Record<string, unknown> | null,
  /** 本部署是否装配了页面截图通道（缺省没有）。 */
  screenshotCapable = false,
): string[] {
  if (parsed === null) return ['估值结果.json 读不出来（不是一份合法的 JSON）']
  const out: string[] = []
  if (text(parsed.method) === '') out.push('估值结果.json 没有写采用的方法')
  // 采用规则可追溯：至少要列出用过哪几份规范。
  const sources = parsed.knowledge_sources
  if (!Array.isArray(sources) || sources.length === 0) {
    out.push('估值结果.json 没有列出采用的知识库规范（无法追溯用了哪一版规则）')
  }
  // 金额口径一致：单价 × 计价面积 = 总价（允许 1 元舍入差）。
  // 三个数各说一套说明至少有一个是错的 —— 那正是"口径不一致"最典型的样子。
  const unit = typeof parsed.unitPrice === 'number' && Number.isFinite(parsed.unitPrice) ? parsed.unitPrice : null
  const area = typeof parsed.pricingArea === 'number' && Number.isFinite(parsed.pricingArea) ? parsed.pricingArea : null
  const total = typeof parsed.totalValue === 'number' && Number.isFinite(parsed.totalValue) ? parsed.totalValue : null
  if (unit !== null && area === null) out.push('有单价却没有计价面积（总价与单价无法勾稽）')
  if (unit !== null && area !== null && total !== null && Math.abs(unit * area - total) > 1) {
    out.push(`单价 × 计价面积与总价对不上（${String(unit)} × ${String(area)} ≠ ${String(total)}）`)
  }
  // 采用案例必须有证据、且不能带着"没通过"的规则判定
  // （例外只有组内一致性：规范允许说明处置方式后保留）。
  // 这跟结果契约里的同一条判据是**两个位置**：子会话可能没跑校验脚本就结束，宿主这一层要兜住。
  const cases = Array.isArray(parsed.cases) ? parsed.cases : []
  const failingAdopted = cases.filter((item) => {
    if (item === null || typeof item !== 'object') return false
    const one = item as Record<string, unknown>
    if (one.used_as_comparable !== true) return false
    const checks = Array.isArray(one.rule_checks) ? one.rule_checks : []
    return checks.some((check) => check !== null && typeof check === 'object'
      && (check as Record<string, unknown>).verdict === 'fail'
      && text((check as Record<string, unknown>).rule_id) !== 'R-GROUP-1.2')
  })
  if (failingAdopted.length > 0) {
    out.push(`有 ${String(failingAdopted.length)} 条采用案例带着没通过的规则判定（采用案例必须逐条通过）`)
  }
  const adopted = cases.filter((item) => item !== null && typeof item === 'object'
    && (item as Record<string, unknown>).used_as_comparable === true)
  const bad = adopted.filter((item) => {
    const one = item as Record<string, unknown>
    return text(one.evidence) === '' || one.evidence_missing === true
  })
  if (bad.length > 0) out.push(`有 ${String(bad.length)} 条采用案例没有页面证据`)
  // **页面截图**（§7.4）：采用案例缺截图时不得标记完成 —— 但只在**本部署真的能截图**时才算阻塞。
  // 没有截图能力时（`deps.screenshot` 未注入）截图缺失是已登记的能力缺口，
  // 不是子会话的疏漏：把能力缺失说成"任务没做完"会让每一轮都永远完不成。
  if (screenshotCapable) {
    const noShot = adopted.filter((item) => {
      const one = item as Record<string, unknown>
      return text(one.screenshot) === '' || one.screenshot_missing === true
    })
    if (noShot.length > 0) {
      out.push(`有 ${String(noShot.length)} 条采用案例没有页面截图（本部署有截图通道，缺截图不算完成）`)
    }
  }
  // 市场法的案例数量：规范要求**不少于 3 个**，且"不得用 2 个案例直接平均后当结论"
  //（`references/02-market-method.md` 第 2 节）。不足时**不许**给出正式单价 / 总价 ——
  // 那正是"没有依据的正式结论"，只能作为阶段结果留在案例目录里。
  if (text(parsed.method) === 'market' && (unit !== null || total !== null) && adopted.length < MIN_MARKET_COMPARABLES) {
    out.push(`市场法只有 ${String(adopted.length)} 条采用案例（规范要求不少于 ${String(MIN_MARKET_COMPARABLES)} 条），`
      + '不能给出正式单价 / 总价：补搜案例，或把结论降为阶段结果并写明不足原因')
  }
  return out
}

/** 市场法可比实例的**最少数**（`references/02-market-method.md` 第 2 节：不少于 3 个）。 */
export const MIN_MARKET_COMPARABLES = 3

/**
 * 自动完成时如实记下的**能力缺口**（§9「没有阻塞性能力缺口」）。
 *
 * 底稿重算（打开 Excel 让公式算出数值，再与 JSON 逐项核对）本部署做不到 ——
 * 这不是"以后人工看一眼"的客套话，而是一条必须出现在交付说明里的限制。
 */
export function completionCapabilityGaps(): string[] {
  return [
    '本部署没有底稿重算能力：底稿数字与估值结果.json 数字的一致性需要人工打开一次底稿核对。',
  ]
}

/** 三个交付件的存在性。 */
async function artifactPresence(ctx: Context, casePath: string): Promise<{ html: boolean; xlsx: boolean; json: boolean }> {
  if (casePath === '') return { html: false, xlsx: false, json: false }
  return {
    html: await isFile(ctx, joinLocalPath(casePath, VALUATION_REPORT_FILE)),
    xlsx: await isFile(ctx, joinLocalPath(casePath, VALUATION_WORKBOOK_FILE)),
    json: await isFile(ctx, joinLocalPath(casePath, VALUATION_RESULT_FILE)),
  }
}

/** 发一条固定指令给估值会话。返回空串表示已受理。 */
async function sendPrompt(ctx: Context, sessionId: string, prompt: string): Promise<string> {
  const agents = ctx.get('agents') as { get?: (id: string) => { followup?: (message: unknown) => void } | undefined } | undefined
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (agent === undefined || typeof agent.followup !== 'function') {
    return '估值会话的 Agent 不在运行中：无法发送固定指令'
  }
  try {
    agent.followup({
      id: `msg-valuation-${sessionId}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** 面板侧预检用的薄封装（与 Tool 共用同一套 provider 实现）。 */
export async function preflightProvidersForPanel(
  transport: ReturnType<typeof fetchTransport>,
): Promise<Awaited<ReturnType<typeof preflightProviders>>> {
  return await preflightProviders({ transport, ids: ALL_PROVIDER_IDS })
}

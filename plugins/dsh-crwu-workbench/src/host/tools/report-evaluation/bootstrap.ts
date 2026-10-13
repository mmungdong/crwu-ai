import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { resolveTarget } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { ensureDirectory, writeCaseText } from '../common/case-files.ts'
import { canonicalJson, digestOnly } from '../common/snapshot.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import type { ValuationScope } from '../../domains/report-evaluation/scope.ts'
import {
  VALUATION_EVIDENCE_DIR,
  VALUATION_INPUT_FILE,
  VALUATION_KNOWLEDGE_DIR,
  VALUATION_MATERIAL_DIR,
  VALUATION_TOOL_NAMES,
} from './consts.ts'

/**
 * `crwu_valuation_case_bootstrap`：**本轮估值输入的唯一交接点**（协议 32）。
 *
 * 与 `crwu_audit_case_bootstrap` 同一个设计意图：子会话不该在案例目录里自己找输入。
 *
 * 三条硬口径：
 *   1. **输入来自冻结快照，不来自模型**。方法 / 基准日 / 补充提示词 / 资料清单都在
 *      `ValuationScope.snapshot` 里（确认抽屉按下"确认并开始估值"那一刻写下的），
 *      这个工具**没有**任何参数能让调用方改写它们 —— 子会话只能消费。
 *   2. **归属钉在会话上**：案例目录必须是这条会话自己的那一份（`requireCaseAccess`），
 *      并且 `valuationId` 必须与 scope 里的一致。模型提交别的估值 id 会被拒。
 *   3. **落盘只写输入**：`材料-源` / `来源证据` / `知识快照` 三个目录加上
 *      `估值输入.json`。`估值对象.json` 之类是 AI 的产出，不在这里写。
 */

interface BootstrapArgs {
  valuationId?: unknown
  caseDir?: unknown
}

interface BootstrapResult {
  ok: boolean
  errorKind: string
  error: string
  valuationId: string
  method: string
  baseDate: string
  frozenAt: string
  digest: string
  fileCount: number
  caseDir: string
  inputPath: string
  materialDir: string
  evidenceDir: string
  knowledgeDir: string
  /** 输入清单（相对路径 + 指纹）；子会话据此写案例表，不必自己扫目录。 */
  files: Array<{ fileName: string; relativePath: string; kind: string; sizeBytes: number; sha256: string }>
}

function idleResult(): BootstrapResult {
  return {
    ok: false, errorKind: '', error: '',
    valuationId: '', method: '', baseDate: '', frozenAt: '', digest: '', fileCount: 0,
    caseDir: '', inputPath: '', materialDir: '', evidenceDir: '', knowledgeDir: '',
    files: [],
  }
}

/** 写一个 JSON 文件；必须带调用方会话的策略（与审核快照同一条理由，见 `writeCaseText`）。 */
async function writeJson(
  ctx: Context,
  path: string,
  payload: unknown,
  options: { session?: Session; signal?: AbortSignal },
): Promise<{ ok: boolean; error: string }> {
  const written = await writeCaseText(ctx, path, canonicalJson(payload), options)
  if (written.ok) return { ok: true, error: '' }
  const kind = written.errorKind === '' ? 'infrastructure' : written.errorKind
  return { ok: false, error: `${written.error}（写入 ${path} · 归因 ${kind} · 后置条件 ${written.postcondition}）` }
}

/** 两个路径是不是同一个目录（规范解析后比较）。 */
async function sameDir(ctx: Context, left: string, right: string): Promise<boolean | undefined> {
  try {
    const a = await resolveTarget(ctx, left)
    const b = await resolveTarget(ctx, right)
    return text(a.targetKey) !== '' && a.targetKey === b.targetKey
  } catch (error) {
    void error
    return undefined
  }
}

export function valuationBootstrapTools(deps: ToolDeps) {
  const bootstrap = defineTool({
    name: VALUATION_TOOL_NAMES.caseBootstrap,
    description: [
      '把本轮房地产估值**已冻结的输入**落盘到案例目录，并返回紧凑摘要（方法 / 基准日 / 资料清单 / 指纹）。',
      '估值启动前 Host 已经调用过一次；子会话不要重复调用，直接读案例目录里的 估值输入.json。',
      '方法、基准日、用户补充要求都取自冻结快照，本工具不接受也不允许改写它们。',
    ].join(' '),
    parameters: {
      valuationId: { type: 'string', required: true, description: '本轮估值 ID（Host 生成，子会话不得自行编造）' },
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录绝对路径；必须是这条会话自己的那一份' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          valuationId: { type: 'string', required: true },
          method: { type: 'string', required: true, description: '采用的方法：auto / market / income / cost（未经重新判定）' },
          baseDate: { type: 'string', required: true, description: '用户选择的基准日；未选择时为空串' },
          frozenAt: { type: 'string', required: true },
          digest: { type: 'string', required: true, description: '冻结输入快照的指纹' },
          fileCount: { type: 'integer', required: true },
          caseDir: { type: 'string', required: true },
          inputPath: { type: 'string', required: true, description: `冻结输入：${VALUATION_INPUT_FILE}` },
          materialDir: { type: 'string', required: true },
          evidenceDir: { type: 'string', required: true },
          knowledgeDir: { type: 'string', required: true },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                fileName: { type: 'string', required: true },
                relativePath: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                sha256: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: BootstrapArgs, exec): Promise<BootstrapResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      // ① 案例归属：这条会话自己的那一份案例目录（托管 scope 优先）。
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：估值输入交接只能在估值子会话里进行') }
      }

      // ② 冻结快照：没有它就没有本轮估值（绝不用"模型报的参数"顶替）。
      const valuationId = text(args.valuationId).trim()
      const scope: ValuationScope | undefined = deps.valuationScopes?.get(valuationId)
      if (scope === undefined) {
        return { ...base, ...failure('not-found', `找不到本轮估值（${valuationId || '未提供 id'}）的冻结输入：本插件实例没有它的记录`) }
      }
      if (scope.casePath !== access.casePath) {
        return { ...base, ...failure('policy', '估值 id 与案例目录不属于同一轮估值') }
      }
      const requested = text(args.caseDir).trim()
      if (requested !== '' && await sameDir(ctx, requested, scope.casePath) === false) {
        return { ...base, ...failure('policy', '案例目录必须是**本轮估值自己的**那一个') }
      }

      const session = callerSession(exec)
      const platform = await deps.world.platform()
      const workdir = await deps.world.workdir()

      // ③ 三个子目录：材料 / 证据 / 知识快照。幂等（重入时已存在也算成功）。
      const dirs = {
        materialDir: joinLocalPath(scope.casePath, VALUATION_MATERIAL_DIR),
        evidenceDir: joinLocalPath(scope.casePath, VALUATION_EVIDENCE_DIR),
        knowledgeDir: joinLocalPath(scope.casePath, VALUATION_KNOWLEDGE_DIR),
      }
      for (const path of [dirs.materialDir, dirs.evidenceDir, dirs.knowledgeDir]) {
        const made = await ensureDirectory(deps.access, path, {
          workdir,
          platform,
          ...(session === undefined ? {} : { session }),
        })
        if (!made.ok) {
          return { ...base, ...failure(made.errorKind === '' ? 'infrastructure' : 'infrastructure',
            `创建估值案例子目录失败：${made.error}（${path}）`) }
        }
      }

      // ④ 冻结输入落盘。顺序（方法 / 基准日 / 补充要求 / 清单 / 指纹）固定，便于人读与 diff。
      const snapshot = scope.snapshot
      const inputPath = joinLocalPath(scope.casePath, VALUATION_INPUT_FILE)
      const written = await writeJson(ctx, inputPath, {
        valuationId: snapshot.valuationId,
        method: snapshot.method,
        baseDate: snapshot.baseDate,
        supplementalPrompt: snapshot.supplementalPrompt,
        digest: snapshot.digest,
        frozenAt: snapshot.frozenAt,
        files: snapshot.files,
      }, { ...(session === undefined ? {} : { session }) })
      if (!written.ok) return { ...base, ...failure('infrastructure', written.error) }

      return {
        ok: true,
        errorKind: '',
        error: '',
        valuationId: snapshot.valuationId,
        method: snapshot.method,
        baseDate: snapshot.baseDate,
        frozenAt: snapshot.frozenAt,
        // 报出去的是**输入快照自己的指纹**（由资料清单算出来），不是刚写那个文件的时间戳 ——
        // 后者每次调用都变，用它做核对等于没有核对。
        digest: snapshot.digest || digestOnly(snapshot.files),
        fileCount: snapshot.files.length,
        caseDir: scope.casePath,
        inputPath,
        materialDir: dirs.materialDir,
        evidenceDir: dirs.evidenceDir,
        knowledgeDir: dirs.knowledgeDir,
        files: snapshot.files.map((file) => ({ ...file })),
      }
    },
  })

  return [bootstrap]
}

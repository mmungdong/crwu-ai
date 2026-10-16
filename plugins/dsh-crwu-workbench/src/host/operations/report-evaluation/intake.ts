import type { Context } from '@deepseek-ai/cordis'
import { readFile, stat } from 'node:fs/promises'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import type { OperationMap } from '../types.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { WorkbenchState } from '../../core/state/types.ts'
import type { WorldFacts } from '../../core/platform/world.ts'
import { copyCommand } from '../../core/platform/shell.ts'
import { ensureCaseDirectory, ensurePanelCaseDirectory } from '../../tools/common/case-files.ts'
import { workspaceSessionService } from '../../core/workspace-session/index.ts'
import { scanSelection, nodeLocalAuditFs } from '../../domains/local-audit/scan.ts'
import { LOCAL_AUDIT_MAX_FILES } from '../../domains/local-audit/consts.ts'
import { kindOf } from '../../domains/report-evaluation/intake/classify.ts'
import { mintProjectId } from '../../domains/report-evaluation/scope.ts'
import {
  preparePreview,
  previewFailure,
  type PreviewDeps,
  type PreviewRegistry,
} from '../../domains/report-evaluation/intake/preview.ts'

/**
 * 报告评估的**资料入口操作**（计划 Task 2 · 设计稿 §4.3 / §5）。
 *
 * | 操作 | 做什么 |
 * | --- | --- |
 * | `valuation-files-scan` | 展开一次本机选择（文件夹 → 文件），只回事实与元信息 |
 * | `valuation-intake` | 递归扫描 → 按字节归档 → 对归档副本重算指纹 → 生成确认摘要（确认抽屉的数据源） |
 *
 * 条件入参（方法 / 基准日 / **评估目的** / **价值类型** / 补充要求）都是**用户输入**：
 * 未填一律按"未指定"处理，不在这一层替用户补一个业务口径。
 *
 * ## 与 v1 的三条差别（都是"少做"）
 *
 * 1. **不调用 Python 提取**：提取归父会话（`crwu_valuation_file_extract`，一轮只做一次）；
 * 2. **不拉知识库**：知识正文按阶段物化，归父会话（Task 5）；
 * 3. **不发任何网络请求**：三家来源的登录状态由 `valuation-browser-preflight` 单独回答。
 *
 * 于是"点确认"这一步只等本机磁盘，不再等一分钟的站点超时。
 *
 * ## 提权这件事各条自带名字
 *
 * 面板**没有会话**，`ctx.fs` / `ctx.shell` 会落到部署默认沙箱，于是往案例目录里写会被自家沙箱拒。
 * 所以建目录走 `system.valuation-case.directory.write`、复制资料走 `system.valuation-material.copy`
 * —— 两条都是**面板来源**的具名操作，各自声明提权。**不能**借审核子代理的 `system.case-file.write`
 * （那条只允许 `audit-tool`，用了它每一份资料都会被 Broker 拒掉）。
 */

export interface IntakeOperationDeps {
  ctx: Context
  state: WorkbenchState
  access: LocalAccessBroker
  world: WorldFacts
  previews: PreviewRegistry
}

/** `birthtime` 不可用（部分文件系统给 0 / NaN）时返回 `null`：**不拿 mtime 冒充**创建时间。 */
function timestampOf(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

export function createIntakeOperations(deps: IntakeOperationDeps): OperationMap {
  const { ctx, state, access, world } = deps

  /** 一次扫描请求里两条入参（选择入口 + 逐个移除的文件），两条只接受绝对路径。 */
  const scanArgsOf = (args: Record<string, unknown>): {
    selection: string[]
    excluded: string[]
  } => ({
    selection: Array.isArray(args.paths)
      ? args.paths.map((item) => text(item).trim()).filter((item) => item !== '') : [],
    excluded: Array.isArray(args.excluded)
      ? args.excluded.map((item) => text(item).trim()).filter((item) => item !== '') : [],
  })

  return {
    // ── ① 扫描本机选择（入口事实 + **真实文件明细**） ────────────────────────
    //
    // 为什么要连 `files[]` 一起回：只回入口的话，界面上"文件夹 · 纳入 3 份"是一个数字，
    // 员工既看不到具体是哪三份、也没法把其中错的一份去掉。排除范围（`excluded`）由 Host
    // 校验并**统一**用在扫描、预览与归档三处 —— 只过滤 UI 列表就是"假排除"。
    'valuation-files-scan': async (args) => {
      const { selection, excluded } = scanArgsOf(args)
      if (selection.length === 0) {
        return {
          ok: true, error: '', errorKind: '', fileCount: 0, limit: LOCAL_AUDIT_MAX_FILES,
          overLimit: false, readableCount: 0, skippedCount: 0, truncated: false,
          items: [], files: [], skipped: [],
        }
      }
      const scan = await scanSelection(selection, nodeLocalAuditFs(), { excluded })
      return {
        ok: scan.ok,
        error: scan.ok ? '' : scan.error,
        errorKind: scan.errorKind,
        fileCount: scan.fileCount,
        limit: LOCAL_AUDIT_MAX_FILES,
        overLimit: scan.overLimit,
        readableCount: scan.readableCount,
        skippedCount: scan.skippedCount,
        truncated: scan.truncated,
        items: scan.items,
        // 绝对路径只回显给面板（员工自己的机器）；它不进摘要、不进模型输入。
        files: scan.files.map((file) => ({
          path: file.sourcePath,
          name: file.name,
          kind: kindOf(file.name),
          sizeBytes: file.sizeBytes,
          parentPath: file.parentPath,
        })),
        skipped: scan.skipped.map((item) => ({
          path: item.relativePath, name: item.name, reason: item.reason,
        })),
      }
    },

    // ── ② 归档预览（确认抽屉的数据源） ─────────────────────────────────────
    'valuation-intake': async (args) => {
      const selected = await workspaceSessionService(ctx, state).requireSelectedWorkspace()
      if (!selected.ok) {
        return previewFailure('policy', selected.error, { requestId: text(args.requestId) })
      }
      const workspace = selected.workspace
      const platform = await world.platform()
      const workdir = await world.workdir()

      const previewDeps: PreviewDeps = {
        previews: deps.previews,
        // 排除范围在这里**逐字**传下去：员工移除掉的文件既不进清单、也不进归档副本。
        scan: (selection, excluded) => scanSelection(selection, nodeLocalAuditFs(), { excluded }),
        readSourceBytes: async (path) => new Uint8Array(await readFile(path)),
        statSource: async (path) => {
          const info = await stat(path)
          return {
            createdAt: timestampOf(info.birthtimeMs),
            modifiedAt: timestampOf(info.mtimeMs),
            // 扫描阶段已经把不可读的排除掉了；能走到这里说明刚刚读到了字节。
            readable: true,
          }
        },
        ensureDirectories: async ({ projectDir, materialDir }) => {
          // 项目目录：工作空间下**唯一**允许插件自动创建的一级目录（路径由 Host 从工作空间推出）。
          const made = await ensureCaseDirectory(access, projectDir, {
            workspace: workspace.path, probeWorkdir: workdir, platform, source: 'panel',
          })
          if (!made.ok) return { ok: false, error: made.error, errorKind: made.errorKind }
          const material = await ensurePanelCaseDirectory(access, materialDir, {
            operation: 'system.valuation-case.directory.write', workdir, platform,
          })
          return { ok: material.ok, error: material.error, errorKind: material.errorKind }
        },
        copyMaterial: async ({ sourcePath, archivePath }) => {
          // 按字节复制（`cp -f` / `Copy-Item -Force`）：不做任何编码转换。
          // 复制到底成不成功**不靠退出码**：预览层会读回目标文件、重算指纹并与源字节比对。
          const run = await access.runShell(
            { operation: 'system.valuation-material.copy', source: 'panel', workdir },
            copyCommand(sourcePath, archivePath, platform),
            { timeoutMs: 60_000, summary: 'system.valuation-material.copy' },
          )
          if (!run.ok) {
            return {
              ok: false,
              error: (text(run.stderr) || text(run.error) || '复制命令未成功').slice(0, 200),
              errorKind: '',
            }
          }
          return { ok: true, error: '', errorKind: '' }
        },
        readArchiveBytes: async (path) => new Uint8Array(await readFile(path)),
        projectDirOf: (projectId) => joinLocalPath(workspace.path, projectId),
        mintProjectId: () => mintProjectId(new Date()),
        now: () => new Date(),
      }

      const { selection: paths, excluded } = scanArgsOf(args)
      return await preparePreview({
        requestId: text(args.requestId),
        paths,
        excluded,
        // 资产类型**逐字**传下去：未选由预览层直接拒绝（不存在默认房地产这一档）。
        assetType: text(args.assetType),
        method: text(args.method),
        baseDate: text(args.baseDate),
        // 评估目的与价值类型**逐字**传下去：未填就是空串（Host 归一化成 `null` = 未指定），
        // 客户端与本层都不许拿资料里的用途/名称补一个业务口径。
        purpose: text(args.purpose),
        valueType: text(args.valueType),
        supplementalPrompt: text(args.supplementalPrompt),
      }, previewDeps)
    },
  }
}

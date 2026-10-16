import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import type { WorkbenchState } from '../../core/state/types.ts'
import { localAccessGranted } from '../../core/access/consent.ts'
import { pathKey, workspaceSessionService } from '../../core/workspace-session/index.ts'
import { HANDOFF_RECORD_FILE } from '../../domains/report-evaluation/execution/handoff-store.ts'
import {
  resumeProject,
  type ResumeDeps,
  type ResumeOutcome,
} from '../../domains/report-evaluation/lifecycle/resume.ts'
import type { ValuationLifecycles } from '../../domains/report-evaluation/lifecycle/index.ts'
import type { ValuationScopes } from '../../domains/report-evaluation/scope.ts'
import type { OperationMap } from '../types.ts'

/**
 * `valuation-project-resume`：**项目归属的显式恢复**（P18）。
 *
 * ## 为什么是 Host 操作，而不是一条模型可见的 Tool
 *
 * 恢复做的事是"把案例访问权重新授予**那一条**会话" —— 那是权威判据，不是业务步骤。
 * 让模型提交 `projectId` 就能重新开一个案例目录的访问权，等于把 `requireCaseAccess` 的
 * 整条归属边界交给提示词。所以它只作为面板侧的受控操作存在：
 *
 * - 输入**只有** `projectId`：目录、会话 id、工作区与沙箱参数一个都提交不了；
 * - 判据全部在 `domains/report-evaluation/lifecycle/resume.ts`（纯逻辑、可单测），
 *   这里只负责接线与读盘；
 * - 不建会话、不发指令、不建目录：恢复的副作用只有两处进程内注册表。
 *
 * ## 读用 `node:fs`，写一律不在这里
 *
 * 这条操作**只读**项目目录里的三份事实（项目记录 / 交接记录 / 估值输入与材料字节），
 * 与 `handoffProject` 回读归档副本是同一条口径：读不是提权动作，Broker 的操作表里也没有
 * "面板读取案例文件"这一项（写入才是提权动作，而恢复不写盘）。
 */
export interface ResumeOperationDeps {
  ctx: Context
  state: WorkbenchState
  /** 轮次注册表（与 Tool 闭包共用同一份实例）。 */
  lifecycles: ValuationLifecycles
  /** 案例 scope 注册表（与 Tool 闭包共用同一份实例）。 */
  scopes: ValuationScopes
}

async function readText(path: string): Promise<string> {
  return await readFile(path, 'utf8')
}

async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

export function createResumeOperations(deps: ResumeOperationDeps): OperationMap {
  const service = () => workspaceSessionService(deps.ctx, deps.state)

  const resumeDeps: ResumeDeps = {
    accessGranted: () => localAccessGranted(deps.state.localAccess),
    workspace: async () => {
      const selected = await service().requireSelectedWorkspace()
      if (!selected.ok) return { ok: false, error: selected.error, workspaceId: '', workspacePath: '' }
      return {
        ok: true,
        error: '',
        workspaceId: selected.workspace.id,
        workspacePath: selected.workspace.path,
      }
    },
    readProjectText: readText,
    readProjectBytes: readBytes,
    samePath: async (left, right) => {
      const [a, b] = await Promise.all([pathKey(deps.ctx, left), pathKey(deps.ctx, right)])
      return a !== '' && a === b
    },
    verifySession: async (placement) => await service().verifyPlacement(placement),
    recordedHandoff: async (projectId) => {
      // 交接记录**必须从磁盘读**：进程内那一份随插件实例消失，而恢复恰恰是跨实例的路径。
      // 读不出来 / 不是合法 JSON / 字段缺失都返回 `undefined`，由恢复路径据此拒绝（fail closed）。
      const path = joinLocalPath(joinLocalPath(deps.state.workspacePath, projectId), HANDOFF_RECORD_FILE)
      let parsed: unknown
      try {
        parsed = JSON.parse(await readText(path))
      } catch (error) {
        void error
        return undefined
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const record = parsed as Record<string, unknown>
      return { state: text(record.state), parentSessionId: text(record.parentSessionId) }
    },
    scopes: { open: (scope) => { deps.scopes.open(scope) } },
    lifecycles: deps.lifecycles,
    now: () => new Date(),
  }

  return {
    'valuation-project-resume': async (args): Promise<ResumeOutcome> => await resumeProject(
      { projectId: text(args.projectId) },
      resumeDeps,
    ),
  }
}

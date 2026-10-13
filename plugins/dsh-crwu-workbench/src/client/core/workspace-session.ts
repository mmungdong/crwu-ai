import { text } from '../../shared/utils/value.ts'
import { zhCN } from '../locales/zh-CN.ts'

/**
 * 客户端侧的工作区会话门禁（协议 32）。
 *
 * 为什么客户端也要有一层：DSH 的普通会话只能从浏览器侧服务建
 * （`sessions.create` —— 客户端没有"读文件系统"或"读工作区注册表"的能力），
 * 而**落点参数是客户端自己拼的**。历史实现里有三处各拼一套：
 * 报告讨论 `{ workspaceId } | { cwd: workspacePath }`、本地审核同样的二选一、
 * 估值链路什么都不传 —— 于是同一个"我选中的工作区"在三处含义不同，
 * 其中两处会退回 `cwd`、一处会落到部署默认目录。
 *
 * 现在的口径只有一条：**`workspaceId` 为空就不建会话**。
 * 它不给业务页留任何"先建了再说"的机会 —— 会话建错位置比建不出来难查得多。
 */

/** 客户端能拿到的会话服务面（与 DSH 客户端 `sessions` 服务一致）。 */
export interface ClientSessionPort {
  create?: (input: { workspaceId?: string; cwd?: string }) => Promise<string>
}

/** 【环境信息】里选中的工作区（客户端可见的部分）。 */
export interface ClientWorkspace {
  id: string
  path: string
  title: string
}

export type WorkspaceGate =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string }

/**
 * 业务页进入前的门禁：拿不到工作区 id 就不许往下走。
 *
 * ⚠️ **不**接受 `workspace.path` 当作替代 —— `cwd` 会让会话落在对的目录里、却挂在
 * 侧栏「未分组」下面（DSH 的归属判据是注册表里的 `sessionIds`），用户看到的就是
 * "对话没建在我选中的工作区下面"。宁可停下来让他去环境信息页选一次。
 */
export function requireWorkspaceId(
  workspace: { id?: string; path?: string } | undefined,
  message = zhCN.aiNoWorkspace,
): WorkspaceGate {
  const id = text(workspace?.id)
  if (id === '') return { ok: false, error: message }
  return { ok: true, workspaceId: id }
}

export interface CreateClientSessionResult {
  ok: boolean
  sessionId: string
  error: string
  /** 服务/方法根本不存在（旧宿主），调用方按"不支持"措辞报告。 */
  unsupported: boolean
}

/**
 * 在选中工作区里建一条客户端会话。
 *
 * 只发 `workspaceId`：`cwd` 一律不发（包括"顺带补一个也对"的情况 —— 一旦这个字段出现在
 * 调用里，下一个人就会拿它做降级）。
 */
export async function createClientWorkspaceSession(
  port: ClientSessionPort | undefined,
  workspace: ClientWorkspace | undefined,
): Promise<CreateClientSessionResult> {
  const gate = requireWorkspaceId(workspace)
  if (!gate.ok) return { ok: false, sessionId: '', error: gate.error, unsupported: false }
  if (typeof port?.create !== 'function') {
    return { ok: false, sessionId: '', error: zhCN.aiUnsupported, unsupported: true }
  }
  try {
    const created = await port.create({ workspaceId: gate.workspaceId })
    const sessionId = text(created).trim()
    if (sessionId === '') {
      return { ok: false, sessionId: '', error: zhCN.aiCreateFailed, unsupported: false }
    }
    return { ok: true, sessionId, error: '', unsupported: false }
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, sessionId: '', error: `${zhCN.aiCreateFailed}${detail}`, unsupported: false }
  }
}

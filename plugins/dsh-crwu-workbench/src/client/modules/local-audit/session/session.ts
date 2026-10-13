import { zhCN } from '../../../locales/zh-CN.ts'


/**
 * 本地审核的**会话接线**（客户端一侧，与 `report-audit/assistant-session.ts` 同一套适配思路）。
 *
 * DSH 的普通会话只能从浏览器侧服务建：`sessions.create` + `sessions.using(id, …, ref => …)` +
 * `uiWorkspace.openSession(id)`（客户端 `sessions` 上没有 `open()`）。所以 Host 负责扫描、
 * 快照、handoff 与固定提示词，**由客户端把那条对话建出来并切过去**。
 *
 * 四条口径（改之前先读，都是被真实故障逼出来的）：
 *
 * 1. **`cwd` 必须是本轮案例目录**：`local-audit-start` 会回一个 `casePath`，建会话时逐字用它
 *    （`sessions.create({ cwd: casePath })`）。DSH 的会话沙箱边界就是会话 cwd —— 不设成案例目录，
 *    对话里的案例内工具（`crwu_run_python_script` 等，非特权路径）写不进快照，审核真正开始时才失败。
 *    但 `casePath` **只用于建会话**：提示词原样用 Host 给的 `prompt`，绝对路径不进对话文本、
 *    也不出现在界面的可复制内容里。
 * 2. **借 face 必须走 `using()`**：`binding(id)` 只对已被 retain 的会话有值，刚 `create()` 出来的
 *    那条拿到的是 `undefined`，rename 与 prompt 都会被静默跳过（"建了会话但没名字、开场也没发出去"）。
 * 3. **认领失败不阻塞**：`local-audit-claim` 只是让 Host 提前把 `sessionId → 案例目录` 登记好；
 *    对话里的模型还会再认领一次，那是幂等的。所以这里只把失败原因带回界面。
 * 4. **失败绝不抛出去**：每一步都收敛成 `{ ok: false, error }` 这样一句人话 ——
 *    调用方（页面）据此显示"审核对话启动中断"+ 复制提示词的手动兜底。
 */

export interface SessionFaceLike {
  rename?: (title: string) => Promise<unknown>
  prompt?: (content: readonly { type: 'text'; text: string }[], mode: 'queue' | 'steer') => Promise<unknown>
}

export interface SessionPort {
  create?: (input?: { workspaceId?: string; cwd?: string }) => Promise<string>
  using?: (
    id: string,
    options: { source: string },
    operation: (reference: { binding?: { session?: SessionFaceLike } }) => Promise<unknown> | unknown,
  ) => Promise<unknown>
  openSession?: (sessionId: string) => void
}

export interface LocalAuditSessionInput {
  port: SessionPort | undefined
  handoffId: string
  prompt: string
  /**
   * 新会话要挂到哪个工作空间：**DSH 工作区注册表里的 id**（界面 `env.workspace.id`）。
   *
   * ⚠️ 2026-10-11 用户实测「本地审核的对话应该创建在我环境信息中已经配置的工作空间下面，
   * 而不是随便找个位置创建」—— 只给 `cwd` **不够**。读了 DSH 自己的客户端产物
   * （`ui-workspace` 的 `reuseOrCreateBlank`）：界面在某个工作区里建会话用的是
   * `sessions.create({ workspaceId })`，而侧栏「未分组」的判据是
   * `workspace.sessionIds.includes(id)` —— 也就是**宿主工作区注册表里的成员关系**，
   * 不是 cwd 匹配。只给 cwd 的会话永远挂在「未分组」下。
   *
   * ==协议 32==：空串时**直接失败**，不再退回 `cwd`。退到 cwd 的会话落在对的目录里、
   * 却仍然挂在「未分组」下 —— 那正是"没建在我选中的工作区下面"。
   */
  workspaceId?: string
  /**
   * 新会话的 `cwd`：**员工选定的工作空间**（`local-audit-start` 的 `workspacePath`）。
   *
   * ⚠️ 协议 32 起它**不参与**建会话（唯一落点参数是 `workspaceId`）；保留它是因为：
   * ① 界面要用它说明"本轮案例目录在工作区里的哪一层"；
   * ② DSH 的会话沙箱边界是会话 cwd，而 cwd 由 `workspaceId` 解析成工作区路径 ——
   *    两者必须一致，Host 侧会回读核对（`host/core/workspace-session`）。
   *
   * 它**不进提示词**、也不出现在界面的可复制文本里。
   */
  workspacePath: string
  /** 会话标题；缺省用 `本地审核 · MM-DD HH:mm`。 */
  title?: string
  /** `local-audit-claim` 的调用口（失败不阻塞，只把原因带回去）。 */
  claim?: (input: { handoffId: string; sessionId: string }) => Promise<{ ok?: boolean; error?: string }>
  clock?: () => number
}

export interface LocalAuditSessionResult {
  ok: boolean
  /** 建好的会话 id（失败时为空串）。 */
  sessionId: string
  /** 已经切过去了（`openSession` 真的调到了）。 */
  opened: boolean
  /** 失败原因（人话）。 */
  error: string
  /** 认领失败的原因（**不影响** `ok`）。 */
  claimError: string
  /** 结果分类：给界面挑措辞用（`unsupported` 与 `session` 的说法不同）。 */
  reason: '' | 'unsupported' | 'session'
}

/** 两段补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 会话名：`本地审核 · 10-11 14:30`（`create` 不接受标题，所以建完立刻 rename）。 */
export function localAuditSessionTitle(at: Date): string {
  return `${zhCN.localAuditTitlePrefix}${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function failure(error: string, reason: 'unsupported' | 'session'): LocalAuditSessionResult {
  return { ok: false, sessionId: '', opened: false, error, claimError: '', reason }
}

/**
 * 建一条新的普通对话（`cwd` = 本轮案例目录），把固定审核指令发过去，然后切过去。
 *
 * 顺序是有意义的：**先建（带 cwd）→ 命名 → 发提示词 → 认领 → 切过去**。
 * 任何一步失败都返回可读原因，并且**不切会话**（切过去只会看到一个空对话）。
 */
export async function createLocalAuditSession(input: LocalAuditSessionInput): Promise<LocalAuditSessionResult> {
  const port = input.port
  if (typeof port?.create !== 'function' || typeof port?.using !== 'function') {
    return failure(zhCN.localAuditSessionUnsupported, 'unsupported')
  }
  // 落点**只有**工作区 id（协议 32）。空串绝不能发出去，也**不再**退到 `cwd`：
  //   - `cwd: ''` 会得到 `failed to ensure project directory "": mkdir ''`（2026-10-11 实测）；
  //   - `cwd: workspacePath` 会让会话落在对的目录、却归到侧栏「未分组」（DSH 按注册表的
  //     `sessionIds` 分组，不看 cwd）。
  const workspaceId = (input.workspaceId ?? '').trim()
  if (workspaceId === '') {
    return failure(zhCN.localAuditSessionNoWorkspace, 'session')
  }
  const create = port.create
  const using = port.using
  let sessionId = ''
  try {
    // 工作区 id 是**标识**，不进提示词 —— 提示词里只有 handoffId、展示名与快照内相对路径。
    sessionId = await create({ workspaceId })
  } catch (cause: unknown) {
    return failure(`${zhCN.localAuditSessionFailed}${describe(cause)}`, 'session')
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return failure(`${zhCN.localAuditSessionFailed}${zhCN.localAuditSessionUnsupported}`, 'session')
  }
  const id = sessionId.trim()
  const title = input.title ?? localAuditSessionTitle(new Date((input.clock ?? Date.now)()))
  let renameFailed = false
  try {
    await using(id, { source: 'crwuWorkbench:localAudit' }, async (reference) => {
      const face = reference?.binding?.session
      if (typeof face?.rename === 'function') {
        try {
          await face.rename(title)
        } catch {
          // 名字不是致命问题：会话已经建好，用户仍然能在左侧列表里找到它。
          renameFailed = true
        }
      }
      if (typeof face?.prompt !== 'function') throw new Error(zhCN.localAuditSessionUnsupported)
      await face.prompt([{ type: 'text', text: input.prompt }], 'queue')
    })
  } catch (cause: unknown) {
    // 提示词没发出去 = 这条对话对用户没有意义：如实报失败，让用户走复制提示词的兜底。
    return failure(`${zhCN.localAuditSessionSendFailed}${describe(cause)}`, 'session')
  }
  // 认领：Host 提前把 `sessionId → 案例目录` 登记好（模型在对话里还会再认领一次，幂等）。
  let claimError = ''
  if (typeof input.claim === 'function') {
    try {
      const claimed = await input.claim({ handoffId: input.handoffId, sessionId: id })
      if (claimed?.ok === false) claimError = claimed.error ?? ''
    } catch (cause: unknown) {
      claimError = describe(cause)
    }
  }
  // 切过去：`uiWorkspace.openSession` 是唯一有效的"跳到某条会话"入口；
  // 它缺席（旧宿主）时用户仍能在左侧会话列表里点那条新对话，所以不算失败。
  let opened = false
  if (typeof port.openSession === 'function') {
    try {
      port.openSession(id)
      opened = true
    } catch {
      opened = false
    }
  }
  return {
    ok: true, sessionId: id, opened, claimError, reason: '',
    error: renameFailed ? zhCN.localAuditSessionRenameFailed : '',
  }
}

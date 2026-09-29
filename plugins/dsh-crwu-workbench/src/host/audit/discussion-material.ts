import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { isSafeSeqNo } from '../../shared/consts.ts'
import { caseDirOf } from '../../shared/utils/case-dir.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { WorldFacts } from '../platform/world.ts'
import { RECORDS_STDOUT_MAX } from '../h3yun/consts.ts'
import { attachmentsOf } from '../h3yun/attachments.ts'
import type { H3yunFormResolver } from '../h3yun/form.ts'
import { runCrwu } from '../crwu/run.ts'
import { pick } from '../h3yun/fields.ts'
import { jsonObject } from '../tools/outcome.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import { ensureCaseDirectory } from '../tools/case-files.ts'
import type { DiscussionScopeRegistry } from './discussion-scope.ts'

/**
 * `discussion-material-open`：**报告讨论会话的受限材料登记**（协议 23）。
 *
 * ## 谁调它、什么时候调
 *
 * 客户端在 `ensureDiscussion`（新建**或**恢复一条报告讨论会话）之后、发 kickoff 提示词之前调。
 * 恢复时也调 —— 否则旧会话在插件重启 / TTL 过期之后就拿不到材料了。
 *
 * ## Host 负责的事（客户端只能提交 `sessionId` / `seqNo` / `objectId`）
 *
 * 1. **拒绝子代理会话**：讨论是顶层会话（`origin !== 'subagent'` 且 `delegationDepth` 不是子级）；
 * 2. **案例目录由 Host 算**：`<已选工作空间>/<流水号>`，客户端提交不了路径；
 * 3. **对象必须属于这条记录**：Host 自己按 `objectId` 取一次记录，核对它回带的 `ObjectId` / `SeqNo`
 *    —— 只看附件清单的话，`seqNo=A, objectId=B` 会把 **B 的附件白名单**登记成 **A 的案例目录**；
 * 4. **重新从氚云取附件清单**（不是读上一轮快照）：讨论的材料范围永远对应"此刻远端有什么"；
 * 5. 把这一批 `fileId` 存进内存白名单，返回 Host 算出的 `caseDir` 与附件数。
 *
 * ## 为什么不落盘
 *
 * 它是**临时授权**：插件重启即失效，重新点一次「与 DeepSeek 讨论报告」会重新登记。
 * 落盘会引出"文件在哪、怎么轮转、会不会被别的进程读到"一整套新问题，而它回答的问题
 * 在同一个进程生命周期里就有答案。
 */

export interface DiscussionMaterialDeps {
  ctx: Context
  state: WorkbenchState
  world: WorldFacts
  access: LocalAccessBroker
  form: H3yunFormResolver
  scopes: DiscussionScopeRegistry
}

/** 附件在返回值里的样子：**只给标识与名字**，不给带会话鉴权的下载 URL。 */
export interface DiscussionAttachmentView {
  fileId: string
  fileName: string
  /** 落盘时该用的名字（同名附件靠它区分）；讨论提示词直接照抄。 */
  localName: string
  fileSize: string
  nameTotal: number
}

export interface DiscussionMaterialView {
  ok: boolean
  error: string
  errorKind: string
  sessionId: string
  seqNo: string
  objectId: string
  /** Host 算出的案例目录（讨论会话唯一允许读写的本机路径）。 */
  caseDir: string
  attachments: DiscussionAttachmentView[]
  attachmentCount: number
  /** 白名单到期时刻（毫秒）；界面可以据此提示"重新登记"。 */
  expiresAt: number
}

function emptyView(input: { sessionId?: string; seqNo?: string; objectId?: string } = {}): DiscussionMaterialView {
  return {
    ok: false, error: '', errorKind: '', sessionId: text(input.sessionId), seqNo: text(input.seqNo),
    objectId: text(input.objectId), caseDir: '', attachments: [], attachmentCount: 0, expiresAt: 0,
  }
}

function failed(view: DiscussionMaterialView, errorKind: string, error: string): DiscussionMaterialView {
  return { ...view, ok: false, errorKind, error: error.slice(0, 600) }
}

/** 会话层级事实：只有子代理才有 `origin === 'subagent'` / `delegationDepth > 0`。 */
function sessionShapeOf(ctx: Context, sessionId: string): { found: boolean; subagent: boolean; depth: number } {
  const out = { found: false, subagent: false, depth: 0 }
  if (sessionId === '') return out
  try {
    const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: Record<string, unknown> } | undefined } | undefined
    const header = typeof sessions?.get === 'function' ? sessions.get(sessionId)?.header : undefined
    if (header === undefined) return out
    out.found = true
    out.subagent = text(header.origin) === 'subagent'
    out.depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : 0
  } catch (error) {
    // 会话服务问不到 → 保持"未知"，由下面的 fail closed 处理（不猜）。
    void error
  }
  return out
}

export async function openDiscussionMaterial(
  deps: DiscussionMaterialDeps,
  args: Record<string, unknown>,
): Promise<DiscussionMaterialView> {
  const { ctx, state } = deps
  const sessionId = text(args.sessionId).trim()
  const seqNo = text(args.seqNo).trim()
  const objectId = text(args.objectId).trim()
  const base = emptyView({ sessionId, seqNo, objectId })

  if (sessionId === '') return failed(base, 'input', '缺少 sessionId：材料范围必须绑定到一条具体会话')
  if (seqNo === '' || !isSafeSeqNo(seqNo)) return failed(base, 'input', '流水号缺失或形状不合法')
  if (objectId === '') return failed(base, 'input', '缺少 objectId：无法核对这条报告')

  // ① 顶层会话才算讨论（子代理一律拒绝：讨论是"人跟 AI 聊"的那条会话）。
  const shape = sessionShapeOf(ctx, sessionId)
  if (shape.subagent || shape.depth > 0) {
    return failed(base, 'policy', '这条会话本身是子代理：报告讨论的材料范围只登记给顶层会话')
  }

  // ② 工作空间必须已经选定 —— 案例目录由 Host 算，客户端提交不了。
  const workspace = text(state.workspacePath) || text(state.caseRoot)
  if (workspace === '') return failed(base, 'input', '尚未选定工作空间：请先在工作台第 ① 步选择一个已有目录')
  const caseDir = caseDirOf(workspace, seqNo)
  if (caseDir === '') return failed(base, 'input', '案例目录无法确定：请确认流水号与工作空间')

  const platform = await deps.world.platform()
  // ③ 案例目录必须先存在（讨论会话要在它里面落材料）。**唯一**允许插件自动创建的目录，
  //    所以这里复用审核启动那条受控通道：来源是 `panel`（客户端界面发起的准备动作）。
  const made = await ensureCaseDirectory(deps.access, caseDir, {
    workspace,
    probeWorkdir: await deps.world.workdir(),
    platform,
    source: 'panel',
  })
  if (!made.ok) return failed(base, made.errorKind === 'missing' ? 'input' : 'infrastructure', made.error)

  // ④ 表单 code 只来自 Host。
  const form = await deps.form.ensure()
  if (!form.ok) {
    return failed(base, form.error.startsWith('未在氚云定位到表单') ? 'not-found' : 'cli', form.error)
  }
  const runOptions = {
    workdir: caseDir,
    timeoutMs: 90_000,
    access: deps.access,
    source: 'panel' as const,
    platform,
    stdoutMaxBytes: RECORDS_STDOUT_MAX,
  }

  // ⑤ **对象必须属于这条记录**：Host 自己取一次记录并核对 ObjectId / SeqNo。
  //    只看附件清单是不够的：`seqNo=A, objectId=B` 会把 B 的附件白名单登记成 A 的案例目录。
  const recordRun = await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'get', '--schema', form.code, '--id', objectId], runOptions)
  if (!recordRun.ok) {
    return failed(base, recordRun.error !== '' ? 'infrastructure' : 'cli',
      `核对报告身份失败：${text(recordRun.error) || text(recordRun.stderr) || 'records get 未成功'}`)
  }
  const record = jsonObject(recordRun.stdout)
  const data = record !== null && record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : null
  if (data === null) return failed(base, 'cli', '记录接口没有返回可解析的记录对象')
  const recordId = text(pick(data, ['ObjectId', 'objectId', 'Id', 'id']))
  const recordSeq = text(pick(data, ['SeqNo', 'seqNo']))
  if (recordId === '' || recordSeq === '') {
    return failed(base, 'cli', '记录缺少 ObjectId / SeqNo：无法确认材料属于这条报告')
  }
  if (recordId !== objectId) return failed(base, 'input', '取回的记录不是请求的那一条（ObjectId 不一致）')
  if (recordSeq !== seqNo) return failed(base, 'input', '记录的流水号与请求的不一致：拒绝登记材料范围')

  // ⑥ 重新取附件清单（**不用**上一轮快照：讨论看到的是此刻远端有什么）。
  const filesRun = await runCrwu(ctx, ['crwu', 'h3yun', 'files', 'list', '--schema', form.code, '--id', objectId], runOptions)
  if (!filesRun.ok) {
    return failed(base, filesRun.error !== '' ? 'infrastructure' : 'cli',
      `读取附件清单失败：${text(filesRun.error) || text(filesRun.stderr) || 'files list 未成功'}`)
  }
  const rows = attachmentsOf(filesRun.stdout)
  if (rows === null) return failed(base, 'cli', '附件接口没有返回附件数组')

  // ⑦ 登记（同一条会话重复登记 = 刷新白名单与 TTL）。
  const registered = deps.scopes.register({
    sessionId,
    seqNo,
    objectId,
    caseDir,
    allowedAttachmentIds: rows.map((row) => row.fileId),
  })
  return {
    ok: true,
    error: '',
    errorKind: '',
    sessionId,
    seqNo,
    objectId,
    caseDir,
    attachments: rows.map((row) => ({
      fileId: row.fileId,
      fileName: row.fileName,
      localName: row.localName,
      fileSize: row.fileSize,
      nameTotal: row.nameTotal,
    })),
    attachmentCount: rows.length,
    expiresAt: registered.expiresAt,
  }
}

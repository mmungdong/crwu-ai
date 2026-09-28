import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { basenameLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem, readTextIfExists, resolveTarget } from '../fs/paths.ts'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { DINGTALK_TARGET, DWS_MAX_PAGES } from '../dws/consts.ts'
import { buildPublishPlan, nodeSize } from '../dws/plan.ts'
import { requireCaseDir, requireInsideCase, fileSize } from './case-dir.ts'
import { dwsJson, type DwsJsonOptions } from './dws-json.ts'
import { TOOL_NAMES, type ToolErrorKind } from './consts.ts'
import { failure, jsonObject, renderJson } from './outcome.ts'
import { credentialsTrusted, toolContext, type ToolDeps } from './types.ts'

/**
 * 钉钉回传 Tool：团队空间归档 + 把 HTML 发给自己并 DING。
 *
 * 两个工具把原来 `upload_audit_result.py`（`subprocess.run(["dws", …])`）与提示词里的
 * 裸 `dws` 命令链整体搬到 Host：
 * - **命令由 Tool 内部构造**，全部经 `dws/run.ts` 的白名单与 `ctx.shell`；
 * - **稳定 ID 一律来自真实返回**（profile / spaceId / rootFolderId / nodeId / userId /
 *   conversationId / messageId / openDingId），模型不接触也不写死；
 * - **同一个 profile 贯穿解析与执行**：先解析目标组织唯一默认账号，再把它显式带在每条命令上，
 *   不做「切当前 profile」这种有副作用的动作；
 * - **写后验证**：上传后重新列目录核对唯一名、类型与字节数；
 * - **单案例幂等**：通知只成功发一次，状态落在案例目录内的 `.crwu-dingtalk-notify.json`，
 *   并且同一案例的通知调用在进程内**串行**（避免并发重复发送）；
 * - **不允许 sms / call**：schema 里根本没有这个参数，命令模板固定 `--type app`。
 */

const ENVELOPE = {
  ok: { type: 'boolean', required: true },
  errorKind: { type: 'string', required: true },
  error: { type: 'string', required: true },
} as const

/** 通知幂等状态文件（落在案例目录里，随案例走）。 */
export const NOTIFY_STATE_FILE = '.crwu-dingtalk-notify.json'

/** 通知工具的规范化结果（与输出 schema 一一对应）。 */
interface NotifyResult {
  ok: boolean
  errorKind: string
  error: string
  alreadySent: boolean
  userId: string
  openDingTalkId: string
  conversationId: string
  messageId: string
  openDingId: string
  steps: string[]
}

interface NotifyState {
  schema: string
  ok: true
  seqNo: string
  userId: string
  openDingTalkId: string
  conversationId: string
  messageId: string
  openDingId: string
  sentAt: string
}

/** 从 `profile list` 的应答里选目标组织：必须唯一 corpId、且有且只有一个 isOrgCurrent。 */
export function selectCorpProfile(payload: unknown): { ok: true; profile: string } | { ok: false; error: string } {
  const doc = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const profiles = Array.isArray(doc.profiles) ? doc.profiles : null
  if (profiles === null) return { ok: false, error: 'DWS profile 返回缺少 profiles' }
  const exact = profiles.filter((item) => text((item as Record<string, unknown>)?.corpName) === DINGTALK_TARGET.corpName)
  const corpIds = new Set(exact.map((item) => text((item as Record<string, unknown>)?.corpId)).filter((id) => id !== ''))
  if (corpIds.size !== 1) {
    return { ok: false, error: `目标公司必须唯一：精确匹配 ${DINGTALK_TARGET.corpName} 得到 ${corpIds.size} 个组织` }
  }
  const current = exact.filter((item) => (item as Record<string, unknown>)?.isOrgCurrent === true)
  const profile = current.length === 1 ? text((current[0] as Record<string, unknown>)?.profile) : ''
  if (profile === '') return { ok: false, error: '目标公司必须有且只有一个 isOrgCurrent=true 账号' }
  return { ok: true, profile }
}

/** 团队空间列表项 → 规范化记录（把 `name` 归一成 `spaceName`）。 */
function spaceOf(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  return { ...doc, spaceName: text(doc.spaceName) || text(doc.name) }
}

/** 从 `drive +list` 的应答里取 `{ files, complete, error }`。 */
export function filesOf(payload: unknown): { files: Array<Record<string, unknown>>; complete: boolean; error: string } {
  const doc = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const data = doc.data !== null && typeof doc.data === 'object' ? doc.data as Record<string, unknown> : {}
  const rows = Array.isArray(data.files) ? data.files : (Array.isArray(doc.files) ? doc.files : null)
  if (rows === null) return { files: [], complete: false, error: '钉钉文件夹返回缺少 data.files' }
  if (data.hasMore === true) return { files: [], complete: false, error: '钉钉文件夹列表未完整返回（hasMore=true）' }
  const meta = doc.meta !== null && typeof doc.meta === 'object' ? doc.meta as Record<string, unknown> : {}
  const pagination = meta.pagination !== null && typeof meta.pagination === 'object' ? meta.pagination as Record<string, unknown> : {}
  if (pagination.endpoint_exhausted === false) return { files: [], complete: false, error: '钉钉文件夹分页未完成' }
  return { files: rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object'), complete: true, error: '' }
}

/** 精确解析唯一子节点。 */
export function resolveExact(
  files: readonly Record<string, unknown>[],
  name: string,
  label: string,
): { ok: true; node: Record<string, unknown> } | { ok: false; error: string } {
  const exact = files.filter((item) => text(item.name) === name)
  if (exact.length !== 1) {
    return { ok: false, error: `${label}必须唯一：精确匹配 ${name} 得到 ${exact.length} 项` }
  }
  const node = exact[0] as Record<string, unknown>
  const nodeId = text(node.nodeId)
  if (nodeId === '') return { ok: false, error: `${label}缺少 nodeId：${name}` }
  return { ok: true, node }
}

function isFolderNode(node: Record<string, unknown>): boolean {
  return text(node.type).toUpperCase() === 'FOLDER'
}

/** 读案例目录里的 JSON 文件。 */
async function readCaseJson(ctx: Context, path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const content = await readTextIfExists(ctx, path)
  if (content === '') return { ok: false, error: `文件不存在或为空：${path}` }
  const value = parseJsonLoose(content)
  if (value === null) return { ok: false, error: `不是合法 JSON：${path}` }
  return { ok: true, value }
}

export function dingtalkTools(deps: ToolDeps) {
  /** 通知的串行/排他队列：同一条案例的并发调用依次执行，避免重复发送。 */
  const notifyQueue = new Map<string, Promise<unknown>>()

  const archive = defineTool({
    name: TOOL_NAMES.dingtalkArchive,
    description: [
      '把最终态 审核结果.<项目ID>.json 归档到固定的钉钉企业团队空间（组织/团队空间/结果根目录都必须唯一且预先存在，只允许自动创建年/月两级目录）。',
      '远端文件名唯一（审核结果.<安全化项目ID>.<generatedAt 时间戳>.json），上传后重新列目录核对名称、类型与字节数。',
      'profile、spaceId、folderId、nodeId 全部来自真实返回；不需要也不接受模型提交这些标识。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '案例目录绝对路径' },
      seqNo: { type: 'string', required: true, description: '报告流水号（结果 JSON 命名为 审核结果.<seqNo>.json）' },
      fileName: { type: 'string', description: '可选的交付件相对名（相对 caseDir）；缺省 审核结果.<seqNo>.json' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ENVELOPE,
          corpName: { required: true, type: 'string' },
          spaceName: { required: true, type: 'string' },
          remotePath: { required: true, type: 'string' },
          remoteName: { required: true, type: 'string' },
          nodeId: { required: true, type: 'string' },
          sizeBytes: { required: true, type: 'integer' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          steps: { required: true, type: 'array', items: { type: 'string' } },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const steps: string[] = []
      const empty = {
        corpName: DINGTALK_TARGET.corpName, spaceName: DINGTALK_TARGET.spaceName,
        remotePath: '', remoteName: '', nodeId: '', sizeBytes: 0, exitCode: null as number | null, steps,
      }
      const ctx = toolContext(deps.ctx, exec)
      const caseCheck = await requireCaseDir(ctx, args.caseDir)
      if (!caseCheck.ok) return { ...caseCheck, ...empty }
      const seqNo = text(args.seqNo).trim()
      const requested = text(args.fileName).trim() || `审核结果.${seqNo}.json`
      const inside = await requireInsideCase(ctx, caseCheck.path, requested)
      if (!inside.ok) return { ...inside, ...empty }
      const caseDir = caseCheck.path

      const loaded = await readCaseJson(ctx, inside.path)
      if (loaded.ok === false) return { ...failure('input', loaded.error), ...empty }
      const plan = buildPublishPlan(loaded.value)
      if (plan.ok === false) return { ...failure('input', plan.error), ...empty }

      const platform = await deps.world.platform()
      const options: DwsJsonOptions = {
        workdir: caseDir,
        trusted: credentialsTrusted(deps),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      }
      const withProfile = (profile: string, argv: readonly string[]): string[] => ['--profile', profile, ...argv]

      // ① 目标组织与其唯一默认账号。
      const profiles = await dwsJson(ctx, platform, ['profile', 'list', '--format', 'json'], options)
      if (!profiles.ok) return { ...failure(profiles.errorKind, profiles.error), ...empty }
      const corp = selectCorpProfile(profiles.payload)
      if (corp.ok === false) return { ...failure('policy', corp.error), ...empty }
      steps.push('profile')
      const profile = corp.profile

      // ② 团队空间（orgSpace）：按 nextToken 完整续页后精确匹配。
      const spaceItems: Record<string, unknown>[] = []
      let cursor = ''
      for (let page = 0; page < DWS_MAX_PAGES; page += 1) {
        const argv = withProfile(profile, ['wiki', 'space', 'list', '--type', 'orgSpace', '--format', 'json'])
        if (cursor !== '') argv.push('--cursor', cursor)
        const listed = await dwsJson(ctx, platform, argv, options)
        if (!listed.ok) return { ...failure(listed.errorKind, listed.error), ...empty }
        const resultValue = listed.payload.result
        const rows = Array.isArray(resultValue)
          ? resultValue
          : (resultValue !== null && typeof resultValue === 'object' && Array.isArray((resultValue as Record<string, unknown>).items)
              ? (resultValue as Record<string, unknown>).items as unknown[]
              : null)
        if (rows === null) return { ...failure('cli', '团队空间返回缺少 result.items'), ...empty }
        for (const row of rows) {
          const space = spaceOf(row)
          if (space !== null) spaceItems.push(space)
        }
        const result = resultValue !== null && typeof resultValue === 'object'
          ? resultValue as Record<string, unknown>
          : {}
        cursor = text(result.nextToken)
        if (cursor === '') break
      }
      const exactSpaces = spaceItems.filter(
        (item) => text(item.spaceName) === DINGTALK_TARGET.spaceName && text(item.spaceType) === 'orgSpace',
      )
      if (exactSpaces.length !== 1) {
        return {
          ...failure('policy', `目标团队空间必须唯一：精确匹配 ${DINGTALK_TARGET.spaceName} 得到 ${exactSpaces.length} 项`),
          ...empty,
        }
      }
      const spaceId = text(exactSpaces[0]?.spaceId)
      const rootFolderId = text(exactSpaces[0]?.rootFolderId)
      if (spaceId === '' || rootFolderId === '') {
        return { ...failure('policy', '目标团队空间缺少 spaceId 或 rootFolderId'), ...empty }
      }
      steps.push('space')

      const listChildren = async (folderId: string): Promise<{ ok: true; files: Array<Record<string, unknown>> } | { ok: false; error: string; errorKind: ToolErrorKind }> => {
        const listed = await dwsJson(ctx, platform, withProfile(profile, [
          'drive', '+list', '--folder', folderId, '--page-all', '--max-pages', '20', '--max-items', '500', '--format', 'json',
        ]), options)
        if (!listed.ok) return { ok: false, error: listed.error, errorKind: listed.errorKind === '' ? 'cli' : listed.errorKind }
        const parsed = filesOf(listed.payload)
        if (!parsed.complete) return { ok: false, error: parsed.error, errorKind: 'cli' }
        return { ok: true, files: parsed.files }
      }

      // ③ 结果根目录（必须预先存在且唯一）。
      const rootList = await listChildren(rootFolderId)
      if (rootList.ok === false) return { ...failure(rootList.errorKind, rootList.error), ...empty }
      const rootResolved = resolveExact(rootList.files, DINGTALK_TARGET.rootFolderName, '目标结果文件夹')
      if (rootResolved.ok === false) return { ...failure('policy', rootResolved.error), ...empty }
      if (!isFolderNode(rootResolved.node)) {
        return { ...failure('policy', `目标结果目录不是文件夹：${DINGTALK_TARGET.rootFolderName}`), ...empty }
      }
      const targetId = text(rootResolved.node.nodeId)
      steps.push('root')

      const ensureDateFolder = async (parentId: string, name: string, label: string): Promise<{ ok: true; nodeId: string } | { ok: false; error: string }> => {
        const listed = await listChildren(parentId)
        if (listed.ok === false) return { ok: false, error: listed.error }
        const exact = listed.files.filter((item) => text(item.name) === name)
        if (exact.length > 1) return { ok: false, error: `${label}必须唯一：精确匹配 ${name} 得到 ${exact.length} 项` }
        if (exact.length === 1) {
          const resolved = resolveExact(listed.files, name, label)
          if (resolved.ok === false) return { ok: false, error: resolved.error }
          if (!isFolderNode(resolved.node)) return { ok: false, error: `${label}不是有效文件夹：${name}` }
          return { ok: true, nodeId: text(resolved.node.nodeId) }
        }
        const created = await dwsJson(ctx, platform, withProfile(profile, [
          'drive', '+create-folder', '--name', name, '--folder', parentId, '--space-id', spaceId, '--yes', '--format', 'json',
        ]), options)
        if (!created.ok) return { ok: false, error: created.error }
        const relisted = await listChildren(parentId)
        if (relisted.ok === false) return { ok: false, error: relisted.error }
        const resolved = resolveExact(relisted.files, name, label)
        if (resolved.ok === false) return { ok: false, error: resolved.error }
        if (!isFolderNode(resolved.node)) return { ok: false, error: `${label}不是有效文件夹：${name}` }
        return { ok: true, nodeId: text(resolved.node.nodeId) }
      }

      const year = await ensureDateFolder(targetId, plan.plan.year, '年份文件夹')
      if (year.ok === false) return { ...failure('cli', year.error), ...empty }
      steps.push('year')
      const month = await ensureDateFolder(year.nodeId, plan.plan.month, '月份文件夹')
      if (month.ok === false) return { ...failure('cli', month.error), ...empty }
      steps.push('month')

      // ④ 唯一远端文件名：同名立即停止（不覆盖、不追加随机序号）。
      const before = await listChildren(month.nodeId)
      if (before.ok === false) return { ...failure(before.errorKind, before.error), ...empty }
      if (before.files.some((item) => text(item.name) === plan.plan.remoteName)) {
        return {
          ...failure('policy', `目标月份目录已存在同名文件，拒绝覆盖：${plan.plan.remoteName}`),
          ...empty,
          remoteName: plan.plan.remoteName,
        }
      }

      // ⑤ 上传（cwd = 案例目录；`--file` 只接受工作目录内相对路径）。
      // `--file` 只接受工作目录内相对路径：取末段要认两种分隔符（Windows 上是 `\`）。
      const relativeName = basenameLocalPath(requested)
      const uploaded = await dwsJson(ctx, platform, withProfile(profile, [
        'drive', '+upload', '--file', relativeName, '--file-name', plan.plan.remoteName,
        '--folder', month.nodeId, '--space-id', spaceId, '--yes', '--format', 'json',
      ]), options)
      const exitCode = uploaded.ok ? (uploaded.run.exitCode ?? 0) : (uploaded.run?.exitCode ?? null)
      if (!uploaded.ok) {
        return { ...failure(uploaded.errorKind, uploaded.error), ...empty, remoteName: plan.plan.remoteName, exitCode }
      }
      steps.push('upload')

      // ⑥ 写后验证：重新列目录，必须唯一命中、是普通文件、字节数与本地一致。
      const after = await listChildren(month.nodeId)
      if (after.ok === false) return { ...failure(after.errorKind, after.error), ...empty, remoteName: plan.plan.remoteName, exitCode }
      const hit = after.files.filter((item) => text(item.name) === plan.plan.remoteName)
      if (hit.length !== 1 || text(hit[0]?.nodeId) === '') {
        return { ...failure('cli', `上传后无法唯一读回目标 JSON：${plan.plan.remoteName}`), ...empty, remoteName: plan.plan.remoteName, exitCode }
      }
      const node = hit[0] as Record<string, unknown>
      if (isFolderNode(node)) {
        return { ...failure('cli', `上传后读回目标不是普通文件：${plan.plan.remoteName}`), ...empty, remoteName: plan.plan.remoteName, exitCode }
      }
      const localSize = await fileSize(ctx, inside.path)
      let remoteSize = nodeSize(node)
      if (remoteSize === null) {
        const inspected = await dwsJson(ctx, platform, withProfile(profile, [
          'drive', '+inspect', '--node', text(node.nodeId), '--format', 'json',
        ]), options)
        if (inspected.ok) {
          const data = inspected.payload.data !== null && typeof inspected.payload.data === 'object'
            ? inspected.payload.data as Record<string, unknown>
            : {}
          remoteSize = nodeSize(data)
        }
      }
      if (remoteSize !== null && remoteSize !== localSize) {
        return {
          ...failure('cli', `上传后文件大小不一致：local=${localSize}, remote=${remoteSize}`),
          ...empty, remoteName: plan.plan.remoteName, nodeId: text(node.nodeId), exitCode,
        }
      }
      steps.push('verify')
      return {
        ok: true,
        errorKind: '' as const,
        error: '',
        corpName: DINGTALK_TARGET.corpName,
        spaceName: DINGTALK_TARGET.spaceName,
        remotePath: [DINGTALK_TARGET.rootFolderName, plan.plan.year, plan.plan.month, plan.plan.remoteName].join('/'),
        remoteName: plan.plan.remoteName,
        nodeId: text(node.nodeId),
        sizeBytes: localSize,
        exitCode,
        steps,
      }
    },
  })

  const notifySelf = defineTool({
    name: TOOL_NAMES.dingtalkNotifySelf,
    description: [
      '把案例目录里的审核意见 HTML 发到「我自己的钉钉单聊」，并把那条文件消息转成**应用内** DING（免费；不使用 sms/call）。',
      '稳定 ID（userId / openDingTalkId / conversationId / messageId / openDingId）全部来自真实命令返回。',
      '一个案例只允许成功发送一次：已发过就返回上次结果（alreadySent=true），不会重复发送。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '案例目录绝对路径（HTML 必须位于其内）' },
      seqNo: { type: 'string', required: true, description: '报告流水号（HTML 命名为 审核意见.<seqNo>.html）' },
      displayName: { type: 'string', description: '可选：用于解析 openDingTalkId 的姓名（缺省用 dws 返回的本人员工模型姓名）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ENVELOPE,
          alreadySent: { required: true, type: 'boolean' },
          userId: { required: true, type: 'string' },
          openDingTalkId: { required: true, type: 'string' },
          conversationId: { required: true, type: 'string' },
          messageId: { required: true, type: 'string' },
          openDingId: { required: true, type: 'string' },
          steps: { required: true, type: 'array', items: { type: 'string' } },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const steps: string[] = []
      const empty = {
        alreadySent: false, userId: '', openDingTalkId: '', conversationId: '', messageId: '', openDingId: '', steps,
      }
      const caseCheck = await requireCaseDir(ctx, args.caseDir)
      if (!caseCheck.ok) return { ...caseCheck, ...empty }
      const seqNo = text(args.seqNo).trim()
      if (seqNo === '') return { ...failure('input', 'seqNo 不能为空'), ...empty }
      const caseDir = caseCheck.path

      const send = async (): Promise<NotifyResult> => {
        const statePath = `${caseDir.replace(/[\\/]+$/, '')}/${NOTIFY_STATE_FILE}`
        // ① 幂等：案例目录里已有成功记录就直接回放，不再发送。
        const existing = await readTextIfExists(ctx, statePath)
        if (existing !== '') {
          const parsed = jsonObject(existing)
          if (parsed !== null && parsed.ok === true) {
            steps.push('idempotent')
            return {
              ok: true, errorKind: '', error: '', alreadySent: true,
              userId: text(parsed.userId), openDingTalkId: text(parsed.openDingTalkId),
              conversationId: text(parsed.conversationId), messageId: text(parsed.messageId),
              openDingId: text(parsed.openDingId), steps,
            }
          }
        }

        const html = `审核意见.${seqNo}.html`
        const inside = await requireInsideCase(ctx, caseDir, html)
        if (!inside.ok) return { ...inside, ...empty }
        if (await fileSize(ctx, inside.path) <= 0) {
          return { ...failure('input', `HTML 交付件不存在或为空：${html}`), ...empty }
        }

        const platform = await deps.world.platform()
        const options: DwsJsonOptions = {
          workdir: caseDir,
          trusted: credentialsTrusted(deps),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        }
        const withProfile = (profile: string, argv: readonly string[]): string[] => ['--profile', profile, ...argv]

        // ② 目标组织唯一默认账号：解析与后续执行用**同一个** profile，全程不切当前 profile。
        const profiles = await dwsJson(ctx, platform, ['profile', 'list', '--format', 'json'], options)
        if (!profiles.ok) return { ...failure(profiles.errorKind, profiles.error), ...empty }
        const corp = selectCorpProfile(profiles.payload)
        if (corp.ok === false) return { ...failure('policy', corp.error), ...empty }
        const profile = corp.profile
        steps.push('profile')

        // ③ 自己的稳定 ID。
        const self = await dwsJson(ctx, platform, withProfile(profile, ['contact', 'user', 'get-self', '--format', 'json']), options)
        if (!self.ok) return { ...failure(self.errorKind, self.error), ...empty }
        const selfInfo = readSelf(self.payload)
        if (selfInfo.userId === '') return { ...failure('cli', 'get-self 没有返回 userId'), ...empty }
        steps.push('self')

        // ④ openDingTalkId：按姓名精确解析，取不到才退回 get-self 里的值。
        const name = text(args.displayName).trim() || selfInfo.name
        let openDingTalkId = ''
        if (name !== '') {
          const found = await dwsJson(ctx, platform, withProfile(profile, [
            'aisearch', 'person', '--query', name, '--dimension', 'name', '--format', 'json',
          ]), options)
          if (found.ok) openDingTalkId = readOpenDingTalkId(found.payload, name)
        }
        if (openDingTalkId === '') openDingTalkId = selfInfo.openDingTalkId
        if (openDingTalkId === '') {
          return { ...failure('cli', '未能解析 openDingTalkId（人员精确定位失败）'), ...empty, userId: selfInfo.userId }
        }
        steps.push('person')

        // ⑤ 发文件消息到自己的单聊（cwd = 案例目录，`--file` 用相对名）。
        const sent = await dwsJson(ctx, platform, withProfile(profile, [
          'chat', '+messages-send', '--as', 'user', '--user', selfInfo.userId, '--msg-type', 'file', '--file', html, '--format', 'json',
        ]), options)
        if (!sent.ok) return { ...failure(sent.errorKind, sent.error), ...empty, userId: selfInfo.userId, openDingTalkId }
        steps.push('send')

        // ⑥ 读回 conversationId / messageId：取附件名正是本次 HTML 的那条。
        const readBack = await dwsJson(ctx, platform, withProfile(profile, [
          'chat', '+chat-messages', '--user', selfInfo.userId, '--page-size', '2', '--format', 'json',
        ]), options)
        if (!readBack.ok) {
          return { ...failure(readBack.errorKind, readBack.error), ...empty, userId: selfInfo.userId, openDingTalkId }
        }
        const located = locateMessage(readBack.payload, html)
        if (located.conversationId === '' || located.messageId === '') {
          return { ...failure('cli', '未能从会话消息里定位到刚发出的文件消息'), ...empty, userId: selfInfo.userId, openDingTalkId }
        }
        steps.push('locate')

        // ⑦ 转成应用内 DING（免费通道；sms/call 不在命令模板里）。
        const ding = await dwsJson(ctx, platform, withProfile(profile, [
          'ding', 'message', 'send-by-message', '--group', located.conversationId, '--message-id', located.messageId,
          '--users', openDingTalkId, '--type', 'app', '--format', 'json',
        ]), options)
        if (!ding.ok) {
          return { ...failure(ding.errorKind, ding.error), ...empty, userId: selfInfo.userId, openDingTalkId, ...located }
        }
        const openDingId = readOpenDingTalkId(ding.payload, '')
        if (openDingId === '') {
          return {
            ...failure('cli', 'DING 回执里没有真实 openDingId，按失败处理'),
            ...empty, userId: selfInfo.userId, openDingTalkId, ...located,
          }
        }
        steps.push('ding')

        // ⑧ 落幂等状态（写失败不影响本次已经发生的发送，但要在结果里说清）。
        const state: NotifyState = {
          schema: 'crwu.dingtalk-notify.v1',
          ok: true,
          seqNo,
          userId: selfInfo.userId,
          openDingTalkId,
          conversationId: located.conversationId,
          messageId: located.messageId,
          openDingId,
          sentAt: new Date().toISOString(),
        }
        if (!await persistNotifyState(ctx, statePath, state)) steps.push('state-write-failed')
        return {
          ok: true, errorKind: '' as const, error: '', alreadySent: false,
          userId: selfInfo.userId, openDingTalkId,
          conversationId: located.conversationId, messageId: located.messageId,
          openDingId, steps,
        }
      }

      // 串行/排他：同一条案例的并发调用排队执行，避免「两次点击 = 两次发送」。
      const previous = notifyQueue.get(seqNo)
      const task = (async () => {
        if (previous !== undefined) await previous.catch(() => undefined)
        return await send()
      })()
      notifyQueue.set(seqNo, task)
      try {
        return await task
      } finally {
        if (notifyQueue.get(seqNo) === task) notifyQueue.delete(seqNo)
      }
    },
  })

  return [archive, notifySelf]
}

/** 从 `get-self` 返回里取本人员工模型。 */
export function readSelf(payload: unknown): { userId: string; name: string; openDingTalkId: string } {
  const doc = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const result = Array.isArray(doc.result) ? doc.result : []
  const first = result.length > 0 && result[0] !== null && typeof result[0] === 'object'
    ? result[0] as Record<string, unknown>
    : {}
  const model = first.orgEmployeeModel !== null && typeof first.orgEmployeeModel === 'object'
    ? first.orgEmployeeModel as Record<string, unknown>
    : first
  return {
    userId: text(model.userId) || text(first.userId),
    name: text(model.orgUserName) || text(first.orgUserName),
    openDingTalkId: text(model.openDingTalkId) || text(first.openDingTalkId),
  }
}

/**
 * 从 `aisearch person` / `ding message send-by-message` 的返回里取 `openDingTalkId`。
 *
 * 两个来源的字段名不同：人员搜索给 `openDingTalkId`，DING 回执给 `openDingId`。
 * 只认真实返回，取不到就返回空串（调用方按失败处理），不猜、不拼。
 */
export function readOpenDingTalkId(payload: unknown, name: string): string {
  const doc = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  for (const key of ['result', 'data', 'persons', 'items']) {
    const bucket = doc[key]
    const rows = Array.isArray(bucket)
      ? bucket
      : (bucket !== null && typeof bucket === 'object' && Array.isArray((bucket as Record<string, unknown>).items)
          ? (bucket as Record<string, unknown>).items as unknown[]
          : null)
    if (rows === null) continue
    const exact = rows.filter((row) => {
      if (row === null || typeof row !== 'object') return false
      const model = row as Record<string, unknown>
      return name === '' || text(model.name) === name || text(model.orgUserName) === name
    })
    const chosen = (exact.length > 0 ? exact : (name === '' ? rows : []))[0]
    const id = text((chosen as Record<string, unknown> | undefined)?.openDingTalkId)
      || text((chosen as Record<string, unknown> | undefined)?.openDingId)
    if (id !== '') return id
  }
  // 兜底：DING 回执是**单个对象**（`result.openDingId`），不是人员数组。
  // 只在人员数组路径完全没结果时才走到这里，避免拿别人的 ID 顶替。
  return findOdingIdDeep(payload, 0)
}

/** 在返回体里按深度优先找一个 `openDingId` / `openDingTalkId` 字符串值。 */
function findOdingIdDeep(value: unknown, depth: number): string {
  if (depth > 3 || value === null || typeof value !== 'object') return ''
  for (const key of ['openDingId', 'openDingTalkId']) {
    const found = text((value as Record<string, unknown>)[key])
    if (found !== '') return found
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested === null || typeof nested !== 'object') continue
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findOdingIdDeep(item, depth + 1)
        if (found !== '') return found
      }
      continue
    }
    const found = findOdingIdDeep(nested, depth + 1)
    if (found !== '') return found
  }
  return ''
}

/** 在会话消息返回里定位刚发出的文件消息（按附件名匹配，取最新一条）。 */
export function locateMessage(payload: unknown, fileName: string): { conversationId: string; messageId: string } {
  const doc = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const candidates: unknown[] = []
  for (const key of ['result', 'data', 'messages', 'items']) {
    const value = doc[key]
    if (Array.isArray(value)) candidates.push(...value)
    else if (value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)) {
      candidates.push(...((value as Record<string, unknown>).items as unknown[]))
    }
  }
  for (const row of candidates) {
    if (row === null || typeof row !== 'object') continue
    const message = row as Record<string, unknown>
    const refs = JSON.stringify(message.resourceRefs ?? message.attachments ?? '')
    if (fileName !== '' && !refs.includes(fileName)) continue
    const conversationId = text(message.conversationId) || text(message.openConversationId) || text(message.cid)
    const messageId = text(message.messageId) || text(message.openMessageId) || text(message.msgId)
    if (conversationId !== '' && messageId !== '') return { conversationId, messageId }
  }
  return { conversationId: '', messageId: '' }
}

/** 写幂等状态文件（案例目录内）。 */
async function persistNotifyState(ctx: Context, path: string, state: NotifyState): Promise<boolean> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    await fs.writeText(await resolveTarget(ctx, path), `${JSON.stringify(state, null, 2)}\n`)
    return true
  } catch (error) {
    void error
    return false
  }
}

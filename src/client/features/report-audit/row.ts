/**
 * 报告页的判定规则。
 *
 * **这里是整块 UI 里唯一值得测的部分**：显示哪些徽章、哪些按钮、能不能点，全是业务规则；
 * 渲染只是把这些数据摊成元素。所以规则放在 `.ts`（无 JSX），可以被 `node --test` 直接加载。
 *
 * 三条从 legacy 继承、且都能反向失败的关键规则：
 *
 * 1. **「停止」与「重新审核」互斥**。子会话还活着只能停；已结束才能重新审核。
 *    给了口子就意味着一份报告能同时跑两条子会话，而它们往**同一个案例目录**对写。
 * 2. **云端已有审核意见 → 主按钮是「重新审核」且要二次确认**，不是「AI 审核」。
 *    否则用户会以为从来没审过。
 * 3. **「重传 OSS」只在「已出结果且还没上传」时出现**，不是一有记录就出现。
 */

import { text } from '../../../shared/utils/value.ts'
import type { AuditView, Badge, BadgeTone, ButtonSpec, CloudItem, Gating, RowView, TaskRow } from './types.ts'

/** 行标识：流水号优先，缺失时退到报告名（与 Host 的 key 约定一致）。 */
export function rowKeyOf(task: Pick<TaskRow, 'seqNo' | 'name'>): string {
  return task.seqNo !== '' ? task.seqNo : task.name
}

/** 云端有没有这条报告的审核意见。 */
export function hasCloudResult(cloud: CloudItem | null | undefined): boolean {
  return cloud !== null && cloud !== undefined && cloud.htmlKey !== ''
}

/** 有没有可看的审核信息（HTML + JSON 都在才算 —— 只有 HTML 时抽屉里没有内容）。 */
export function hasAuditInfo(cloud: CloudItem | null | undefined): boolean {
  return cloud !== null && cloud !== undefined && cloud.htmlKey !== '' && cloud.jsonKey !== ''
}

/**
 * 风险等级 → 徽章。
 *
 * 氚云「报告审核」表单里 `risk` 的实际取值是 `A` / `B` / `C`（本机实测 50 条抽样：B 46、A 3、C 1），
 * 另外两种写法（高/中/低）也一并认，免得换表单后整列变成「未知」。
 *
 * **文案一律用原始值**，只由色调表达轻重 —— 本仓不允许改写外部原始数据，
 * 而「A 到底代表高风险还是低风险」是业务口径，不由插件替用户判断。
 * 空值给 `—`：那表示这条记录没填风险等级，不是「风险为零」。
 */
export function riskBadge(risk: string): Badge {
  const value = risk.trim()
  const tone: BadgeTone = value === 'A' || value === '高'
    ? 'high'
    : (value === 'B' || value === '中' ? 'medium' : (value === '' ? 'low' : 'low'))
  return { text: value === '' ? '—' : value, tone }
}

/**
 * 审核状态 → 徽章文案与色调。
 *
 * `idle` 表示「正常跑完但还没扫到交付件」，**不是失败** —— 说成失败会让用户去重启一个
 * 其实已经跑完的审核。
 */
export function statusBadge(status: string): Badge {
  const map: Record<string, { text: string; tone: BadgeTone }> = {
    running: { text: '审核中', tone: 'medium' },
    stopped: { text: '已停止', tone: 'low' },
    failed: { text: '已中断', tone: 'high' },
    done: { text: '已出结果', tone: 'ok' },
    idle: { text: '未出结果', tone: 'low' },
  }
  const hit = map[status] ?? map.idle
  return hit ?? { text: '未出结果', tone: 'low' }
}

/**
 * 子会话还活着吗 —— 「停止」与「重新审核」的互斥判据。
 *
 * `childAlive` 来自 Host（按父会话的子代理清单判定），比前端猜可靠；
 * `status === 'running'` 作为轮询还没跟上的兜底。
 */
export function childIsLive(audit: AuditView): boolean {
  if (audit.ended || audit.stopped) return false
  return audit.childAlive === true || audit.status === 'running'
}

/** 发起审核按钮的文案：云端已有意见时是「重新审核」，否则「AI 审核」。 */
export function startLabel(cloud: CloudItem | null | undefined): string {
  return hasCloudResult(cloud) ? '重新审核' : 'AI 审核'
}

/**
 * 「查看会话」要打开哪条子会话。
 *
 * **`key` 必须来自被点的那一行。** 早先这里拿面板的 `activeKey`（「当前在跑的那条」）顶替，
 * 于是用户在别的行上点「查看会话」时，要么开到错的孩子，要么在 `activeKey` 为空时直接得到
 * 「该记录没有子会话 id。」（实测踩到，见 AGENTS.md §7）。这个按钮本身就只在
 * 「这一行的记录有 childId」时才渲染（见 `deriveRowView`），所以这里不猜、不兜底。
 *
 * 唯一保留的兜底是父级 id：老记录可能没存 `parentSessionId`，退回界面登记的审核根/父会话，
 * 免得「查看会话」因为缺一个父级参数整条走不通。
 */
export function openSessionTarget(
  key: string,
  audits: Record<string, AuditView> | null | undefined,
  boundParentId: string,
): { childId: string; parentSessionId: string } {
  const record = audits?.[key]
  return {
    childId: text(record?.childId),
    parentSessionId: text(record?.parentSessionId) || boundParentId,
  }
}

/**
 * 发起/重启按钮。
 *
 * `confirm` 由调用方**显式**给出，不从云端状态推：两条路径的语义不同 ——
 * 没审过时「云端有意见」才需要确认；已有记录时的「重新审核」**一律**要确认
 * （legacy 也是硬编码 `confirm: true`）。早先我从 cloud 推 confirm，
 * 结果「记录里有、云端清单还没拉到」时重新审核变成了单击即跑。
 */
function startButton(gating: Gating, key: string, label: string, options: { confirm: boolean; retry: boolean }): ButtonSpec {
  const creating = gating.auditBusy === key
  return {
    id: 'start',
    label: creating ? '创建中…' : label,
    tone: 'primary',
    disabled: !gating.canDispatch || gating.busy === true || (gating.auditBusy ?? '') !== '' || !gating.canStart,
    confirm: options.confirm,
    retry: options.retry,
  }
}

/** 门禁提示语：先看「有没有认证」，再看「有没有别的审核在跑」。 */
function gatingNote(gating: Gating): string {
  if (!gating.canDispatch) return gating.gateReason ?? '需先通过钉钉认证'
  if (!gating.canStart) return '已有审核在进行中'
  return ''
}

/**
 * 一条报告行最终长什么样。
 *
 * @param task 氚云记录（提供流水号与报告名）
 * @param audit 该流水号的审核记录；没有表示这条还没发起过
 * @param cloud 该流水号的云端交付件；没有表示云端还没审过
 */
export function deriveRowView(
  task: Pick<TaskRow, 'seqNo' | 'name'>,
  audit: AuditView | null | undefined,
  cloud: CloudItem | null | undefined,
  gating: Gating,
): RowView {
  const key = rowKeyOf(task)
  const badges: Badge[] = []
  const buttons: ButtonSpec[] = []
  const notes: string[] = []

  // 云端按钮在两种情况下都要出现：还没发起过（给「查看报告」），或已有记录。
  if (hasCloudResult(cloud)) {
    buttons.push({ id: 'cloud-report', label: '查看报告', tone: 'primary', disabled: false })
  }
  if (hasAuditInfo(cloud)) {
    buttons.push({ id: 'audit-info', label: '审核信息', tone: 'plain', disabled: false })
  }

  if (audit === null || audit === undefined) {
    const fromCloud = hasCloudResult(cloud)
    buttons.unshift(startButton(gating, key, startLabel(cloud), { confirm: fromCloud, retry: fromCloud }))
    const note = gatingNote(gating)
    if (note !== '') notes.push(note)
    return { key, badges, buttons, notes }
  }

  badges.push(statusBadge(audit.status))
  // 「活着但不是 running」单独提示：这两种判据不一致时用户最需要知道。
  if (audit.childAlive === true && audit.status !== 'running') {
    badges.push({ text: '会话仍存活', tone: 'medium' })
  }
  if (audit.attempt > 1) badges.push({ text: `第 ${audit.attempt} 次`, tone: 'low' })
  if (audit.uploadedAt !== '') badges.push({ text: '已上云', tone: 'ok' })
  if (audit.uploadError !== '') badges.push({ text: '上云失败', tone: 'high' })

  if (audit.startedAt !== '') {
    const suffix = audit.attempt > 1 ? `（第 ${audit.attempt} 次）` : ''
    notes.push(`启动 ${formatTime(audit.startedAt)}${suffix}`)
  }
  // 停止原因只在不是运行中时显示：运行中的记录可能带着上一次的残留原因。
  if (audit.status !== 'running' && audit.stopReason !== '') notes.push(audit.stopReason)
  if (audit.uploadError !== '') notes.push(audit.uploadError)

  const live = childIsLive(audit)
  if (live && audit.childId !== '') {
    buttons.push({
      id: 'stop',
      label: gating.stopBusy === true ? '停止中…' : '停止',
      tone: 'warn',
      disabled: gating.stopBusy === true,
    })
  }
  if (audit.htmlFile !== '') {
    buttons.push({ id: 'open-html', label: '本地 HTML', tone: 'plain', disabled: false })
  }
  if (audit.childId !== '') {
    buttons.push({ id: 'open-session', label: '查看会话', tone: 'plain', disabled: false })
  }
  if (audit.status === 'done' && audit.uploadedAt === '') {
    buttons.push({
      id: 'retry-upload',
      label: gating.retryBusy === true ? '重传中…' : '重传 OSS',
      tone: 'plain',
      disabled: gating.retryBusy === true,
    })
  }
  // 运行中不给「另起一条」：必须先停止。这条就是「两条子会话对写同一案例目录」的闸门。
  if (!live) buttons.push(startButton(gating, key, '重新审核', { confirm: true, retry: true }))

  return { key, badges, buttons, notes }
}

/** 时间显示：只到秒（`HH:MM:SS`）；解析不出就原样返回。 */
export function formatTime(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** AI 审核结果页的条目：只保留有交付件的，按流水号倒序（最新的在最上面）。 */
export function resultItems(ossIndex: Record<string, CloudItem> | null | undefined): CloudItem[] {
  return Object.values(ossIndex ?? {})
    .filter((item) => item !== null && item !== undefined && (item.htmlKey !== '' || item.jsonKey !== ''))
    .sort((left, right) => String(right.seqNo ?? '').localeCompare(String(left.seqNo ?? '')))
}

/** 待审核页的行：氚云记录 + 审核记录 + 云端交付件合成一行。 */
export function buildRows(
  tasks: TaskRow[],
  audits: Record<string, AuditView> | null | undefined,
  ossIndex: Record<string, CloudItem> | null | undefined,
  gating: Gating,
): RowView[] {
  return tasks.map((task) => {
    const key = rowKeyOf(task)
    return deriveRowView(task, audits?.[key], ossIndex?.[key], gating)
  })
}

/** 过滤模式提示：精确 / 模糊 / 无。 */
export function filterModeText(mode: string): string {
  if (mode === 'equal') return ' · 精确匹配'
  if (mode === 'contains') return ' · 模糊匹配'
  return ''
}

/** 页数；总数未知时为 1（不显示「第 1/0 页」）。 */
export function pageCount(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

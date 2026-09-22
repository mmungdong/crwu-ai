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

/**
 * 「查看报告」的结果 → 要不要给用户一句话。
 *
 * `ok` 只代表**签名成功**；「用系统默认程序打开」是另一个动作，结果在 `opened`/`openError` 里。
 * 早先客户端只判 `ok`（`if (!result.ok) setNotice(...)`），于是 `opened:false` 时界面**什么都
 * 不说** —— 点下去没反应，用户只能报「查看报告打不开」（实测踩到）。这里把两种情况都说清楚。
 */
export function openReportNotice(result: {
  ok: boolean
  error?: string
  opened?: boolean
  openError?: string
}): string {
  if (result.ok !== true) return text(result.error) || '打开报告失败'
  if (result.opened === false) {
    return `签名成功，但没能打开浏览器：${text(result.openError) || '打开命令未成功'}`
  }
  return ''
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

  // ── 操作列只回答一个问题："我现在最应该做什么？"（用户 2026-09-22 口径）──────────
  // 每行最多：1 个主操作 + 1 个 DeepSeek 小鲸鱼（在 JSX 里）+ 1 个 ••• 菜单。
  // 规则：有线上报告 → 查看报告；正在审核 → 「审核中」（**不可点**，避免重复触发）；
  // 其余 → 启动审核（AI 审核 / 重新审核按有无历史决定）。
  // 其余动作一律进 •••：「查看审核信息」「打开本地 HTML」「停止审核」「重传 OSS」「重新审核」。
  // 启动时间 / 停止原因 / 已上云 / 未出结果 / 第 N 次 全部是**详情**，列表不再展示。
  const hasReport = hasCloudResult(cloud)
  const live = audit !== null && audit !== undefined && childIsLive(audit)

  // 有没有"本地审核记录"决定了启动动作的措辞与确认：没记录过是「AI 审核」，
  // 审过一次再动就是「重新审核」（会覆盖结果，必须二次确认）。
  const everStarted = audit !== null && audit !== undefined
  if (hasReport) {
    buttons.push({ id: 'cloud-report', label: '查看报告', tone: 'primary', disabled: false })
    // 已有线上报告但本地没有记录：仍然要留一条「重新审核」在 ••• 里。
    if (!everStarted) {
      // 云端有审核信息（JSON 摘要）时，它同样进 •••：这一条不依赖本地审核记录。
      if (hasAuditInfo(cloud)) {
        buttons.push({ id: 'audit-info', label: '查看审核信息', tone: 'plain', disabled: false })
      }
      buttons.push(restartButton(gating))
      const note = gatingNote(gating)
      if (note !== '') notes.push(note)
      return { key, badges, buttons, notes }
    }
  } else if (live) {
    // 正在审核：主位是不可点的「审核中」（避免重复触发），停止进 •••。
    buttons.push({ id: 'progress', label: '审核中', tone: 'plain', disabled: true })
  } else {
    // 主操作只有**一个**，而且**不许两个同时出现**（用户 2026-09-22 口径：
    // 「有了重新审核就不要再有 AI 审核了，因为它的优先级相对高一点，强制 AI 去重新审核」）：
    //   没有任何审核记录 → AI 审核（首次发起，不需要二次确认）
    //   已经有记录（本地记录或云端交付件）→ 重新审核（会覆盖结果，一律二次确认）
    // 相应地，••• 里也**不再**重复放一个「重新审核」（同一个动作只出现一次）。
    buttons.push(startButton(gating, key, everStarted || hasReport ? '重新审核' : 'AI 审核', {
      confirm: everStarted || hasReport,
      retry: everStarted || hasReport,
    }))
  }

  if (!everStarted) {
    const note = gatingNote(gating)
    if (note !== '') notes.push(note)
    return { key, badges, buttons, notes }
  }

  // 只留**会改变下一步操作**的两类异常；其余状态不再占列表空间。
  if (audit.childAlive === true && audit.status !== 'running') {
    badges.push({ text: '会话仍存活', tone: 'medium' })
  }
  if (audit.uploadError !== '') badges.push({ text: '上云失败', tone: 'high' })

  // 次级动作 → ••• 菜单（顺序即菜单顺序）。
  if (hasAuditInfo(cloud)) {
    buttons.push({ id: 'audit-info', label: '查看审核信息', tone: 'plain', disabled: false })
  }
  if (audit.htmlFile !== '') {
    buttons.push({ id: 'open-html', label: '打开本地 HTML', tone: 'plain', disabled: false })
  }
  if (live && audit.childId !== '') {
    buttons.push({
      id: 'stop',
      label: gating.stopBusy === true ? '停止中…' : '停止审核',
      tone: 'plain',
      disabled: gating.stopBusy === true,
    })
  }
  if (audit.status === 'done' && audit.uploadedAt === '') {
    buttons.push({
      id: 'retry-upload',
      label: gating.retryBusy === true ? '重传中…' : '重传 OSS',
      tone: 'plain',
      disabled: gating.retryBusy === true,
    })
  }
  // 重新审核是低频且**会覆盖结果**的动作：如果有线上报告（主位被「查看报告」占着）
  // 或正在审核，它就待在 ••• 里；只有"没有线上报告且不在跑"时它才是主位。
  // 运行中一律不给「另起一条」：必须先停止（「两条子会话对写同一案例目录」的闸门）。
  // 主位已经是「重新审核」时不重复；只有主位被「查看报告」占着（有线上报告）才把重新审核放进 •••。
  if (hasReport && !live) buttons.push(restartButton(gating))

  // 「查看会话」已删除：它和小鲸鱼（DeepSeek 讨论入口）是同一个去处，重复入口只会让用户犹豫。
  return { key, badges, buttons, notes }
}

/** 「重新审核」：次级动作，永远是 ••• 里的一项，且一律二次确认（会覆盖已有结果）。 */
function restartButton(gating: Gating): ButtonSpec {
  return { id: 'restart', label: '重新审核', tone: 'plain', disabled: gating.busy === true, confirm: true, retry: true }
}

/** 这一行的**主操作**：第一个可点的主色按钮；「审核中」那种不可点的占位也算主位。 */
export function primaryActionOf(view: RowView): ButtonSpec | null {
  return view.buttons[0] ?? null
}

/** 进 ••• 菜单的次级动作（主操作之后的所有按钮）。 */
export function menuActionsOf(view: RowView): ButtonSpec[] {
  return view.buttons.slice(1)
}

/** 时间显示  return { key, badges, buttons, notes }
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

/** 待审核列表的检索上下文：翻页和刷新都必须保留当前查询条件。 */
export function pendingArgs(query: string, page: number): { query: string; page: number } {
  return { query, page }
}

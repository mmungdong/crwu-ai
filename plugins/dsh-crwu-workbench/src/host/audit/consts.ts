/** 审核域的类型与固定标记。字段名与 legacy 一致，界面不需要改。 */

/** 单条审核在界面上的状态。`idle` = 正常跑完但还没扫到交付件（不算失败）。 */
export type AuditStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped'

/**
 * 案例目录里的固定标记。
 *
 * 注意 `DEFAULT_CASE_ROOT` 从 legacy 的 `/Users/mungdong/crwu-audit-workspace` 改成了空串：
 * 那是作者本机的绝对路径，分发出去只会把别人的产物写到不存在的目录。案例根目录由
 * 「选定的工作空间」决定（见 `workspace/resolve.ts`），没有就要求用户显式选择。
 */
export const DEFAULT_CASE_ROOT = ''

/** 目录名 → 语义标记。前缀匹配，因为目录名带日期后缀。 */
export function dirMarker(name: string): string {
  if (name.startsWith('材料-源')) return 'materials'
  if (name.startsWith('工作版')) return 'work'
  if (name.startsWith('复核-人工')) return 'review'
  if (name.startsWith('媒体证据')) return 'media'
  if (name === 'knowledge') return 'knowledge'
  if (name === 'raw') return 'raw'
  if (name === 'findings') return 'findings'
  if (name === '解压') return 'extracted'
  if (name === '提取') return 'extract'
  return ''
}

/** 文件名 → 语义标记。 */
export function fileMarker(name: string): string {
  if (name === '排除清单.json') return 'excluded'
  if (name === '材料盘点.json') return 'inventory'
  if (name === '媒体索引.json') return 'mediaIndex'
  if (name === '复核盘点.json') return 'reviewInventory'
  if (name === '复核媒体索引.json') return 'reviewMediaIndex'
  if (name === '复核对照.json') return 'reviewCompare'
  if (name === '冻结指纹.json' || name === '冻结快照.json') return 'frozen'
  if (name === 'route_profile.json' || name === 'route_dispatch.json') return 'routeProfile'
  return ''
}

/** 这些目录要数里面的文件数（材料齐不齐）。 */
export const COUNTED: Record<string, boolean> = {
  materials: true, media: true, knowledge: true, review: true, work: true, findings: true, raw: true,
}

/** 交付件命名：`审核意见.<流水号>.html` / `审核结果.<流水号>.json`。 */
export const RESULT_FILE = /^审核结果\..+\.json$/
export const HTML_FILE = /^审核意见\..+\.html$/

/** 从子会话 label「审核 &lt;流水号&gt; · HH:MM:SS」里取流水号。 */
export function seqNoFromLabel(label: unknown): string {
  const match = /^审核\s+(\S+)/.exec(typeof label === 'string' ? label : String(label ?? ''))
  return match?.[1] ?? ''
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 子会话 label：流水号始终是第一个 token，停止/重审都靠它反查。 */
export function auditLabel(seqNo: unknown, when: Date = new Date()): string {
  const clock = `${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}`
  return `审核 ${typeof seqNo === 'string' ? seqNo : String(seqNo ?? '')} · ${clock}`
}

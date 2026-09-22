/**
 * 报告页用到的类型。
 *
 * 线协议类型（`TaskRow` / `AuditView` / `CloudItem`）**定义在 `src/shared/types.ts`**，
 * 这里只做转出，避免两边各写一份声明后各自漂移。其余是本页专有的 UI 类型
 * （徽章、按钮、门禁），它们不上线，所以留在这里。
 */

import type { AuditView, CloudItem, TaskRow } from '../../../shared/types.ts'

export type { AuditView, CloudItem, TaskRow }

export type BadgeTone = 'ok' | 'medium' | 'high' | 'low'

export interface Badge {
  text: string
  tone: BadgeTone
}

/** 一个按钮的**描述**，不是元素：把「显示哪些按钮」的规则与渲染分开，规则才好测。 */
export interface ButtonSpec {
  id: 'start' | 'stop' | 'audit-info' | 'cloud-report' | 'open-html' | 'open-session' | 'retry-upload'
    /** 「审核中」占位：主位、不可点（避免重复触发）。 */
    | 'progress'
    /** 「重新审核」：只在 ••• 里出现。 */
    | 'restart'
  label: string
  tone: 'primary' | 'warn' | 'plain'
  disabled: boolean
  /** 需要二次确认（重新审核）。 */
  confirm?: boolean
  /** 点击时要不要带 retry 语义。 */
  retry?: boolean
}

/** 一行在界面上最终长什么样。 */
export interface RowView {
  key: string
  badges: Badge[]
  buttons: ButtonSpec[]
  /** 次要说明行（启动时间、停止原因、上传错误、门禁提示）。 */
  notes: string[]
}

/** 报告页的门禁与忙碌状态。 */
export interface Gating {
  /** 氚云与钉钉都已认证 —— 没这个不能发起审核。 */
  canDispatch: boolean
  /** 当前没有其它审核占用（单条并发）。 */
  canStart: boolean
  /**
   * 覆盖默认门禁文案。
   *
   * 默认文案是「需先通过钉钉认证」，但 `canDispatch=false` 也可能是别的原因
   * （最典型：宿主插件是旧构建），那时说「先过认证」会把人带偏。
   */
  gateReason?: string
  /** 列表本身在加载。 */
  busy?: boolean
  /** 正在为哪个 key 创建子会话（按钮显示「创建中…」）。 */
  auditBusy?: string
  stopBusy?: boolean
  retryBusy?: boolean
}

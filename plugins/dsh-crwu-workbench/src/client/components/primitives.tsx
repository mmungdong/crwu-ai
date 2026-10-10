import type * as React from 'react'
import { WORKBENCH_CLASSES as C } from '../features/workbench/consts.ts'

/**
 * 展示用小组件。
 *
 * 刻意保持「哑」：只接数据、不接业务规则。业务规则在 features 下那些纯 `.ts` 规则文件里，
 * 所以这里没有可测的逻辑 —— 测规则比测渲染树便宜也稳定得多。
 */

export interface CardProps {
  title: string
  extra?: React.ReactNode
  children?: React.ReactNode
}

export function Card(props: CardProps): React.ReactElement {
  // extra 挂在标题**之后**并用 margin-left:auto 顶到右侧：顺序反过来时
  // `margin-left:auto` 会把留白放在 extra 左边，标题反而被推到最右边。
  return <div className={C.card}>
    <div className={C.cardTitle}>
      <span className={C.cardTitleText}>{props.title}</span>
      {props.extra === undefined ? null : <span className={C.cardExtra}>{props.extra}</span>}
    </div>
    <div className={C.cardBody}>{props.children}</div>
  </div>
}

export interface SectionProps {
  title: string
  count?: string
  extra?: React.ReactNode
  children?: React.ReactNode
}

/** 比 Card 更轻的分区：标题条 + 内容，用来把一页里的多组检查分开。 */
export function Section(props: SectionProps): React.ReactElement {
  return <div className={C.section}>
    <div className={C.sectionHead}>
      <span className={C.sectionTitle}>{props.title}</span>
      {props.extra === undefined ? null : props.extra}
      {props.count === undefined ? null : <span className={C.sectionCount}>{props.count}</span>}
    </div>
    <div className={C.sectionBody}>{props.children}</div>
  </div>
}

export interface BadgeProps {
  text: string
  tone: 'ok' | 'medium' | 'high' | 'low'
}

export function Badge(props: BadgeProps): React.ReactElement {
  const tone = props.tone === 'ok' ? C.badgeOk
    : (props.tone === 'medium' ? C.badgeMedium : (props.tone === 'high' ? C.badgeHigh : C.badgeLow))
  return <span className={`${C.badge} ${tone}`}>{props.text}</span>
}

export type Tone = 'ok' | 'bad' | 'busy' | 'idle'

const DOT_OF: Record<Tone, string> = {
  ok: C.dotOk,
  bad: C.dotBad,
  busy: C.dotBusy,
  idle: C.dotIdle,
}

const CHIP_OF: Record<Tone, string> = {
  ok: C.chipOk,
  bad: C.chipBad,
  busy: C.chipWarn,
  idle: C.chipMuted,
}

/** 状态圆点：绿=通过、红=不通过、黄=自检中、灰=还没结论。 */
export function StatusDot(props: { tone: Tone }): React.ReactElement {
  return <span className={`${C.dot} ${DOT_OF[props.tone]}`} />
}

/** 带文案的状态胶囊（与圆点同一套语义）。 */
export function Chip(props: { text: string; tone: Tone }): React.ReactElement {
  return <span className={`${C.chip} ${CHIP_OF[props.tone]}`}>{props.text}</span>
}

/** 自检进行中的转圈；`large` 用于整页 loading。 */
export function Spinner(props: { large?: boolean }): React.ReactElement {
  return <span className={`${C.spinner} ${props.large === true ? C.spinnerLarge : ''}`} />
}

/** 一行「转圈 + 说明」的内联加载态（列表为空时的占位、抽屉读数据时的占位）。 */
export function Loading(props: { text: string }): React.ReactElement {
  return <div className={C.loadingInline}>
    <Spinner />
    <span>{props.text}</span>
  </div>
}

/**
 * 不确定进度条：`active` 为假时不渲染任何东西（调用方不用自己写条件）。
 *
 * 为什么是「进度条 + 压暗正文」而不是只把按钮改成 `…`：翻页、重新自检都要跑好几秒，
 * 只改按钮文案的话用户看不出「是这次点击没反应，还是在加载」。
 */
export function LoadingBar(props: { active: boolean }): React.ReactElement | null {
  if (props.active !== true) return null
  return <div className={C.loadBar} role="progressbar" aria-busy="true">
    <div className={C.loadBarFill} />
  </div>
}

/** 通过率进度条。`ratio` 会被夹到 0~1，避免外部数据把条画到框外。 */
export function Meter(props: { ratio: number; bad?: boolean }): React.ReactElement {
  const ratio = Number.isFinite(props.ratio) ? Math.min(1, Math.max(0, props.ratio)) : 0
  const fill = props.bad === true ? `${C.meterFill} ${C.meterFillBad}` : C.meterFill
  return <div className={C.meter}>
    <div className={fill} style={{ width: `${Math.round(ratio * 100)}%` }} />
  </div>
}

export interface NoticeProps {
  tone: 'warn' | 'ok'
  /**
   * `alert` = 这条是**失败/阻断**，读屏必须立刻播报；`status` = 一般状态变化。
   *
   * 不默认成 `alert`：Notice 也用于"宿主是旧构建，建议重启"这类**不是错误**的说明，
   * 全部播报会变成噪音。错误调用点显式传 `role="alert"`。
   */
  live?: 'alert' | 'status'
  children?: React.ReactNode
}

export function Notice(props: NoticeProps): React.ReactElement {
  const className = `${C.notice} ${props.tone === 'ok' ? C.noticeOk : C.noticeWarn}`
  // 三个分支写开（不用展开运算符）：JSX 属性类型对联合展开不友好，而这里本来就只有三种形态。
  if (props.live === 'alert') {
    return <div className={className} role="alert" aria-live="assertive">{props.children}</div>
  }
  if (props.live === 'status') {
    return <div className={className} role="status" aria-live="polite">{props.children}</div>
  }
  return <div className={className}>{props.children}</div>
}

export interface ButtonProps {
  label: string
  tone?: 'primary' | 'warn' | 'plain'
  disabled?: boolean
  small?: boolean
  title?: string
  /**
   * 禁用/忙碌的**可读原因**（指向页面上那段可见文字的元素 id）。
   *
   * 只用 `title` 不够：触屏与读屏对 `title` 的支持不稳，而"为什么不能点"必须能被读出来。
   */
  ariaDescribedBy?: string
  /** 异步进行中：设置 `aria-busy` 并锁住点击（避免重复触发）。 */
  busy?: boolean
  onClick?: () => void
}

/** 按 `deriveRowView` 给的 `ButtonSpec` 渲染；`tone` 决定视觉，不影响行为。 */
export function Button(props: ButtonProps): React.ReactElement {
  const tone = props.tone === 'primary' ? C.btnPrimary : (props.tone === 'warn' ? C.btnWarn : '')
  const classes = [C.btn, tone, props.small === true ? C.btnSmall : ''].filter((item) => item !== '').join(' ')
  const described = props.ariaDescribedBy === undefined ? {} : { 'aria-describedby': props.ariaDescribedBy }
  const busy = props.busy === true ? { 'aria-busy': true } : {}
  return <button
    className={classes}
    type="button"
    disabled={props.disabled === true || props.busy === true}
    title={props.title ?? ''}
    {...described}
    {...busy}
    onClick={props.busy === true ? undefined : props.onClick}
  >{props.label}</button>
}

/** 空态提示（列表没有数据时用）。 */
export function Empty(props: { text: string }): React.ReactElement {
  return <div className={C.muted}>{props.text}</div>
}

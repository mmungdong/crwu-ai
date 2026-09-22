import * as React from 'react'
import { BrandMark } from '../../components/BrandMark.tsx'
import { zhCN } from '../../locales/zh-CN.ts'
import { WORKBENCH_CLASSES as C } from './consts.ts'

/**
 * 统一的「正在自检环境」等待页。
 *
 * 为什么要有它（用户 2026-09-22 口径）：「我点到中瑞世联工作台的时候都会进行一轮环境检测，
 * 这个是合理的，但是需要一个统一的 loading 页面，这个需要你设计一下，否则很不统一，
 * 这个注意有个好看的 svg」。
 *
 * 先前第一次进来渲染的是**环境信息页的半成品**（页头 + 各层占位 + 一行灰字），
 * 看起来像"页面缺了一块"；现在整个正文只放这一页：
 *
 * 1. 一枚会依次亮起来的品牌标记（四个色块按顺序呼吸，见样式里的 `crwu-audit-brand-wave`）
 *    —— 用品牌图形当加载符号，比通用转圈更有归属感，也不用额外的图形资产；
 * 2. 一句主文案（正在自检环境）+ 一句说明（通过后会自动进入报告审核）；
 * 3. 底部一条不确定进度条，让"还在动"这件事有连续的视觉证据。
 *
 * 它是**整块正文**的占位（三个模块都被它挡住）：自检没出结论之前，谈"在哪一页"没有意义 ——
 * 结论一到，`modules.autoEnter()` 会把用户送到该去的那一页（通过 → 报告审核，不通过 → 环境信息）。
 *
 * 也复用在右侧讨论面板里（用户 2026-09-22：「crwu 在查询的时候，应该有个中瑞世联的 Loading 页面」）：
 * 那时是**块内**占位（面板那 30% 宽度里），所以文案可以换、尺寸由 `.crwu-audit-ai-scroll`
 * 的后代规则收小 —— 同一枚「中瑞世联在干活」的牌子，不要两套观感。
 */
export function WorkbenchLoading(props: { title?: string; hint?: string; size?: number } = {}): React.ReactElement {
  const size = props.size ?? 76
  // `hint` 显式给空串 = **这一页不要说明行**（例如"正在加载报告…"只需要一行标题）：
  // 留一个空 div 会白白多出 12px 的 flex 间距。
  const hint = props.hint ?? zhCN.loadingHint
  return <div className={C.loadingPane} role="status" aria-live="polite">
    <span className={C.loadingMark} aria-hidden={true}><BrandMark size={size} /></span>
    <div className={C.loadingTitle}>{props.title ?? zhCN.loadingEnv}</div>
    {hint === '' ? null : <div className={C.loadingHint}>{hint}</div>}
    <div className={C.loadBar}><span className={C.loadBarFill} /></div>
  </div>
}

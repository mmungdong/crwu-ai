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
 */
export function WorkbenchLoading(): React.ReactElement {
  return <div className={C.loadingPane} role="status" aria-live="polite">
    <span className={C.loadingMark} aria-hidden={true}><BrandMark size={76} /></span>
    <div className={C.loadingTitle}>{zhCN.loadingEnv}</div>
    <div className={C.loadingHint}>{zhCN.loadingHint}</div>
    <div className={C.loadBar}><span className={C.loadBarFill} /></div>
  </div>
}

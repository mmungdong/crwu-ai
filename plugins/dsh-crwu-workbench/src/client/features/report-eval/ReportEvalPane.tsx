import * as React from 'react'
import { zhCN } from '../../locales/zh-CN.ts'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'

/**
 * 「报告评估」占位页。
 *
 * 这一页还没有功能（后面由用户自己开发），所以整页只写一件事：**开发中**。
 * 用户口径（2026-09-22）：「该页面整体写一个开发中就可以了」「它的页面也重写下，太难看了」——
 * 所以既不堆说明与计划事项（那会让人以为这里已经能用了），也不是"一行灰字飘在空白正中间"：
 * 正文就是一枚有分量的灰色圆角标签，居中。模块名本来就常驻面板头部，正文里不再重复。
 */
export function ReportEvalPane(): React.ReactElement {
  return <div className={C.placeholder}>
    <span className={C.placeholderTag}>{zhCN.moduleDevTag}</span>
  </div>
}

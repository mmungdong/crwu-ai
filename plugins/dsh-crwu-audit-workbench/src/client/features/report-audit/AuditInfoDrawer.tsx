import * as React from 'react'
import { Loading } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 审核信息的内容体。
 *
 * 只展示 Host 返回的**摘要**（`oss-result` 已经把完整证据链剥掉了）。这里不做二次过滤 ——
 * 过滤规则只有一处（Host），前端再筛一遍等于把同一条规则写两份。
 *
 * 文案与顺序照旧动态形态的抽屉走：用户已经习惯那一套字段。
 *
 * 外壳（标题、关闭按钮、右侧定位与 Esc）由 `components/SideDrawer.tsx` 提供，
 * 这里只负责内容 —— 所以它既没有头部也没有自己的关闭按钮。
 */

export interface AuditInfoDrawerProps {
  seqNo: string
  info: Record<string, unknown> | null
  error: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function line(key: string, value: unknown): React.ReactElement | null {
  if (value === undefined || value === null || value === '') return null
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return <React.Fragment key={key}>
    <div className={C.kvKey}>{key}</div>
    <div className={C.kvValue}>{shown}</div>
  </React.Fragment>
}

export function AuditInfoDrawer(props: AuditInfoDrawerProps): React.ReactElement {
  const info = asRecord(props.info)
  const summary = asRecord(info.summary)
  const counts = asRecord(summary.counts)
  const review = asRecord(info.reviewComparison)
  const metrics = asRecord(review.metrics)
  const bands = asRecord(review.bands)

  return <div className={C.drawer}>
    <div className={C.mono}>{props.seqNo}</div>

    {props.error === '' ? null : <div className={C.error}>{props.error}</div>}
    {props.info === null && props.error === '' ? <Loading text={zhCN.loadingAuditInfo} /> : null}

    {props.info === null ? null : <div className={C.kv}>
      {line('项目编号', info.projectId)}
      {line('审核时间', info.auditTime)}
      {line('引擎版本', info.engineVersion)}
      {line('报告版本', info.reportVersion)}
      {line('阶段', info.stage)}
      {line('结论', summary.decision)}
      {line('问题总数', counts.issuesTotal)}
      {line('高', counts.high)}
      {line('中', counts.medium)}
      {line('低', counts.low)}
      {line('待确认', counts.pendingConfirmation)}
      {line('未检查', counts.notChecked)}
      {line('复核状态', review.status)}
      {line('命中率', metrics.aiHitRate)}
      {line('复核计数', bands.overlap === undefined ? undefined : JSON.stringify(bands))}
      {line('生成时间', asRecord(info.fileTrace).generatedAt)}
    </div>}
  </div>
}

import * as React from 'react'
import { Button, Card } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi } from '../report-audit/api.ts'
import type { TaskRow } from '../../../shared/types.ts'

/**
 * 发起审核失败时的**手工兜底**。
 *
 * 为什么需要它：`audit-start` 会失败在很多与用户无关的原因上（父级没登记、子代理 provider
 * 不可用、工作空间没选定……）。这时候光显示一句错误，用户就只能干等；而审核这件事本身
 * 是可以在普通会话里手工做的 —— 所以给出一段**可直接粘贴**的编排提示词，
 * 让流程还能往前走。
 *
 * 文案与 legacy 一致：明确技能名、两阶段流程、以及三个定位字段（ObjectId / SeqNo / 项目名），
 * 其中 ObjectId 缺失时要提示用 SeqNo 精确定位。
 */

export interface HandoffProps {
  task: Pick<TaskRow, 'id' | 'seqNo' | 'name' | 'project'>
  onCopied: (copied: boolean) => void
  copied: boolean
}

/** 手工提示词全文。字段缺失时给出可操作的提示，而不是留空。 */
export function handoffPrompt(task: HandoffProps['task']): string {
  return [
    zhCN.handoffIntro,
    '',
    `- ${zhCN.handoffObjectId}${task.id === '' ? zhCN.handoffObjectIdMissing : task.id}`,
    `- ${zhCN.handoffSeqNo}${task.seqNo === '' ? task.name : task.seqNo}`,
    `- ${zhCN.handoffProject}${task.project === '' ? zhCN.handoffProjectMissing : task.project}`,
  ].join('\n')
}

export function Handoff(props: HandoffProps): React.ReactElement {
  const prompt = handoffPrompt(props.task)
  const copy = (): void => {
    // 浏览器剪贴板不可用时退到 Host 的剪贴板命令（走 stdin，不拼命令行）。
    const fallback = (): void => { void workbenchApi.clipboard({ text: prompt }) }
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard
    if (clipboard?.writeText === undefined) {
      fallback()
      props.onCopied(true)
      return
    }
    clipboard.writeText(prompt)
      .then(() => { props.onCopied(true) })
      .catch(() => { fallback(); props.onCopied(true) })
  }

  return <Card title={zhCN.handoffTitle}>
    <div className={C.muted}>{zhCN.handoffHint}</div>
    <pre className={C.result}>{prompt}</pre>
    <div className={C.row}>
      <Button label={props.copied ? zhCN.copied : zhCN.handoffCopy} small onClick={copy} />
    </div>
  </Card>
}

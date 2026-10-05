import * as React from 'react'
import { Button, Card, Notice } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi } from '../report-audit/api.ts'
import type { TaskRow } from '../../../shared/types.ts'
import { caseDirOf } from '../../../shared/utils/case-dir.ts'

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
 *
 * **权限提醒必须在提示词之前**（2026-09-30 用户口径）：手工兜底跑在**员工自己的会话**里，
 * 那条会话的沙箱边界是它自己的工作目录，而案例目录、报告材料、本机凭据都在边界之外 ——
 * 不把权限切成「完全权限」，粘贴后第一步就会失败。只说一句「打开完全权限」等于没说：
 * 员工不知道这个开关在哪，所以这里把控件名、选项名、确认弹窗的勾选、以及一条命令行的
 * 等价做法逐条写出来（文案在 `locales` 的 `handoffFullAccess*`）。
 */

export interface HandoffProps {
  task: Pick<TaskRow, 'id' | 'seqNo' | 'name' | 'project'>
  onCopied: (copied: boolean) => void
  copied: boolean
  workspacePath?: string
}

/** 手工提示词全文。字段缺失时给出可操作的提示，而不是留空。 */
export function handoffPrompt(task: HandoffProps['task'], workspacePath = ''): string {
  const caseDir = caseDirOf(workspacePath, task.seqNo)
  return [
    zhCN.handoffIntro,
    '',
    `- ${zhCN.handoffObjectId}${task.id === '' ? zhCN.handoffObjectIdMissing : task.id}`,
    `- ${zhCN.handoffSeqNo}${task.seqNo === '' ? task.name : task.seqNo}`,
    `- ${zhCN.handoffProject}${task.project === '' ? zhCN.handoffProjectMissing : task.project}`,
    '',
    '这是普通会话中的手工审核，无需登记为审核子会话。先准备本轮输入快照，再执行技能的完整两阶段审核。',
    ...(caseDir === '' ? [
      '请先在工作台选定工作空间并确认报告流水号，然后重新复制提示词；不要猜案例目录。',
    ] : [
      `本次唯一案例目录：${caseDir}`,
      '若案例目录不存在，只在上述工作空间下创建这个目录；所有材料、脚本与交付件均放在其中，不复用旧审核产物。',
      ...(task.id === '' ? [] : [
        `先调用 crwu_audit_case_bootstrap(${JSON.stringify({ objectId: task.id, seqNo: task.seqNo, caseDir, refresh: true })})。`,
        '成功后只读取它返回的 snapshotPath、attachmentsPath、metadataPath；失败则停止并报告结构化错误。',
      ]),
      '附件按清单通过 crwu_h3yun_file_get 逐件下载，知识清单用 crwu_audit_knowledge_materialize 实时下载。',
      '技能脚本用 crwu_run_python_script；运行时仅由 load_workspace_dependencies 解析，不查找或改用系统 Python。',
      '最终 HTML/JSON 校验通过后，分别调用 crwu_audit_oss_publish、crwu_audit_dingtalk_archive、crwu_audit_dingtalk_notify_self，独立报告各通道交付结果。',
    ]),
  ].join('\n')
}

export function Handoff(props: HandoffProps): React.ReactElement {
  const prompt = handoffPrompt(props.task, props.workspacePath)
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
    {/* 权限提醒排在提示词**之前**：顺序反了，员工会先粘一遍、失败一次，再回头找原因。 */}
    <Notice tone="warn">
      <div><strong>{zhCN.handoffFullAccessTitle}</strong></div>
      {zhCN.handoffFullAccessSteps.map((step) => <div key={step}>{step}</div>)}
      <div className={C.muted}>{zhCN.handoffFullAccessWhy}</div>
      <div className={C.muted}>{zhCN.handoffFullAccessScope}</div>
    </Notice>
    <pre className={C.result}>{prompt}</pre>
    <div className={C.row}>
      <Button label={props.copied ? zhCN.copied : zhCN.handoffCopy} small onClick={copy} />
    </div>
  </Card>
}

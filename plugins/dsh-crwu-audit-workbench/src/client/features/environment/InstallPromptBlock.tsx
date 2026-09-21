import * as React from 'react'
import { Button, Card } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi } from '../report-audit/api.ts'

/**
 * ⑤ 安装提示词。
 *
 * **不嵌入安装文档正文**，复制的是一段「去读清单并按步骤执行」的指令 ——
 * 清单本身托管在 OSS 上，改内容不用改插件。这个设计要保留：
 * 一旦把清单正文复制进插件，清单更新就得发新版插件。
 *
 * 提供**只读文本框**而不只是「复制」按钮：浏览器剪贴板可能被策略拒绝，
 * 那时用户还能在框里全选复制。这是 legacy 的经验，不是多余的 UI。
 *
 * 也把清单地址显示出来，并说明「该对象必须可公开读取」—— 这是最常见的失败原因
 * （agent 拿到 403 而不是清单内容）。
 */

export interface InstallPromptBlockProps {
  prompt: string
  url: string
  busy: boolean
  copied: boolean
  message: string
  onRefresh: () => void
  onCopied: (message: string) => void
}

export function InstallPromptBlock(props: InstallPromptBlockProps): React.ReactElement {
  const copy = (): void => {
    const fallback = (why: string): void => {
      // 退到 Host 的剪贴板命令（走 stdin，不拼命令行），并把「请手动全选复制」告诉用户。
      void workbenchApi.clipboard({ text: props.prompt })
      props.onCopied(`${zhCN.promptCopyManual}${why}`)
    }
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard
    if (clipboard?.writeText === undefined) {
      fallback('')
      return
    }
    clipboard.writeText(props.prompt)
      .then(() => { props.onCopied(zhCN.promptCopied) })
      .catch((cause: unknown) => { fallback(cause instanceof Error ? cause.message : String(cause)) })
  }

  return <Card
    title={zhCN.promptTitle}
    extra={props.url === '' ? null : <span className={C.mono}>{props.url.replace(/^https?:\/\//, '')}</span>}
  >
    <div className={C.muted}>{zhCN.promptIntro}</div>
    {props.busy && props.prompt === ''
      ? <div className={C.muted}>{zhCN.promptGenerating}</div>
      : <>
          <textarea
            className={C.input}
            style={{ width: '100%', minHeight: '120px', marginTop: '8px' }}
            readOnly
            value={props.prompt}
          />
          <div className={C.row} style={{ marginTop: '8px' }}>
            <Button label={props.copied ? zhCN.copied : zhCN.copyPrompt} tone="primary" small onClick={copy} />
            <Button label={zhCN.promptRegenerate} small disabled={props.busy} onClick={props.onRefresh} />
            {props.message === '' ? null : <span className={C.muted}>{props.message}</span>}
          </div>
          <div className={C.muted} style={{ fontSize: '11px' }}>
            {`${zhCN.promptAgentReads}${props.url}。${zhCN.promptMustBePublic}`}
          </div>
        </>}
  </Card>
}

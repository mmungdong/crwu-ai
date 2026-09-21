import * as React from 'react'
import { Card } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 安装提示词（**只读预览**）。
 *
 * 复制入口全页只有一处：环境页 Hero 里那枚「复制安装提示词」（见 `EnvironmentPane.tsx`）。
 * 这里不再放复制/重生成按钮 —— 一排长得一样的按钮正是员工反馈的"乱"。
 *
 * 保留**只读文本框**而不是只给一句"已复制"：浏览器剪贴板可能被策略拒绝，那时用户还能在框里
 * 全选复制（legacy 的经验）。也保留清单地址与「该对象必须可公开读取」的说明 —— 403 是最常见的
 * 失败原因。提示词正文不在插件里，改清单不用发新版插件，这个设计也要留着。
 */
export interface InstallPromptBlockProps {
  prompt: string
  url: string
  busy: boolean
  /** 复制结果或失败原因（由唯一那枚复制按钮产生）；空串 = 不显示。 */
  message: string
}

export function InstallPromptBlock(props: InstallPromptBlockProps): React.ReactElement {
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
          {props.message === '' ? null : <div className={C.muted} style={{ marginTop: '6px' }}>{props.message}</div>}
          <div className={C.muted} style={{ fontSize: '11px' }}>
            {`${zhCN.promptAgentReads}${props.url}。${zhCN.promptMustBePublic}`}
          </div>
        </>}
  </Card>
}

import * as React from 'react'
import { Button } from './primitives.tsx'
import { zhCN } from '../locales/zh-CN.ts'
import { workbenchApi } from '../features/report-audit/api.ts'

/**
 * 复制一小段文本（路径、下载地址、命令）。
 *
 * 先试浏览器剪贴板，被策略拒绝时退到 Host 的 `clipboard` 操作 —— 与安装提示词那一块同一套
 * 兜底逻辑：浏览器剪贴板在非安全上下文/无用户手势时会被拒，而用户此时往往正要拿这段路径
 * 去终端里粘贴，不能只丢一句「复制失败」。
 */

export interface CopyButtonProps {
  text: string
  /** 按钮文案；默认「复制」。 */
  label?: string
  small?: boolean
}

export function CopyButton(props: CopyButtonProps): React.ReactElement {
  const [done, setDone] = React.useState(false)

  const markDone = (): void => {
    setDone(true)
  }

  const copy = (): void => {
    const clipboard = (globalThis as {
      navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } }
    }).navigator?.clipboard
    if (clipboard?.writeText === undefined) {
      void workbenchApi.clipboard({ text: props.text }).then(markDone).catch(markDone)
      return
    }
    clipboard.writeText(props.text).then(markDone).catch(() => {
      void workbenchApi.clipboard({ text: props.text }).then(markDone).catch(markDone)
    })
  }

  return <Button
    label={done ? zhCN.copied : (props.label ?? zhCN.copy)}
    small={props.small !== false}
    disabled={props.text === ''}
    onClick={copy}
  />
}

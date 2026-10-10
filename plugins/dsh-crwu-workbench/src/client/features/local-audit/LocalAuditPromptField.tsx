import * as React from 'react'
import { Card } from '../../components/primitives.tsx'
import { LOCAL_AUDIT_CLASSES as L } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 「补充提示词（可选）」卡片。
 *
 * 三条口径：
 * 1. `label` 真的绑在 textarea 上（`htmlFor` + `id`），不是只有一行看着像标签的文字；
 * 2. 两行说明必须都在：一行说"空着会怎样"（用默认规则），一行说"填了会怎样"
 *    （追加，不覆盖固定约束）—— 用户需要知道自己的话有多大的效力；
 * 3. **保留用户输入的换行**（`white-space: pre-wrap` 由样式保证），不在客户端 trim 或改写。
 */
export interface LocalAuditPromptFieldProps {
  value: string
  onChange: (value: string) => void
  /** 移交进行中时禁掉输入（避免改到一半的提示词与已建快照对不上）。 */
  disabled?: boolean
}

export function LocalAuditPromptField(props: LocalAuditPromptFieldProps): React.ReactElement {
  const id = 'crwu-local-audit-prompt'
  return <Card title={zhCN.localAuditPromptTitle}>
    <div className={L.field}>
      <label className={L.fieldLabel} htmlFor={id}>{zhCN.localAuditPromptLabel}</label>
      <textarea
        id={id}
        className={L.textarea}
        value={props.value}
        rows={5}
        placeholder={zhCN.localAuditPromptPlaceholder}
        disabled={props.disabled === true}
        onChange={(event) => { props.onChange(String((event.target as { value?: unknown }).value ?? '')) }}
      />
      <span className={L.fieldHint}>{zhCN.localAuditPromptHintDefault}</span>
      <span className={L.fieldHint}>{zhCN.localAuditPromptHintAppend}</span>
    </div>
  </Card>
}

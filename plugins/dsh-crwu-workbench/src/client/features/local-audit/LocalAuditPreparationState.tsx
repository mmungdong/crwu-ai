import * as React from 'react'
import { CheckIcon } from '../../components/icons.tsx'
import { LOCAL_AUDIT_CLASSES as L } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { LOCAL_AUDIT_STAGE_KEYS, type LocalAuditStageKey } from './controller.ts'

/**
 * 准备阶段的阶段条（设计 §7）。
 *
 * 五个阶段是**真实步骤**，不是装饰：读取选择范围 → 创建文件快照 → 创建审核对话 →
 * 切换到新对话 → 认领本次审核。三种形状各有含义：
 *   ✓ 已完成 · ● 进行中（转圈）· ○ 未开始
 * 整条用 `aria-live="polite"` 播报，键盘焦点不动也能听到阶段变化。
 *
 * **失败时停在本阶段起点**：假装成功比暂时不显示更糟（用户会以为材料已经交出去了）。
 */

const STAGE_LABEL: Record<LocalAuditStageKey, string> = {
  scope: zhCN.localAuditStageScope,
  snapshot: zhCN.localAuditStageSnapshot,
  conversation: zhCN.localAuditStageConversation,
  switch: zhCN.localAuditStageSwitch,
  claim: zhCN.localAuditStageClaim,
}

export interface LocalAuditPreparationStateProps {
  /** 已完成 / 进行中的阶段数（0..5），来自 `stageIndexOf`。 */
  stageIndex: number
}

export function LocalAuditPreparationState(props: LocalAuditPreparationStateProps): React.ReactElement {
  return <div className={L.stages} role="status" aria-live="polite">
    {LOCAL_AUDIT_STAGE_KEYS.map((key, index) => {
      const state = index < props.stageIndex ? 'done' : (index === props.stageIndex ? 'active' : 'todo')
      const className = state === 'done' ? L.stageDone : (state === 'active' ? L.stageActive : L.stageTodo)
      return <div key={key} className={[L.stage, className].join(' ')}>
        <span className={L.stageMark} aria-hidden={true}>
          {state === 'done'
            ? <CheckIcon size={14} />
            : (state === 'active' ? <span className={L.stageMarkBusy} /> : <span>○</span>)}
        </span>
        <span>{STAGE_LABEL[key]}</span>
      </div>
    })}
  </div>
}

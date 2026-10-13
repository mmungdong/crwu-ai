import * as React from 'react'
import { Button } from '../../../ui/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../../../shell/consts.ts'
import { zhCN } from '../../../locales/zh-CN.ts'
import { workbenchApi } from '../api.ts'
import { CRWU_SCOPE_PROPS } from '../../../styles/scope.ts'

/**
 * 会话头里的「子会话父级」按钮。
 *
 * **这个组件是发起审核的必要条件，不是可选装饰。**
 * `audit-start` 要求 `state.parentSessionId` 已登记，而登记的唯一入口就是这里 ——
 * 只有会话头槽位会把当前会话 id 通过 props 交给插件。少了它，包形态的界面上
 * **没有任何办法开始一次审核**（点了也只会得到「父会话的 Agent 不在运行中」）。
 *
 * 挂载时自动登记一次：用户不需要先找到按钮再点，打开会话就等于登记。这样也避免
 * 「用户以为登记了、其实没点」的状态不一致。
 */

export interface AuditParentButtonProps {
  /** 由会话头槽位注入的当前会话 id。 */
  sessionId?: string
}

export function AuditParentButton(props: AuditParentButtonProps): React.ReactElement | null {
  const sessionId = props.sessionId === undefined ? '' : String(props.sessionId)
  const [state, setState] = React.useState({ bound: false, subagent: false, error: '' })
  // 让「登记」只有一条实现：挂载时与点击时走同一个函数。
  const bind = React.useCallback((alive: () => boolean) => {
    workbenchApi.bindSession({ sessionId })
      .then((result) => {
        if (!alive()) return
        // 无论成败都看 Host 的权威结果：失败（子代理不能当父级）时它会带回**原来那个**
        // 合法的顶层父级，界面要显示出来，否则用户不知道审核到底挂在哪。
        setState({
          bound: result.ok === true,
          subagent: (result as { subagent?: boolean }).subagent === true,
          error: result.ok === true ? '' : String((result as { error?: string }).error ?? zhCN.bindFailed),
        })
      })
      .catch((cause: unknown) => {
        if (!alive()) return
        setState({ bound: false, subagent: false, error: cause instanceof Error ? cause.message : String(cause) })
      })
  }, [sessionId])

  React.useEffect(() => {
    if (sessionId === '') return undefined
    let alive = true
    // 打开会话即登记：用户不必先找到按钮再点，也就不会出现「以为登记了、其实没点」。
    bind(() => alive)
    return () => { alive = false }
  }, [bind, sessionId])

  if (sessionId === '') return null
  const label = state.subagent ? zhCN.bindSubagent : (state.bound ? zhCN.bound : zhCN.bindParent)
  // 会话头按钮是**独立挂载点**（长在宿主会话头里，不在工作台面板内），所以自带插件作用域。
  //
  // 作用域挂在一个**无类名**的外层上，而不是挂在 `.crwu-audit-row` 上：那个类是共享的
  // 行布局类，在面板里大量作为**后代**使用 —— 一旦它自己成了作用域节点，
  // `:where([…]) .crwu-audit-row` 这种后代前缀就在它身上永远不命中（两边只能选一头）。
  // 外层无类名，于是内层照旧是"作用域里的后代"，两种用法同一套规则。
  return <span {...CRWU_SCOPE_PROPS}>
    <span className={C.row}>
      <Button
        label={label}
        tone={state.bound ? 'plain' : 'warn'}
        small
        title={state.error === '' ? zhCN.bindHint : state.error}
        onClick={() => { bind(() => true) }}
      />
      {state.error === '' ? null : <span className={C.muted}>{state.error}</span>}
    </span>
  </span>
}

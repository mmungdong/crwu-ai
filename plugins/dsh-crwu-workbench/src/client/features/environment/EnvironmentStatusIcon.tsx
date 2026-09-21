import * as React from 'react'
import { Spinner, StatusDot } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { envLampOf, useEnvStatus, type EnvLampTone, type EnvSnapshot, type EnvStatusStore } from './status.ts'

/**
 * 环境自检指示灯。
 *
 * 它是「环境到底行不行」这件事**唯一常驻的可见结论**：绿=全部必需项通过，红=不通过，
 * 黄=正在自检。点它进入工作台（面板会照同一份 store 决定进环境自检页还是直接进报告审核）。
 *
 * 两处挂载共用这一个组件与同一个 store：
 * 1. `conversation.session.header.utilities` —— 页面右上角，面板没打开时也看得见；
 * 2. 工作台面板头部 —— 面板自己的右上角，兼作「回到环境自检」的入口。
 */

export interface EnvironmentStatusIconProps {
  store: EnvStatusStore
  /** 浏览器侧的 layout 服务（跳回工作台面板）；缺了就只显示状态。 */
  selectPanel?: (panel: string) => void
  /** 覆盖默认的跳转行为：面板里那颗灯用它切到环境自检视图（面板已经打开了，不需要 selectPanel）。 */
  onOpen?: () => void
  /** 当前正停在环境自检页 —— 面板里那份用它高亮。 */
  active?: boolean
  /** 只画灯不画文字：会话头位置窄，纯图标 + 悬停说明更合适。 */
  compact?: boolean
}

const TEXT_OF: Record<EnvLampTone, string> = {
  ok: zhCN.envLampOk,
  bad: zhCN.envLampBad,
  busy: zhCN.envLampBusy,
  idle: zhCN.envLampIdle,
}

/** 悬停文案：除了结论，把「还差什么」直接写进去（红的时候不用先点开才知道）。 */
export function lampTooltip(snapshot: EnvSnapshot, tone: EnvLampTone): string {
  const head = `${zhCN.envLampLabel}：${TEXT_OF[tone]}`
  const env = snapshot.env
  if (env !== null && env.allOk !== true && env.blocked.length > 0) {
    return `${head}\n${zhCN.envLampMissing}${env.blocked.join('、')}\n${zhCN.envLampHint}`
  }
  if (snapshot.error !== '') return `${head}\n${snapshot.error}\n${zhCN.envLampHint}`
  return `${head}\n${zhCN.envLampHint}`
}

export function EnvironmentStatusIcon(props: EnvironmentStatusIconProps): React.ReactElement {
  const snapshot = useEnvStatus(props.store)
  const tone = envLampOf(snapshot)

  React.useEffect(() => {
    // 只在「还没有任何结论」时自动自检。这个图标挂在每个会话的头部，不能每次开一个会话
    // 就跑一遍全量探测（要跑 shell、问氚云/钉钉、列一次 OSS）；进面板时外壳会主动刷新。
    const current = props.store.get()
    if (current.env === null && !current.busy) void props.store.refresh()
    return undefined
  }, [props.store])

  const onClick = (): void => {
    if (props.onOpen !== undefined) {
      props.onOpen()
      return
    }
    if (props.selectPanel !== undefined) props.selectPanel('crwu-workbench')
  }

  return <button
    type="button"
    className={[C.lampButton, props.active === true ? C.lampButtonOn : ''].filter((item) => item !== '').join(' ')}
    title={lampTooltip(snapshot, tone)}
    aria-label={zhCN.envLampLabel}
    onClick={onClick}
  >
    {tone === 'busy' ? <Spinner /> : <StatusDot tone={tone} />}
    {props.compact === true ? null : <span className={C.lampText}>{`${zhCN.envLampLabel}·${TEXT_OF[tone]}`}</span>}
  </button>
}

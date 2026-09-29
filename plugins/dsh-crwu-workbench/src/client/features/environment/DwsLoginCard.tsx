import * as React from 'react'
import { Button, Notice } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import type { DwsLoginSnapshotView } from '../report-audit/api.ts'

/**
 * 钉钉登录卡片（协议 21）：两阶段。
 *
 * 为什么不是一颗「点了就等 5 分钟」的按钮：`dws auth login` 默认是 OAuth loopback ——
 * 它先在 127.0.0.1 监听、**打印授权 URL**，然后等人完成授权。旧接口同步等它结束，
 * 于是 URL 到界面时用户早就不在等（CLI 那边也超时了）。现在：
 *
 *   start（立刻回快照）→ 界面把 URL / 设备码摆出来 → status 轮询到终态。
 *
 * 三条边界：
 * 1. **只显示 Host 给的事实**：`url` / `userCode` 是 Host 从 CLI 输出里解析的，
 *    `tail` 是 CLI 原文；卡片不自己重排、不猜状态；
 * 2. **不接触凭据**：这里出现的一切都已经是"给人看"的东西（授权 URL / 设备码）；
 *    登录成功的凭据由 `dws` 自己写 `~/.dws` 与 OS 凭据存储；
 * 3. **进入终态就停止轮询**，并把成功结果交给 `onDone`（刷新环境结论）。
 */
export interface DwsLoginCardProps {
  /** 能不能发起（同授权与协议门禁）。 */
  enabled: boolean
  onStart: (args: { device: boolean }) => Promise<DwsLoginSnapshotView>
  onStatus: () => Promise<DwsLoginSnapshotView | null>
  /** 打开授权链接（宿主侧 `window.open` → 系统默认浏览器）。 */
  onOpenUrl: (url: string) => void
  /** 复制文本（授权链接 / 设备码）；缺省时隐藏复制按钮。 */
  onCopy?: (text: string) => void
  /** 进入 `ok` 之后刷新环境结论。 */
  onDone?: () => void
  /** 轮询间隔（测试注入小值）。 */
  pollMs?: number
}

/** 阶段 → 文案。 */
export function dwsPhaseText(phase: DwsLoginSnapshotView['phase']): string {
  switch (phase) {
    case 'running': return zhCN.dwsPhaseRunning
    case 'ok': return zhCN.dwsPhaseOk
    case 'timeout': return zhCN.dwsPhaseTimeout
    case 'failed': return zhCN.dwsPhaseFailed
    default: return ''
  }
}

export function DwsLoginCard(props: DwsLoginCardProps): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<DwsLoginSnapshotView | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  /** 一次登录只通知一次刷新：轮询与状态更新都可能重复看到终态。 */
  const notified = React.useRef(false)

  const start = (device: boolean): void => {
    if (busy) return
    setBusy(true)
    setMessage('')
    notified.current = false
    void props.onStart({ device })
      .then((next) => { setSnapshot(next) })
      .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setBusy(false) })
  }

  // 只在 running 时轮询；进入终态（或还没开始）就把定时器收掉。
  const phase = snapshot?.phase ?? ''
  React.useEffect(() => {
    if (phase !== 'running') return undefined
    const timer = setInterval(() => {
      void props.onStatus().then((next) => {
        if (next === null) return
        setSnapshot(next)
        if (next.phase === 'ok' && notified.current === false) {
          notified.current = true
          props.onDone?.()
        }
      }).catch(() => undefined)
    }, props.pollMs ?? 2_000)
    return () => { clearInterval(timer) }
  }, [phase, props.pollMs])

  const running = phase === 'running'
  const url = snapshot?.url ?? ''
  const userCode = snapshot?.userCode ?? ''
  return (
    <div className={C.stack}>
      <div className={C.row}>
        <Button label={zhCN.dwsLoginStart} small disabled={!props.enabled || busy || running} onClick={() => { start(false) }} />
        {/* 设备码：SSH / 无头环境那条路。它同样要抢 `~/.dws` 的锁，所以不是"浏览器打不开"的退路。 */}
        <Button label={zhCN.dwsLoginStartDevice} small disabled={!props.enabled || busy || running} onClick={() => { start(true) }} />
        {snapshot === null ? <span className={C.muted}>{zhCN.dwsLoginIdle}</span> : <span className={C.muted}>{dwsPhaseText(snapshot.phase)}</span>}
      </div>

      {/* 授权链接：**先给动作，再给原文** —— 用户要的是点一下就打开，而不是抄一段 URL。 */}
      {url === ''
        ? null
        : <div className={C.row}>
            <span className={C.mono}>{url}</span>
            <Button label={zhCN.dwsLoginOpen} small onClick={() => { props.onOpenUrl(url) }} />
            {props.onCopy === undefined ? null : <Button label={zhCN.dwsLoginCopyLink} small onClick={() => { props.onCopy?.(url) }} />}
          </div>}
      {userCode === ''
        ? null
        : <div className={C.row}>
            <span className={C.muted}>{zhCN.dwsLoginUserCode}</span>
            <span className={C.mono}>{userCode}</span>
            {props.onCopy === undefined ? null : <Button label={zhCN.dwsLoginCopyCode} small onClick={() => { props.onCopy?.(userCode) }} />}
          </div>}

      {message === '' ? null : <Notice tone="warn">{message}</Notice>}
      {snapshot !== null && snapshot.error !== '' ? <Notice tone="warn">{snapshot.error}</Notice> : null}
      {snapshot?.advice !== undefined && snapshot.advice !== '' ? <div className={C.muted}>{snapshot.advice}</div> : null}
      {/* CLI 原文仍是最终的真相来源（结构化字段只是"尽力解析"）。 */}
      {snapshot !== null && snapshot.tail !== ''
        ? <div className={C.muted} style={{ whiteSpace: 'pre-wrap' }}>{snapshot.tail}</div>
        : null}
    </div>
  )
}

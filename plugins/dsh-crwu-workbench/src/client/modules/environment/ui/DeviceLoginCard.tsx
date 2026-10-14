import type { DeviceLoginCardView } from '../model/device-login.ts'
import { zhCN } from '../../../locales/zh-CN.ts'
import { Button } from '../../../ui/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../../../shell/consts.ts'

/**
 * 「设备流登录」卡片（协议 32）。
 *
 * ## 为什么是纯渲染器
 *
 * 它**没有** useState / useEffect：轮询、终态判定、"只通知一次"全在
 * `device-login.ts` 的纯 store 里。本仓的 React 替身只实现渲染（不跑 effect、不因 setState
 * 重渲染），逻辑留在组件里就等于没有测试。
 *
 * ## 为什么自动开页只是"尽力而为"
 *
 * 自动调用发生在一次 `await` 之后，**不是用户手势**，浏览器可能直接弹窗拦截。所以可靠路径是
 * 那颗「打开授权页面」按钮（真手势）；被拦不算失败，链接与授权码都摆在面板上可复制 ——
 * 这恰好就是无头场景要走的路。
 */
export interface DeviceLoginCardProps {
  view: DeviceLoginCardView
  /** 有一次请求在飞（设备流自己，或 loopback 那条路）。 */
  busy: boolean
  onStart: () => void
  /** 「改用设备流登录」：先取消正在跑的 loopback，再起设备流。 */
  onSwitch: () => void
  onCancel: () => void
  onOpen: () => void
  onCopy: (text: string) => void
}

export function DeviceLoginCard(props: DeviceLoginCardProps): React.ReactElement {
  const view = props.view
  const running = view.phase === 'running'
  return <div className={C.item} data-crwu-device-login="1" data-crwu-device-login-phase={view.phase}>
    <div className={C.layerActions}>
      {/* 一颗主动作：等待中它让位给「取消」，其余状态都可以再起一次。 */}
      {running
        ? <Button label={zhCN.deviceLoginCancel} small disabled={props.busy} onClick={props.onCancel} />
        : <Button
            // loopback 在跑时这颗按钮变成「改用设备流登录」：先取消它再起设备流。
            // 只置灰的话，员工点了「登录钉钉」之后最长 5 分钟没有任何出路。
            label={view.canSwitch
              ? zhCN.deviceLoginSwitch
              : (view.canRetry ? zhCN.deviceLoginRetry : zhCN.deviceLoginStart)}
            small
            disabled={!view.canStart && !view.canSwitch}
            onClick={view.canSwitch ? props.onSwitch : props.onStart}
          />}
    </div>
    {running
      ? <div data-crwu-device-login-waiting="1">
        <div className={C.itemFix}>
          {view.remaining === ''
            ? zhCN.deviceLoginWaiting
            : `${zhCN.deviceLoginWaiting}…（${zhCN.deviceLoginRemaining} ${view.remaining}）`}
        </div>
        {view.code === ''
          ? null
          : <div className={C.itemHead}>
            <span className={C.itemName}>{zhCN.deviceLoginCodeLabel}</span>
            {/* 授权码要一个字符一个字符地念，所以等宽 + 拉开字距。 */}
            <span className={C.mono} style={{ fontSize: '18px', letterSpacing: '0.18em' }} data-crwu-device-login-code="1">
              {view.code}
            </span>
            <Button label={zhCN.deviceLoginCopyCode} small onClick={() => { props.onCopy(view.code) }} />
          </div>}
        {view.openFailed
          ? <div className={C.itemFix} data-crwu-device-login-open-failed="1">{zhCN.deviceLoginOpenFailed}</div>
          : null}
        {view.link === ''
          ? null
          : <div className={C.itemHead}>
            <span className={C.itemName}>{zhCN.deviceLoginLinkLabel}</span>
            <span className={C.mono} style={{ wordBreak: 'break-all' }} data-crwu-device-login-link="1">{view.link}</span>
            <Button label={zhCN.deviceLoginOpen} small onClick={props.onOpen} />
            <Button label={zhCN.deviceLoginCopyLink} small onClick={() => { props.onCopy(view.link) }} />
          </div>}
        {/* dws 还会给一条要手动输入授权码的链接：完整链接打不开时它是退路。 */}
        {view.linkManual === ''
          ? null
          : <div className={C.itemHead}>
            <span className={C.itemName}>{zhCN.deviceLoginLinkManualLabel}</span>
            <span className={C.mono} style={{ wordBreak: 'break-all' }} data-crwu-device-login-link-manual="1">
              {view.linkManual}
            </span>
            <Button label={zhCN.deviceLoginCopyLink} small onClick={() => { props.onCopy(view.linkManual) }} />
          </div>}
      </div>
      : null}
    {view.phase === 'ok'
      ? <div className={C.itemFix} data-crwu-device-login-ok="1">{zhCN.deviceLoginOk}</div>
      : null}
    {view.phase === 'timeout'
      ? <div className={C.itemFix} data-crwu-device-login-timeout="1">{zhCN.deviceLoginTimeout}</div>
      : null}
    {view.detail === ''
      ? null
      : <div className={C.itemFix} style={{ whiteSpace: 'pre-wrap' }} data-crwu-device-login-detail="1">{view.detail}</div>}
  </div>
}

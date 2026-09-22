import * as React from 'react'
import { WORKBENCH_CLASSES as C } from '../features/workbench/consts.ts'
import { zhCN } from '../locales/zh-CN.ts'

/**
 * 右侧抽屉。
 *
 * 用途是「不离开当前列表就能看明细」：审核信息这类内容原来挤在页面最下面，
 * 用户点了按钮还得往下翻，列表位置也丢了。
 *
 * 四条实现约束：
 * 1. **固定定位贴视口右侧**，不用 ReactDOM.createPortal —— 本仓不引 react-dom，
 *    而 `position: fixed` 本身就不受面板滚动容器（`overflow:auto`）影响，
 *    祖先里只要没有 transform / filter 就不会被拽偏（DSH 的主内容列没有）。
 * 2. 副作用都要可释放：Esc 监听挂在 effect 里，卸载时摘掉。
 * 3. 头部是**标题 + 一行等宽流水号 + ×**（用户 2026-09-23 口径：标题下面放流水号，
 *    正文不再重复；「关闭」文字按钮删除，改成 32×32 的标准 Icon Button）。
 * 4. 关闭动画：本组件只负责"正在关闭"时的类，**卸载由调用的父层延迟 150ms 决定**
 *    （见 `WorkbenchPanel.closeDrawer`）—— 这样 `onClose` 依旧立刻回调，行为不变。
 */

export interface SideDrawerProps {
  title: string
  /** 标题下面的辅助行（审核信息里是流水号）。空串不渲染。 */
  subtitle?: string
  /** 正在播关闭动画：加 `-out` 类并关掉指针事件，父层随后卸载。 */
  closing?: boolean
  onClose: () => void
  children?: React.ReactNode
}

type KeydownTarget = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
}

function classes(...all: Array<string | false | undefined>): string {
  return all.filter((one): one is string => typeof one === 'string' && one !== '').join(' ')
}

export function SideDrawer(props: SideDrawerProps): React.ReactElement {
  const { onClose } = props

  React.useEffect(() => {
    const doc = (globalThis as { document?: KeydownTarget }).document
    if (doc?.addEventListener === undefined) return undefined
    const onKeyDown = (event: unknown): void => {
      // Esc 关闭：抽屉盖住了列表，键盘用户不该只能去点关闭按钮。
      if ((event as { key?: unknown } | null)?.key === 'Escape') onClose()
    }
    doc.addEventListener('keydown', onKeyDown)
    return () => { doc.removeEventListener?.('keydown', onKeyDown) }
  }, [onClose])

  return <>
    {/* 遮罩点一下也关：和系统里其它抽屉一致，不额外要一次确认。 */}
    <div
      className={classes(C.sideDrawerBackdrop, props.closing === true && C.sideDrawerBackdropOut)}
      onClick={onClose}
    />
    <aside
      className={classes(C.sideDrawer, props.closing === true && C.sideDrawerOut)}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
    >
      <div className={C.sideDrawerHead}>
        <div className={C.sideDrawerTitle}>
          <span>{props.title}</span>
          {props.subtitle === undefined || props.subtitle === ''
            ? null
            : <span className={C.sideDrawerSub} title={props.subtitle}>{props.subtitle}</span>}
        </div>
        <button
          type="button"
          className={C.sideDrawerClose}
          aria-label={zhCN.closeDrawer}
          title={zhCN.closeDrawer}
          onClick={onClose}
        >×</button>
      </div>
      <div className={C.sideDrawerBody}>{props.children}</div>
    </aside>
  </>
}

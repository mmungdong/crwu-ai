import * as React from 'react'
import { Button } from './primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../features/workbench/consts.ts'
import { zhCN } from '../locales/zh-CN.ts'

/**
 * 右侧抽屉。
 *
 * 用途是「不离开当前列表就能看明细」：审核信息这类内容原来挤在页面最下面，
 * 用户点了按钮还得往下翻，列表位置也丢了。
 *
 * 两条实现约束：
 * 1. **固定定位贴视口右侧**，不用 ReactDOM.createPortal —— 本仓不引 react-dom，
 *    而 `position: fixed` 本身就不受面板滚动容器（`overflow:auto`）影响，
 *    祖先里只要没有 transform / filter 就不会被拽偏（DSH 的主内容列没有）。
 * 2. 副作用都要可释放：Esc 监听挂在 `ctx` 之外，用 effect 的返回值在卸载时摘掉。
 */

export interface SideDrawerProps {
  title: string
  onClose: () => void
  children?: React.ReactNode
}

type KeydownTarget = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
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
    <div className={C.sideDrawerBackdrop} onClick={onClose} />
    <aside className={C.sideDrawer} role="dialog" aria-modal="true" aria-label={props.title}>
      <div className={C.sideDrawerHead}>
        <span className={C.sideDrawerTitle}>{props.title}</span>
        <Button label={zhCN.closeDrawer} small onClick={onClose} />
      </div>
      <div className={C.sideDrawerBody}>{props.children}</div>
    </aside>
  </>
}

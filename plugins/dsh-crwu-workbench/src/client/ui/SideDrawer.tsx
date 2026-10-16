import * as React from 'react'
import { WORKBENCH_CLASSES as C } from '../shell/consts.ts'
import { zhCN } from '../locales/zh-CN.ts'
import { CRWU_SCOPE_PROPS } from '../styles/scope.ts'
import { IconButton } from './components/index.ts'
import { CloseIcon } from './icons.tsx'

/**
 * 右侧抽屉。
 *
 * 用途是「不离开当前列表就能看明细」：审核信息这类内容原来挤在页面最下面，
 * 用户点了按钮还得往下翻，列表位置也丢了。
 *
 * ## 五条实现约束
 *
 * 1. **固定定位贴视口右侧**，不用 ReactDOM.createPortal —— 本仓不引 react-dom，
 *    而 `position: fixed` 本身就不受面板滚动容器（`overflow:auto`）影响。
 * 2. 副作用都要可释放：Esc 监听、焦点陷阱、背景 `inert` 都在 effect 里装上、卸载时摘掉。
 * 3. 头部是**标题 + 一行等宽流水号 + ×**。
 * 4. 关闭动画：本组件只负责"正在关闭"时的类，**卸载由调用的父层延迟 150ms 决定**。
 * 5. **`footer` 是可选的**（协议 35）：只有底部确实有主操作的抽屉才给。
 *    没有 footer 时渲染结果与以前逐字相同 —— 报告审核那张抽屉因此完全不受影响。
 *
 * ## 焦点行为（协议 35 补齐）
 *
 * - 打开时焦点进入抽屉的**第一个可聚焦元素**（没有可聚焦元素时落在抽屉本体上）；
 * - Tab / Shift+Tab 限定在抽屉内循环（背景已经被 `inert`，键盘与读屏都进不去）；
 * - Esc / 遮罩 / × 都等于"关闭"（调用方自己决定是"返回修改"还是"忽略"）；
 * - **关闭后把焦点还给调用方指定的元素**（`returnFocusTo`）—— 估值页传的是「确认」那颗按钮。
 *
 * 这些行为都要碰真实 DOM：单测用的是注入式替身（没有 document），所以每一步都用
 * 可选链兜底 —— 没有 DOM 时静默跳过，而不是抛错把页面打崩。
 */

export interface SideDrawerProps {
  title: string
  /** 标题下面的辅助行（审核信息里是流水号）。空串不渲染。 */
  subtitle?: string
  /** 标题下面的一行说明（`aria-describedby` 指它；长清单**不**整段当描述）。 */
  description?: string
  /** 正在播关闭动画：加 `-out` 类并关掉指针事件，父层随后卸载。 */
  closing?: boolean
  /**
   * 禁止关闭（协议 37）。
   *
   * 创建会话期间 X / Escape / 遮罩三条关闭路径必须一起失效：只禁用一颗按钮的话，
   * 键盘或误点遮罩仍能把员工从"正在创建"里拽出来。**默认 `false`** ——
   * 报告审核那张抽屉与授权弹框的行为逐字不变。
   */
  closeDisabled?: boolean
  /**
   * 打开时焦点落在哪里（协议 37）。
   *
   * `'heading'` 让员工先**核对内容**（估值确认抽屉用它：默认把焦点放到「开始估值」上
   * 等于催他点）；缺省沿用旧行为（第一个可聚焦元素）。报告审核抽屉不传这个参数。
   */
  initialFocus?: 'heading' | 'first'
  /**
   * 额外的 `data-*` 属性（原样挂到抽屉本体上）。
   *
   * 用途是给**调用方**一个稳定的测试锚点，而不是让每个业务去猜 class 组合。
   * 只允许 `data-` 前缀：这是标记，不是行为入口。
   */
  dataAttributes?: Record<string, string>
  /**
   * 固定 footer（可选）。底部有主操作的抽屉把按钮放这里 ——
   * 资料很多时它不会被滚出视口（滚动区是 `body`）。
   */
  footer?: React.ReactNode
  /** 关闭后焦点回到哪个元素（缺省不动焦点）。 */
  returnFocusTo?: { current: { focus?: () => void } | null } | null
  onClose: () => void
  children?: React.ReactNode
}

type ListenerTarget = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
}

type AnyElement = {
  focus?: () => void
  querySelectorAll?: (selector: string) => ArrayLike<unknown>
  parentElement?: { children?: ArrayLike<unknown> } | null
  setAttribute?: (name: string, value: string) => void
  removeAttribute?: (name: string) => void
  hasAttribute?: (name: string) => boolean
}

/** 抽屉里可聚焦的东西（顺序即 Tab 顺序）。 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function classes(...all: Array<string | false | undefined>): string {
  return all.filter((one): one is string => typeof one === 'string' && one !== '').join(' ')
}

interface SiblingMemo {
  node: AnyElement
  inert: boolean
  hidden: boolean
}

/** 还原背景兄弟节点上被我们改过的两个属性。 */
function restoreSiblings(siblings: readonly SiblingMemo[]): void {
  for (const item of siblings) {
    try {
      if (!item.inert) item.node.removeAttribute?.('inert')
      if (!item.hidden) item.node.removeAttribute?.('aria-hidden')
    } catch (error) { void error }
  }
}

export function SideDrawer(props: SideDrawerProps): React.ReactElement {
  const { onClose } = props
  const closeDisabled = props.closeDisabled === true
  const panelRef = React.useRef<AnyElement | null>(null)
  const headRef = React.useRef<AnyElement | null>(null)
  /**
   * `closeDisabled` 必须**当场**读最新值。
   *
   * effect 的依赖是 `[onClose, returnFocusTo]`：创建开始的那一刻若只更新了 prop 而没有
   * 重新装监听，旧闭包会一直允许 Escape 关闭（用户看到"禁用"其实没禁用）。
   */
  const closeGate = React.useRef({ closeDisabled, onClose })
  closeGate.current = { closeDisabled, onClose }

  React.useEffect(() => {
    const doc = (globalThis as {
      document?: ListenerTarget & { activeElement?: unknown }
    }).document
    const panel = panelRef.current

    // ① 背景 inert：抽屉之外的**同级兄弟**（面板正文）不可聚焦、读屏也不再读它们。
    //    只动同级兄弟，不碰宿主页面结构；卸载时逐条还原（原本就有的属性保持不变）。
    const siblings: SiblingMemo[] = []
    const parent = panel?.parentElement
    if (panel !== null && panel !== undefined && parent?.children !== undefined && parent.children !== null) {
      const list = parent.children
      for (let index = 0; index < list.length; index += 1) {
        const node = list[index] as AnyElement | null
        if (node === null || node === undefined || node === panel) continue
        const memo: SiblingMemo = {
          node,
          inert: node.hasAttribute?.('inert') === true,
          hidden: node.hasAttribute?.('aria-hidden') === true,
        }
        siblings.push(memo)
        try {
          node.setAttribute?.('inert', '')
          node.setAttribute?.('aria-hidden', 'true')
        } catch (error) { void error }
      }
    }

    // ② 打开时焦点进入抽屉（默认第一个可聚焦元素；估值页先给标题 —— 请先核对内容）。
    //    ⚠️ 创建期间可聚焦项会**变少**（主按钮 disabled、返回修改不可用），所以每次 Tab
    //    都重新查一遍，不缓存打开瞬间的那一份（设计稿 §10.5）。
    const focusablesNow = (): AnyElement[] => {
      const out: AnyElement[] = []
      try {
        const found = panel?.querySelectorAll?.(FOCUSABLE)
        if (found !== undefined) {
          for (let index = 0; index < found.length; index += 1) out.push(found[index] as AnyElement)
        }
      } catch (error) { void error }
      return out
    }
    try {
      if (props.initialFocus === 'heading') headRef.current?.focus?.()
      else {
        const found = focusablesNow()
        if (found.length > 0) found[0].focus?.()
        else panel?.focus?.()
      }
    } catch (error) { void error }

    if (doc?.addEventListener === undefined) {
      return () => { restoreSiblings(siblings) }
    }

    const onKeyDown = (event: unknown): void => {
      const key = (event as { key?: unknown } | null)?.key
      // Esc 关闭：抽屉盖住了列表，键盘用户不该只能去点关闭按钮。
      // 创建期间这条路**必须**一起关掉（不只是把 × 画灰）。
      if (key === 'Escape') {
        if (!closeGate.current.closeDisabled) closeGate.current.onClose()
        return
      }
      if (key !== 'Tab') return
      // ③ Tab / Shift+Tab 限定在抽屉内循环（每次按键取**当前**可聚焦项）。
      const list = focusablesNow()
      const first = list[0]
      const last = list[list.length - 1]
      if (first === undefined || last === undefined) return
      const active = doc.activeElement
      const shift = (event as { shiftKey?: unknown } | null)?.shiftKey === true
      const prevent = (): void => {
        try { (event as { preventDefault?: () => void } | null)?.preventDefault?.() } catch (error) { void error }
      }
      if (shift && active === first) { prevent(); last.focus?.(); return }
      if (!shift && active === last) { prevent(); first.focus?.(); return }
      // 焦点跑到抽屉之外（理论上被 inert 挡住了）：拉回第一个。
      if (active !== undefined && list.every((node) => node !== active)) { prevent(); first.focus?.() }
    }
    doc.addEventListener('keydown', onKeyDown)

    return () => {
      doc.removeEventListener?.('keydown', onKeyDown)
      restoreSiblings(siblings)
      // ④ 关闭后把焦点还给调用方指定的元素（估值页 = 「确认」）。
      try { props.returnFocusTo?.current?.focus?.() } catch (error) { void error }
    }
    // `props.initialFocus` 只在挂载时读一次：中途改它不该把焦点从员工手里抢走。
  }, [onClose, props.returnFocusTo, props.initialFocus])

  return <>
    {/* 遮罩点一下也关：和系统里其它抽屉一致，不额外要一次确认。
        创建期间连遮罩点击也失效 —— 否则"禁止关闭"只是画了个灰 ×。 */}
    <div
      {...CRWU_SCOPE_PROPS}
      className={classes(C.sideDrawerBackdrop, props.closing === true && C.sideDrawerBackdropOut)}
      onClick={closeDisabled ? undefined : onClose}
    />
    {/* 浮层自带插件作用域：它 `position: fixed` 贴着视口。 */}
    <aside
      {...CRWU_SCOPE_PROPS}
      {...(props.dataAttributes ?? {})}
      {...(props.description === undefined || props.description === ''
        ? {}
        : { 'aria-describedby': `${C.sideDrawer}-desc` })}
      ref={panelRef as unknown as React.Ref<HTMLElement>}
      className={classes(C.sideDrawer, props.closing === true && C.sideDrawerOut)}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      tabIndex={-1}
    >
      <div className={C.sideDrawerHead}>
        <div className={C.sideDrawerTitle}>
          {/* 标题可聚焦（`tabindex=-1`）：`initialFocus='heading'` 要用它。 */}
          <span ref={headRef as unknown as React.Ref<HTMLSpanElement>} tabIndex={-1}>{props.title}</span>
          {props.subtitle === undefined || props.subtitle === ''
            ? null
            : <span className={C.sideDrawerSub} title={props.subtitle}>{props.subtitle}</span>}
        </div>
        <IconButton
          className={C.sideDrawerClose}
          label={zhCN.closeDrawer}
          variant="text"
          disabled={closeDisabled}
          onClick={onClose}
        ><CloseIcon size={16} /></IconButton>
      </div>
      {props.description === undefined || props.description === ''
        ? null
        : <p className={C.sideDrawerDesc} id={`${C.sideDrawer}-desc`}>{props.description}</p>}
      <div className={C.sideDrawerBody}>{props.children}</div>
      {/* footer 缺省不渲染：没有主操作的抽屉（审核信息）与以前逐字相同。 */}
      {props.footer === undefined || props.footer === null
        ? null
        : <div className={C.sideDrawerFoot}>{props.footer}</div>}
    </aside>
  </>
}

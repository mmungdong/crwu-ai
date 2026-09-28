/**
 * 更新面板的开关状态（实例级共享，不是模块级单例）。
 *
 * 为什么需要它：侧栏那枚版本徽标也要能打开更新面板（用户口径「可以只让版本小徽标本身成为
 * 更新入口」），而侧栏入口与主面板是两个组件 —— 开关必须挂在 `apply()` 创建、随 props
 * 下发的**同一份**状态上。各自 `useState` 的话，侧栏点开、面板不知道，或者反过来。
 *
 * 它只表达"面板开着没有"，不掺任何更新业务状态（那些在 `update-store.ts` 里）。
 * 这个文件**不导入 React**：hook 在 `react.ts`（订阅适配）里，便于纯状态被单测直接驱动。
 */

export interface UpdateDialogSnapshot {
  open: boolean
}

export interface UpdateDialogStore {
  get(): UpdateDialogSnapshot
  open(): void
  close(): void
  subscribe(listener: () => void): () => void
  /** 随插件生命周期释放（清掉监听器）。 */
  dispose(): void
}

export function createUpdateDialogStore(): UpdateDialogStore {
  let snapshot: UpdateDialogSnapshot = { open: false }
  const listeners = new Set<() => void>()

  const set = (open: boolean): void => {
    if (snapshot.open === open) return
    snapshot = { open }
    // 复制一份再遍历：监听器里可能解除订阅（React 重渲染就是这样）。
    for (const listener of [...listeners]) listener()
  }

  return {
    get: () => snapshot,
    open: () => { set(true) },
    close: () => { set(false) },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() { listeners.clear() },
  }
}

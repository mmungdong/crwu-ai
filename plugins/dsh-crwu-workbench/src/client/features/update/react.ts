import * as React from 'react'
import type { UpdateSnapshot, UpdateStore } from './update-store.ts'
import type { UpdateDialogSnapshot, UpdateDialogStore } from './dialog-store.ts'

/**
 * 更新 Feature 的 React 订阅适配层。
 *
 * 两个纯状态（`update-store.ts` 的更新状态、`dialog-store.ts` 的开关状态）都不认识 React；
 * 组件只通过这里的 hook 读它们。写法与 `useBuild` / `useEnvStatus` / `useModule` 一致
 * （本仓不引 react-dom，测试用的是替身 React，所以只允许 useState + useEffect 这一套）。
 *
 * 两个 hook 都接受**缺省**：面板在单测里可以不注入任何 store 直接渲染。
 */

/** 订阅更新状态（缺省 = 一份空快照：界面按"还没检查过"显示）。 */
export function useUpdateStore(store?: UpdateStore): UpdateSnapshot {
  const [snapshot, setSnapshot] = React.useState<UpdateSnapshot | null>(store?.get() ?? null)
  React.useEffect(() => {
    if (store === undefined) return undefined
    setSnapshot(store.get())
    return store.subscribe(() => { setSnapshot(store.get()) })
  }, [store])
  return snapshot ?? EMPTY
}

/** 订阅更新面板的开关状态（缺省 = 不显示）。 */
export function useUpdateDialog(store?: UpdateDialogStore): UpdateDialogSnapshot {
  const [snapshot, setSnapshot] = React.useState<UpdateDialogSnapshot>(store?.get() ?? CLOSED)
  React.useEffect(() => {
    if (store === undefined) return undefined
    setSnapshot(store.get())
    return store.subscribe(() => { setSnapshot(store.get()) })
  }, [store])
  return snapshot
}

const CLOSED: UpdateDialogSnapshot = { open: false }

/** 没有 store 时的空状态：与 `update-store.ts` 的初始快照同形。 */
const EMPTY: UpdateSnapshot = {
  initialized: false,
  check: null,
  install: null,
  installCurrent: false,
  checkOrigin: null,
  checking: false,
  installing: false,
  cancelling: false,
  error: null,
}

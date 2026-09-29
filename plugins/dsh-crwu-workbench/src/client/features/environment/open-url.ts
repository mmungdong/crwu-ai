import type { ClientServices } from '../workbench/services.ts'

/**
 * 打开一个外链时，**优先用 DSH 内置浏览器**（右侧栏的 `browser` 标签），拿不到才退回系统浏览器。
 *
 * 为什么要有这一层：`window.open` 在桌面端会被 Electron 主进程转成 `shell.openExternal`
 * —— 那是**系统浏览器**，员工会看到窗口跳到 DSH 之外（2026-09-29 用户当场指出钉钉登录
 * "还是用的外置浏览器"）。DSH 侧栏浏览器才是"在 DSH 里打开"，它由
 * `@deepseek-ai/dsh-client-ui-sidebar-browser` 注册成 `browser` 标签类型。
 *
 * 三条判据：
 * 1. **服务与标签类型都可能缺席**（Web profile 默认关闭该标签；旧桌面端没有这个包）。
 *    `openTab` 抛错时**必须**退回系统浏览器 —— 静默什么都不开比开在外部更糟；
 * 2. **返回 promise 的实现也要兜住**：异步失败同样退回，不能只 catch 同步抛错；
 * 3. 我们**不**等待标签真正加载完成：那是 DSH 的展示职责，插件只需要把 URL 交出去。
 */
export interface OpenExternalPorts {
  /** 系统浏览器打开方式；默认 `window.open(url, '_blank', 'noopener,noreferrer')`。 */
  openExternal?: (url: string) => void
}

export type OpenUrlResult = 'builtin' | 'external'

export function openUrlWithBuiltinFirst(
  services: Pick<ClientServices, 'sidebarRight'>,
  url: string,
  ports: OpenExternalPorts = {},
): OpenUrlResult {
  const openExternal = ports.openExternal ?? ((target: string): void => {
    if (typeof globalThis.open === 'function') globalThis.open(target, '_blank', 'noopener,noreferrer')
  })
  const sidebar = services.sidebarRight
  if (typeof sidebar?.openTab === 'function') {
    try {
      const opened = sidebar.openTab('browser', { params: { url } }) as unknown
      if (opened !== null && typeof opened === 'object'
        && typeof (opened as { catch?: unknown }).catch === 'function') {
        void (opened as Promise<unknown>).catch(() => { openExternal(url) })
      }
      return 'builtin'
    } catch (error) {
      // 形态不符 / 标签类型未启用：退回系统浏览器，别让点击变成"什么都没发生"。
      void error
    }
  }
  openExternal(url)
  return 'external'
}

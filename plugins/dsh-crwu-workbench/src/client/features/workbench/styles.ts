import { WORKBENCH_STYLE_ID, WORKBENCH_STYLE_TEXT } from './consts.ts'

/** 安装当前插件自己的样式，并在 Cordis effect 释放时清理。 */
export function installWorkbenchStyles(): () => void {
  const existing = document.getElementById(WORKBENCH_STYLE_ID)
  if (existing !== null) return () => {}

  const element = document.createElement('style')
  element.id = WORKBENCH_STYLE_ID
  element.dataset.plugin = 'dsh-crwu-workbench'
  element.textContent = WORKBENCH_STYLE_TEXT
  document.head.appendChild(element)
  return () => { element.remove() }
}

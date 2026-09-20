/** 工作台包形态骨架使用的稳定类名。 */
export const WORKBENCH_CLASSES = {
  root: 'crwu-workbench-root',
  title: 'crwu-workbench-title',
  description: 'crwu-workbench-description',
  error: 'crwu-workbench-error',
  result: 'crwu-workbench-result',
} as const

export const WORKBENCH_STYLE_ID = 'crwu-workbench-package-styles'

/**
 * 当前 package 形态仍使用仓库自带的轻量 tsdown 配置，尚未接入 DSH monorepo
 * 的 CSS Module 虚拟加载器，因此样式随 client.js 一起交付，避免漏发独立 CSS。
 */
export const WORKBENCH_STYLE_TEXT = `
.crwu-workbench-root {
  padding: 14px 16px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.7;
}
.crwu-workbench-title { font-size: 15px; font-weight: 600; }
.crwu-workbench-description {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
}
.crwu-workbench-error {
  margin-top: 8px;
  color: var(--dsw-alias-state-error-primary);
}
.crwu-workbench-result {
  margin-top: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
`

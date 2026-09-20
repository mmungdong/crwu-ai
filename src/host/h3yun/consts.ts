/** 工作台固定协议值：路由、字段代码、状态枚举这类**不可配置**的东西只放这里。 */

/** 氚云默认表单名；可被 Config 覆盖。 */
export const DEFAULT_FORM_NAME = '报告审核'

/**
 * 氚云分页列表的 stdout 预算。
 *
 * 20 条记录约 233KB，DSH 的默认 64KB 会把它截断成半个 JSON —— 解析失败就会显示「没有待办」。
 * 所以这里显式放大，并保留「截断了就不解析」的判定。
 */
export const RECORDS_STDOUT_MAX = 4 * 1024 * 1024

/** 完整流水号（含业务段），用于判断「精确匹配」还是「模糊匹配」。 */
export const SEQ_NO_FULL = /^\d{4}-\d+-[A-Za-z]+\d+(?:-[A-Za-z]+\d+)?$/

/** 表单节点类型：只有这两种算「表单」。 */
export const FORM_NODE_TYPES = ['200', '210']

/** 氚云字段代码 → 语义名。改动前先确认氚云表单里的字段没变。 */
export const H3YUN_FIELDS = {
  project: 'F0000049',
  business: 'F0000056',
  risk: 'F0000020',
  reviewLevel: 'F0000158',
  reviewState: 'F0000178',
  currentNode: 'F0000184',
} as const

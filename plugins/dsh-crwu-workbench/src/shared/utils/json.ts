import { text } from './value.ts'

/**
 * 从一段可能夹着 CLI 自己输出的文本里取出第一个 JSON 文档。
 *
 * **为什么需要它**（真实 DSH + 真实 OSS 数据上验出来的）：`ossutil` v1.7.19 会把进度尾巴
 * `<n>(s) elapsed` **无条件**写到 **stdout**（实测：`-q` / `--quiet` / `--loglevel error`
 * 都关不掉，它连错误信息也写 stdout）。于是对 `ossutil cat` 的输出做 `JSON.parse` 会在
 * **每一个真实对象**上失败，表现为「审核信息」抽屉永远报「审核结果不是合法 JSON」。
 * 这不是包形态引入的 —— 旧动态形态的 `parseJsonLoose` 也只是 `try JSON.parse`，
 * 同样中招；只是没有真实对象就看不出来。
 *
 * 解析顺序：先按原文严格解析（正常输出仍然严格），失败后再扫描出第一个**配对完整**的 JSON
 * 文档。扫描必须正确处理字符串里的 `{` `}` 与反斜杠转义，否则 `{"a":"}{"}` 会被截在半路。
 * 拿不到完整文档就返回 `null` —— 垃圾输入仍然不会被当成成功。
 *
 * 只用于**命令行 stdout**。文件、HTTP body、状态文件仍然走严格 `JSON.parse`：
 * 那些地方「能解析」本身就是正确性证据，放松解析会掩盖损坏。
 */
export function parseJsonLoose(value: unknown): unknown {
  const raw = text(value).trim()
  if (raw === '') return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    // 不是异常，是「CLI 在自己输出前后加了话」这类可预期情况；交给下面的扫描。
    void error
  }
  return parseFirstDocument(raw)
}

/** 扫描第一个配对完整的 JSON 文档；找不到或括号不匹配返回 null。 */
function parseFirstDocument(raw: string): unknown {
  const start = firstOpening(raw)
  if (start < 0) return null
  const opener = raw.charAt(start)
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let at = start; at < raw.length; at += 1) {
    const ch = raw.charAt(at)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth += 1
      continue
    }
    if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth < 0) return null
      if (depth === 0) {
        // 收尾括号必须与起始括号同类；`{"a":1]` 这种错配不能放过。
        if (ch !== closer) return null
        try {
          return JSON.parse(raw.slice(start, at + 1))
        } catch (error) {
          void error
          return null
        }
      }
    }
  }
  return null
}

/** 文本里最靠前的 `{` 或 `[`；都没有返回 -1。 */
function firstOpening(raw: string): number {
  const brace = raw.indexOf('{')
  const bracket = raw.indexOf('[')
  if (brace < 0) return bracket
  if (bracket < 0) return brace
  return Math.min(brace, bracket)
}

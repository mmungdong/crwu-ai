import * as React from 'react'

const MAX_DEPTH = 8

/**
 * Parse a serialized object/array only when the whole string really is JSON.
 *
 * A plain path or prose (including Windows paths with literal backslashes) is
 * returned untouched: silently rewriting `\\n` or stripping escapes would corrupt
 * values the Host explicitly stored as text.
 */
function parseJsonContainer(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '' || (trimmed[0] !== '[' && trimmed[0] !== '{')) return value
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : value
  } catch {
    return value
  }
}

function primitiveText(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Business-neutral value renderer: readable fields and lists, real newlines, no HTML.
 *
 * Text is always rendered through React text nodes (never `dangerouslySetInnerHTML`),
 * so Host data can never become markup. Nested JSON strings are parsed one level at a
 * time; anything that is not a complete JSON object/array stays verbatim text.
 */
export function StructuredValue(props: { value: unknown; depth?: number }): React.ReactElement {
  const value = parseJsonContainer(props.value)
  const depth = props.depth ?? 0

  if (depth < MAX_DEPTH && Array.isArray(value)) {
    if (value.length === 0) return <span className="crwu-workflow-value-empty">空列表</span>
    return <ol className="crwu-workflow-value-list">{value.map((item, index) => <li
      className="crwu-workflow-value-item"
      key={index}
    >
      <StructuredValue value={item} depth={depth + 1} />
    </li>)}</ol>
  }

  if (depth < MAX_DEPTH && isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return <span className="crwu-workflow-value-empty">空记录</span>
    return <dl className="crwu-workflow-value-object">{entries.map(([key, item]) => <div
      className="crwu-workflow-value-row"
      key={key}
    >
      <dt className="crwu-workflow-value-key">{key}</dt>
      <dd className="crwu-workflow-value-field"><StructuredValue value={item} depth={depth + 1} /></dd>
    </div>)}</dl>
  }

  return <span className="crwu-workflow-value-text">{primitiveText(value)}</span>
}

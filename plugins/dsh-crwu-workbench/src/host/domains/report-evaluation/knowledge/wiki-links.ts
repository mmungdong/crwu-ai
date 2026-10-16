/**
 * 资产入口 Wiki 的**库内链接**解析（设计稿 §4.2）。
 *
 * ## 为什么需要这一层
 *
 * Wiki 正文由业务维护者手写，链接以**知识库相对路径**书写（例如
 * `<01 房地产估值通用/01 输入与资料解释.md>`）—— 这在编辑器里能跳转，在库内也是稳定的。
 * 但它不是本机路径、也不是网页地址：包一层"解析成库内完整路径"，才能拿它去核对真实节点身份。
 * 于是人工粘贴正文之后**不必先取得全部节点 ID** 就能用；维护者日后换成原生节点链接，
 * 两种入口仍然指向同一份真实知识。
 *
 * ## 三条口径
 *
 * 1. **基准是当前文档所在目录**（不是知识库根）。`<a/b.md>` 在 `01 房地产/wiki.md` 里指
 *    `01 房地产/a/b.md`。
 * 2. **不许逃出知识库根**。`..` 越界、绝对路径、本机路径都判 `invalid` 并说明原因 ——
 *    Wiki 是可编辑文档，否则它能指向库外任意文件。
 * 3. **外部链接与纯锚点不是知识路径**。`https://…` 与 `#小节` 照原样保留、标成
 *    `external` / `anchor`，不假装解析出一个库内路径。
 *
 * ⚠️ 这一层**不读库、不解析业务**：它只回答"这段文字指向哪一条库内路径"。
 * 路径能不能对上真实节点，由目录树侧的 `resolveRoute` 按**路径身份**回答。
 */

/** 一条从正文里读出来的链接。 */
export interface WikiLink {
  /** 链接文字（原样保留；空的也留一条，好让"有链接没文字"看得出来）。 */
  label: string
  /** 原始 target（逐字保留，便于核对作者写的是什么）。 */
  target: string
  /** 解析出的库内完整路径；外部链接 / 纯锚点 / 非法目标时是空串。 */
  path: string
  /** 目标里的锚点（`#…` 之后的内容，不含 `#`）；没有是空串。 */
  anchor: string
  /** 这个 target 指向什么。 */
  kind: 'knowledge' | 'external' | 'anchor' | 'invalid'
  /** `kind === 'invalid'` 的原因（人话，进能力缺口文案）。 */
  error: string
}

/** 明显的外部地址（有 scheme 的绝对 URL）。 */
function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target)
}

/**
 * 把一条链接 target 解析成库内完整路径。
 *
 * `fromPath` 是**当前文档**的库内完整路径（相对知识库根），基准取它所在目录。
 */
export function resolveWikiTarget(
  fromPath: string,
  target: string,
): { ok: true; path: string; anchor: string } | { ok: false; error: string } {
  let raw = target.trim()
  // Markdown 允许用尖括号包住带空格的路径：`[输入解释](<01 通用/01 输入与资料解释.md>)`。
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim()
  if (raw === '') return { ok: false, error: '链接目标为空' }
  if (isExternal(raw)) return { ok: false, error: `外部地址不是知识库路径：${raw}` }

  const hash = raw.indexOf('#')
  const anchor = hash < 0 ? '' : raw.slice(hash + 1)
  const withoutAnchor = hash < 0 ? raw : raw.slice(0, hash)
  if (withoutAnchor.trim() === '') {
    // 纯锚点：指向本文档的某一节，不是一个库内节点。
    return { ok: false, error: '纯锚点指向当前文档，不是另一个知识节点' }
  }

  // 百分号转义（空格、中文）要还原：作者从编辑器复制出来时常常是编码过的。
  let decoded = withoutAnchor.trim()
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // 编码坏了就按原样用：报"路径不存在"比报"转义坏了"更容易查。
  }
  if (decoded.startsWith('/')) {
    return { ok: false, error: `绝对路径不许出现在 Wiki 链接里：${decoded}` }
  }

  const base = parentDirOf(fromPath)
  const segments: string[] = base === '' ? [] : base.split('/')
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        return { ok: false, error: `链接逃出知识库根：${decoded}` }
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) return { ok: false, error: `链接没有解析出任何路径：${decoded}` }
  return { ok: true, path: segments.join('/'), anchor }
}

/** 文档所在目录（库内 posix 路径）。 */
function parentDirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? '' : normalized.slice(0, slash)
}

/**
 * 从一份 Markdown 正文里读出**行内链接**（`[label](target)`）。
 *
 * 只认行内形式：交付的正文用的就是它；参考式链接（`[label][ref]` + 定义块）在这套知识里
 * 没有出现过，硬猜会把代码块里的方括号也当成链接。
 */
export function parseWikiLinks(markdown: string, fromPath: string): WikiLink[] {
  const linked: WikiLink[] = []
  // target 用**惰性**匹配到第一个 `)`：作者不写尖括号时路径里也可能有空格
  //（严格的 Markdown 要求 `<…>`，但正文是人写的；宁可宽容解析，也不要静默漏掉一条链接）。
  const pattern = /\[([^\]]*)\]\(\s*(<[^>\n]*>|[^)\n]*?)(?:\s+"[^"]*")?\s*\)/g
  for (const match of String(markdown ?? '').matchAll(pattern)) {
    const label = match[1] ?? ''
    const target = match[2] ?? ''
    if (isExternal(target.trim())) {
      linked.push({ label, target, path: '', anchor: '', kind: 'external', error: '' })
      continue
    }
    const resolved = resolveWikiTarget(fromPath, target)
    if (resolved.ok) {
      linked.push({ label, target, path: resolved.path, anchor: resolved.anchor, kind: 'knowledge', error: '' })
      continue
    }
    const anchorOnly = target.trim().startsWith('#')
    linked.push({
      label,
      target,
      path: '',
      anchor: anchorOnly ? target.trim().slice(1) : '',
      kind: anchorOnly ? 'anchor' : 'invalid',
      error: anchorOnly ? '' : resolved.error,
    })
  }
  return linked
}

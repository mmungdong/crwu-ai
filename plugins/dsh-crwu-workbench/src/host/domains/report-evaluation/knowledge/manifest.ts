/**
 * 知识库侧 **manifest** 的解析层（设计稿 §4.1）。
 *
 * 从这一层起，"要取哪些知识"由知识库自己声明，不再由技能里的静态路由表规定。
 * manifest 住在 `01 估值与测算/01 房地产/<文件名>`，声明三件事：方法选择方案、
 * 各方法正文、各方法计算表模板。
 *
 * 三条口径：
 *
 * 1. **`null` 与"键缺失"是两件事**。`null` = 该项还没写（收益法、成本法正文当前在库中为空，
 *    走的就是这一路），跳过即可；**键缺失**才是 manifest 写坏了，进 `problems`。
 *    混同会让一个还没写的 TODO 方法作废整份 manifest，或者反过来让一个漏写的键静默变成"不支持"。
 * 2. **路径不许逃出知识库**。绝对路径与 `..` 一律拒绝 —— manifest 是库侧可编辑文档，
 *    否则它可以指向库外的任意文件。
 * 3. **两个槽位可以指向同一份文件**。方法之间共用一份正文是正常配置，不是错误。
 *
 * 形态沿用 `parseTemplateIndex` 已有的两种，不另造一套：JSON 围栏权威，Markdown 清单表受控适配。
 */

import { text } from '../../../../shared/utils/value.ts'
import type { KnowledgeRouteKind } from './route.ts'

const MANIFEST_VERSION = 1

const METHOD_SELECTION_ROUTE_ID = 'method-selection'
const METHOD_PREFIX = 'method.'
const GUIDE_SUFFIX = '.guide'
const TEMPLATE_SUFFIX = '.template'

/** manifest 声明的一条取数路由。`routeId` 由**键位**推导，不用库内路径当 id。 */
export interface ManifestRoute {
  /**
   * 逻辑槽位。推导规则（与 `references/knowledge-routing.md` 逐字一致）：
   * 顶层 `methodSelection` → `method-selection`；`methods.<m>.guide` → `method.<m>.guide`；
   * `methods.<m>.template` → `method.<m>.template`。
   *
   * 用键位而不是库内路径，是因为**路径会随库改名变**（2026-10-14 库侧就把 `02-市场法` 改成了
   * `02 市场法`），而槽位不该跟着变 —— 否则每次改名都要改报告、schema 与历史快照。
   */
  routeId: string
  /** 库内相对路径，**相对 manifest 自己所在的目录**逐字书写。 */
  path: string
  kind: KnowledgeRouteKind
}

export interface ManifestParseResult {
  ok: boolean
  error: string
  /** manifest 写坏了的地方。非空即 `ok = false`。 */
  problems: string[]
  /** 能取到但值得知道的：不阻断。 */
  warnings: string[]
  methodSelection: string | null
  routes: ManifestRoute[]
}

interface ManifestBody {
  methodSelection: string | null
  routes: ManifestRoute[]
}

/** `methods.<m>.guide` 的槽位名。 */
export function methodGuideRouteId(method: string): string {
  return `${METHOD_PREFIX}${method}${GUIDE_SUFFIX}`
}

/** `methods.<m>.template` 的槽位名。 */
export function methodTemplateRouteId(method: string): string {
  return `${METHOD_PREFIX}${method}${TEMPLATE_SUFFIX}`
}

/** 方法选择方案的槽位名。 */
export { METHOD_SELECTION_ROUTE_ID }

/**
 * manifest 内的路径 → 库内完整路径。
 *
 * **基准**：manifest 内的路径相对 manifest 自己所在的目录。这与 `manifestPath`
 * （相对知识库根）是两条不同的基准，各自写死，不得混用。
 */
export function manifestRoutePath(manifestDir: string, route: ManifestRoute): string {
  const base = manifestDir.replace(/\/+$/, '')
  return base === '' ? route.path : `${base}/${route.path}`
}

export function parseValuationManifest(document: string): ManifestParseResult {
  const body = text(document)
  const problems: string[] = []
  const warnings: string[] = []
  let methodSelection: string | null = null
  let routes: ManifestRoute[] = []
  let parsed = false

  const blocks = [...body.matchAll(/```json\s*([\s\S]*?)```/gi)]
  for (const block of blocks) {
    let payload: unknown
    try {
      payload = JSON.parse(text(block[1]))
    } catch (error) {
      problems.push(`manifest 的 JSON 段解析失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      problems.push('manifest 的 JSON 段必须是对象（含 `version` / `methodSelection` / `methods`）')
      continue
    }
    const read = readManifestObject(payload as Record<string, unknown>, problems)
    if (read === null) continue
    parsed = true
    methodSelection = read.methodSelection
    routes = read.routes
    break
  }

  // JSON 段是权威形态；一段都没有时才做 Markdown 清单表的受控适配。
  if (blocks.length === 0) {
    const adapted = adaptRouteTable(body, problems)
    if (adapted !== null) {
      parsed = true
      methodSelection = adapted.methodSelection
      routes = adapted.routes
    }
  }

  const error = problems[0]
    ?? (parsed
      ? ''
      : '知识目录里没有机器可读的 ```json 段，也没有可识别的知识清单表：无法据此确定要取哪些知识')

  return { ok: error === '', error, problems, warnings, methodSelection, routes }
}

function readManifestObject(root: Record<string, unknown>, problems: string[]): ManifestBody | null {
  if (root.version !== MANIFEST_VERSION) {
    problems.push(
      `不支持的 manifest version：${JSON.stringify(root.version)}（本工具只认 version ${String(MANIFEST_VERSION)}）`,
    )
    return null
  }

  const routes: ManifestRoute[] = []
  const selection = readSlot(root, 'methodSelection', 'manifest 顶层', '方法选择方案还没写')
  let methodSelection: string | null = null
  if (selection.kind === 'broken') problems.push(selection.problem)
  else if (selection.kind === 'present') {
    methodSelection = selection.path
    routes.push({ routeId: METHOD_SELECTION_ROUTE_ID, path: selection.path, kind: 'document' })
  }

  if (!Object.hasOwn(root, 'methods')) {
    problems.push('manifest 缺少 `methods` 键（写法：`{"<方法>": {"guide": …, "template": …}}`，没有方法时写 `{}`）')
    return { methodSelection, routes }
  }
  const methods = root.methods
  if (methods === null || typeof methods !== 'object' || Array.isArray(methods)) {
    problems.push('manifest 的 `methods` 必须是对象')
    return { methodSelection, routes }
  }

  for (const [method, raw] of Object.entries(methods as Record<string, unknown>)) {
    if (method.trim() === '') {
      problems.push('`methods` 里有空的方法名')
      continue
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`methods.${method} 必须是对象（含 \`guide\` 与 \`template\`）`)
      continue
    }
    const carrier = raw as Record<string, unknown>
    const where = `methods.${method}`

    const guide = readSlot(carrier, 'guide', where, '该方法正文还没写')
    if (guide.kind === 'broken') problems.push(guide.problem)
    else if (guide.kind === 'present') {
      routes.push({ routeId: methodGuideRouteId(method), path: guide.path, kind: 'document' })
    }

    const template = readSlot(carrier, 'template', where, '该方法还没有计算表模板')
    if (template.kind === 'broken') problems.push(template.problem)
    else if (template.kind === 'present') {
      routes.push({ routeId: methodTemplateRouteId(method), path: template.path, kind: 'binary' })
    }
  }

  return { methodSelection, routes }
}

type SlotRead =
  | { kind: 'present'; path: string }
  | { kind: 'absent' }
  | { kind: 'broken'; problem: string }

/**
 * 读一个指针槽位。**三态**，`guide` 与 `template` 共用同一套规则：
 * 非空字符串 = 有；`null` = 该项还没写（跳过）；键缺失或类型不对 = manifest 写坏了。
 */
function readSlot(carrier: Record<string, unknown>, key: string, where: string, absentMeaning: string): SlotRead {
  if (!Object.hasOwn(carrier, key)) {
    return { kind: 'broken', problem: `${where} 缺少 \`${key}\` 键（写法：库内相对路径，或 null 表示${absentMeaning}）` }
  }
  const value = carrier[key]
  if (value === null) return { kind: 'absent' }
  const problem = pathProblem(value, `${where} 的 \`${key}\``)
  if (problem !== null) return { kind: 'broken', problem }
  return { kind: 'present', path: value as string }
}

function pathProblem(value: unknown, where: string): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${where} 必须是库内相对路径（非空字符串）`
  }
  if (value.startsWith('/')) {
    return `${where} 是绝对路径（${value}）：manifest 只能指向知识库内的相对路径`
  }
  if (value.split('/').includes('..')) {
    return `${where} 含 \`..\`（${value}）：不得逃出知识库根`
  }
  return null
}

function kindForRouteId(routeId: string): KnowledgeRouteKind | null {
  if (routeId === METHOD_SELECTION_ROUTE_ID) return 'document'
  if (!routeId.startsWith(METHOD_PREFIX)) return null
  const method = routeId.slice(METHOD_PREFIX.length)
  if (method.length > GUIDE_SUFFIX.length && method.endsWith(GUIDE_SUFFIX)) return 'document'
  if (method.length > TEMPLATE_SUFFIX.length && method.endsWith(TEMPLATE_SUFFIX)) return 'binary'
  return null
}

/**
 * Markdown 清单表的受控适配：表头逐字要求 `routeId` 与 `路径` 两列，
 * `routeId` 必须是已登记的槽位。未登记、重复、路径不合法的行整行报 problem —— **不猜**。
 */
function adaptRouteTable(body: string, problems: string[]): ManifestBody | null {
  const lines = body.split(/\r?\n/)
  let headerAt = -1
  let routeIdAt = -1
  let pathAt = -1
  for (const [index, line] of lines.entries()) {
    const cells = tableCells(line)
    if (cells === null) continue
    const foundRouteId = cells.findIndex((cell) => cell.toLowerCase() === 'routeid')
    const foundPath = cells.findIndex((cell) => cell === '路径')
    if (foundRouteId >= 0 && foundPath >= 0) {
      headerAt = index
      routeIdAt = foundRouteId
      pathAt = foundPath
      break
    }
  }
  if (headerAt < 0) return null

  const routes: ManifestRoute[] = []
  const seen = new Set<string>()
  let methodSelection: string | null = null

  for (let index = headerAt + 1; index < lines.length; index += 1) {
    const cells = tableCells(lines[index])
    if (cells === null) continue
    const routeId = (cells[routeIdAt] ?? '').trim()
    const path = (cells[pathAt] ?? '').trim()
    if (routeId === '' && path === '') continue
    if (routeId === '' || /^-+$/.test(routeId.replace(/[: ]/g, ''))) continue

    const where = `知识清单表第 ${String(index + 1)} 行`
    const kind = kindForRouteId(routeId)
    if (kind === null) {
      problems.push(
        `${where}的 routeId \`${routeId}\` 不是已登记的槽位`
          + `（可用：${METHOD_SELECTION_ROUTE_ID} / method.<方法>.guide / method.<方法>.template）`,
      )
      continue
    }
    if (seen.has(routeId)) {
      problems.push(`${where}的 routeId \`${routeId}\` 重复登记`)
      continue
    }
    const problem = pathProblem(path, `${where} \`${routeId}\` 的路径`)
    if (problem !== null) {
      problems.push(problem)
      continue
    }

    seen.add(routeId)
    routes.push({ routeId, path, kind })
    if (routeId === METHOD_SELECTION_ROUTE_ID) methodSelection = path
  }

  return { methodSelection, routes }
}

function tableCells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
  return cells.length >= 2 ? cells : null
}

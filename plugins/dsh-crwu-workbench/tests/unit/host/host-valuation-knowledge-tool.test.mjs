/**
 * `crwu_valuation_knowledge_materialize` 的**工具接线**测试。
 *
 * 决策逻辑（哪一份、从哪来、缺了算不算致命）在 `host-valuation-knowledge.test.mjs` 里被穷尽覆盖；
 * 这里只测接线，而且专挑最容易静默出错的那几条：
 *
 * 1. **没有本地 references 兜底**：知识库读不到时工具必须如实失败/gap，而不是把技能自带的
 *    参考文件倒进案例目录冒充"业务规范"。
 * 2. **空间名只能等于配置的业务库名**：`spaceName` 传别的值一律 fail closed，且**一个进程都不起**。
 * 3. **`routeIds` 省略 = 只回报可用槽位**：先看清 manifest 声明了哪些方法，再决定取什么。
 *    **这里没有"阶段"** —— 取数顺序是会话的编排，不是工具的规范。
 * 4. **除 manifest 读不到之外，任何缺失都不整体失败**（回归锚点：空目录不再阻断估值）。
 * 5. **模型可见结果里没有 nodeId、没有镜像绝对路径**。
 *
 * 所有替身都是内存实现：不碰真实知识库、凭据、网络。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationKnowledgeTools } = await import(new URL('src/host/tools/report-evaluation/knowledge.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { KNOWLEDGE_INDEX_FILE, KNOWLEDGE_SNAPSHOT_DIR, VALUATION_KNOWLEDGE_SPACE } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)
const { KNOWLEDGE_MANIFEST_FILE } = await import(new URL('src/host/tools/report-evaluation/catalog.ts', ROOT).href)
const { knowledgeDigest, knowledgeSnapshotDigest } = await import(new URL('src/host/domains/report-evaluation/knowledge/snapshot.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-140000-aa11'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`

/** manifest 的库内位置（相对**知识库根**）——bootstrap 里唯一写死的东西。 */
const MANIFEST_PATH = '01 估值与测算/01 房地产/00-知识目录与必需项'

const WIKI_PATH = '01 估值与测算/01 房地产/wiki.md'

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
  valuation: { knowledge: { mirrorRoot: '', wikiPath: WIKI_PATH, manifestPath: MANIFEST_PATH } },
}

// ── 内存 fs + 只回答 DWS 命令的 shell 替身 ────────────────────────────────

const FOLDER = (nodeId, name) => ({ nodeId, name, type: 'FOLDER', extension: '' })
const DOC = (nodeId, name, extension) => ({ nodeId, name, type: 'FILE', extension, updatedAt: '2026-10-01T00:00:00.000Z' })

/**
 * 一份最小的真实形状目录树（`02 估值方法` 用空格，与观测到的逐字名称一致）。
 *
 * `f-04`（`01 房地产估值通用`）是个**空目录**：这正是最原始那条报障的触发点。
 */
const TREE = {
  '': [FOLDER('f-01', '01 估值与测算')],
  'f-01': [FOLDER('f-02', '01 房地产')],
  'f-02': [
    FOLDER('f-03', '02 估值方法'),
    FOLDER('f-04', '01 房地产估值通用'),
    FOLDER('f-05', '05 计算表模板'),
    DOC('f-10', '00-知识目录与必需项', 'adoc'),
  ],
  'f-03': [
    DOC('f-11', '01 房地产评估方法选择方案', 'adoc'),
    DOC('f-12', '02-市场法', 'md'),
    DOC('f-13', '03-收益法（TODO）', 'adoc'),
  ],
  'f-04': [],
  'f-05': [FOLDER('f-51', '01 市场法')],
  'f-51': [DOC('f-52', '01 市场法计算表模板-住宅', 'xlsx')],
}

/**
 * manifest 正文：**库侧可编辑文档**，是"要取哪些知识"的唯一入口。
 *
 * `methodSelection` 指向的 `01 房地产估值通用` 在库里是一个空目录 —— 这在旧形态下会让整轮
 * 估值直接失败；现在它只是一条 `state=empty` 的缺口。
 */
const MANIFEST_BODY = [
  '# 知识目录与必需项',
  '',
  '```json',
  JSON.stringify({
    version: 1,
    methodSelection: '01 房地产估值通用',
    methods: {
      market: { guide: '02 估值方法/02-市场法.md', template: '05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx' },
      income: { guide: null, template: null },
      cost: { guide: null, template: null },
    },
  }, null, 2),
  '```',
  '',
].join('\n')

const DECLARED = ['method-selection', 'method.market.guide', 'method.market.template']

const EXPORTED = {
  'f-10': MANIFEST_BODY,
  'f-11': '# 方法选择\n正文。\n',
  'f-12': '# 市场法\n正文。\n',
  'f-13': '   \n',
}

/**
 * 取下一条命令里某个 flag 的值。
 *
 * 先按**引号字面量**取（节点名里有空格：`01 房地产与必需项`），取不到再按裸参数取。
 */
function argAfter(command, flag) {
  const raw = String(command)
  const quoted = new RegExp(`${flag}\\s+'((?:[^']|'\\\\'')*)'`).exec(raw)
  if (quoted !== null) return String(quoted[1]).replace(/'\\''/g, "'")
  const parts = raw.split(/\s+/)
  const index = parts.indexOf(flag)
  if (index < 0) return ''
  return String(parts[index + 1] ?? '').replace(/^'(.*)'$/s, '$1').replace(/'\\''/g, "'")
}

/**
 * 包内二进制（工具严格要求它们存在：`resolveBundledCommand` 找不到就记能力缺口，
 * 绝不回落 PATH 上同名命令）。替身里让它们「存在」，但真正的 `dws` 调用由 handler 回答。
 */
const PKG_BIN_DIR = new URL('bin/darwin-arm64/', ROOT).pathname.replace(/\/$/, '')

function makeCtx({ dwsFails = false, indexWriteFails = false, tree = TREE, exported = EXPORTED, afterWrite = null, refuseExistingExport = false, contains = null } = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR])
  const files = new Map(['crwu', 'dws', 'ossutil'].map((name) => [`${PKG_BIN_DIR}/${name}`, 'binary']))
  const commands = []
  // Mutable control surface: switch "knowledge base unreachable" or "node export fails" between
  // two calls to reproduce LOCAL_FILE_EXISTS / network-interruption symptoms.
  const control = { dwsFails, refuseExistingExport, failExportNodes: new Set() }
  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) {
      const key = String(target.targetKey)
      if (indexWriteFails && key.endsWith(KNOWLEDGE_INDEX_FILE)) {
        const error = new Error(`cannot write "${key}": file access denied under workspace-write mode`)
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      files.set(key, content)
      // Test hook: observe/alter persisted bytes (e.g. corrupt a snapshot after its index is written).
      if (typeof afterWrite === 'function') afterWrite(key, files)
      return { operation: 'create', version: 'v' }
    },
    contains(parent, child) {
      if (typeof contains === 'function') return contains(parent, child)
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }

  const shellService = {
    resolve: (request) => request,
    async execute(request) {
      const command = String(request?.command ?? '')
      commands.push(command)
      const workdir = String(request?.workdir ?? CASE_DIR)

      const probe = probeAnswer(command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(path),
      })
      if (command.startsWith('mkdir') || probe !== undefined) {
        applyShellEffect(command, 0, {
          addDir: (path) => directories.add(path),
          removeFile: (path) => { files.delete(path) },
        })
        return {
          result: async () => ({
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: probe ?? '', truncated: false }, stderr: { text: '', truncated: false },
          }),
        }
      }

      if (control.dwsFails) {
        return {
          result: async () => ({
            exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: '', truncated: false },
            stderr: { text: 'dws: 未登录 / 网络不可达', truncated: false },
          }),
        }
      }

      let stdout = '{}'
      if (command.includes('+space-list')) {
        stdout = JSON.stringify({ spaces: [{ name: VALUATION_KNOWLEDGE_SPACE, workspaceId: 'wiki-biz', spaceType: 'orgWikiSpace' }] })
      } else if (command.includes('+node-list')) {
        const folder = argAfter(command, '--folder')
        stdout = JSON.stringify({ nodes: tree[folder] ?? [] })
      } else if (command.includes('+export') || command.includes('+download')) {
        const node = argAfter(command, '--node')
        const output = argAfter(command, '--output')
        const target = `${workdir}/${output}`
        // Real export refuses to overwrite an existing output with LOCAL_FILE_EXISTS; mirror that
        // so a repeated materialization of the same path cannot be masked by a silent rewrite.
        if (control.failExportNodes.has(node) || (control.refuseExistingExport && files.has(target))) {
          return {
            result: async () => ({
              exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: '', truncated: false },
              stderr: { text: 'dws: LOCAL_FILE_EXISTS: 输出文件已存在，拒绝覆盖', truncated: false },
            }),
          }
        }
        const body = exported[node] ?? ''
        files.set(target, body)
        stdout = JSON.stringify({ ok: true, node })
      }
      return {
        result: async () => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false },
        }),
      }
    },
  }

  return {
    directories, files, commands, control,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellService
      return undefined
    },
  }
}

function makeDeps({ ctx = makeCtx(), config = {} } = {}) {
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, state,
    deps: {
      ctx, config: { ...CONFIG, ...config }, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: new ValuationScopes(),
      world: {
        platform: async () => 'darwin-arm64',
        home: async () => '/Users/x',
        workdir: async () => WORKSPACE,
        cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
      },
    },
  }
}

function openValuation(deps, sessionId = 'valuation-session-1') {
  deps.valuationScopes.open({
    valuationId: VALUATION_ID, casePath: CASE_DIR, sessionId,
    workspaceId: 'w1', workspacePath: WORKSPACE,
    snapshot: {
      valuationId: VALUATION_ID, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:x', frozenAt: '2026-10-12T00:00:00.000Z', files: [],
    },
    openedAt: 1,
  })
  return sessionId
}

function execOf(sessionId) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.knowledgeMaterialize, arguments: {},
    signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

function dwsCommands(ctx) {
  return ctx.commands.filter((command) => !command.startsWith('mkdir') && !command.includes('-d ') && !command.includes('Test-Path'))
}

/**
 * `知识快照/` 下落的**知识正文**（不含来源索引，也不含 manifest 自己那一份快照）。
 *
 * manifest 会被取回来留档（`知识快照/.知识目录.md`）—— 它是"该取哪些知识"的凭据，
 * 每个案例都留一份才能回答"当时按哪一版清单取的数"。它不算知识正文。
 */
function snapshotBodies(ctx) {
  return [...ctx.files.keys()].filter((path) => path.startsWith(`${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/`)
    && !path.endsWith('.json')
    && !path.endsWith(`/${KNOWLEDGE_MANIFEST_FILE}`))
}

/** 一次物化：开一轮估值会话 → 执行工具。 */
async function materialize(ctx, args) {
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  return valuationKnowledgeTools(deps)[0].execute({ caseDir: CASE_DIR, ...args }, execOf(sessionId))
}

// ── 注册面与参数面 ─────────────────────────────────────────────────────────

test('注册面：知识准备 Tool 在注册清单里，但**不在**审核必需集', () => {
  assert.equal(CRWU_BUSINESS_TOOLS.includes(VALUATION_TOOL_NAMES.knowledgeMaterialize), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes(VALUATION_TOOL_NAMES.knowledgeMaterialize), false)
})

test('参数面：只接业务参数，没有 URL / 绝对路径 / 命令 / nodeId / 镜像根；参数段经 stage 显式请求', () => {
  const { deps } = makeDeps()
  const tool = valuationKnowledgeTools(deps)[0]
  const keys = Object.keys(tool.parameters.properties ?? tool.parameters).sort()
  // 协议 39：`wikiPaths` 是主通道（库内相对路径），`routeIds` 是遗留通道；
  // `stage=parameters` 是在同一份已验真正文上**追加**的结构化规则解析请求。
  assert.deepEqual(keys, ['caseDir', 'planId', 'routeIds', 'spaceName', 'stage', 'wikiPaths'])
  const schema = JSON.stringify(tool.parameters)
  for (const forbidden of ['nodeId', 'mirror', 'command', 'argv', 'url', 'binary', 'sandbox']) {
    assert.equal(schema.includes(forbidden), false, `参数面不许出现 ${forbidden}`)
  }
  // 工具描述不再把"必需知识"当口径：manifest 读不到也只在**没给 wikiPaths**时才整体失败。
  assert.equal(tool.description.includes('必需知识'), false)
  assert.match(tool.description, /manifest 读不到也不再整体失败/)
  assert.match(tool.description, /wikiPaths/)
  // 参数段解析是显式阶段，不是默认行为。
  assert.match(tool.description, /stage|参数/)
  // `wikiPaths` 收的是**库内相对路径**，不是 URL / 绝对路径 —— 参数面照样不许出现这些词。
  assert.equal(JSON.stringify(tool.parameters.properties.wikiPaths).includes('url'), false)
})

// ── fail closed ────────────────────────────────────────────────────────────

test('非估值会话被拒（普通会话不许把知识倒进案例目录）', async () => {
  const { deps } = makeDeps()
  const result = await valuationKnowledgeTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf('随便一条会话'))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /不是本轮估值会话/)
})

test('spaceName 不等于配置的业务库名 → fail closed，且一个 dws 进程都不起', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, { spaceName: '中瑞世联评估审核知识库' })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /业务库/)
  assert.deepEqual(dwsCommands(ctx), [])
})

// ── routeIds 省略：先看清有哪些槽位 ───────────────────────────────────────

test('routeIds 省略 → 只回报 manifest 声明了哪些槽位，不落任何正文', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, {})
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.availableRouteIds, DECLARED)
  assert.deepEqual(result.routeIds, [])
  assert.deepEqual(result.entries, [])
  assert.match(result.manifestDigest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(snapshotBodies(ctx), [])
})

test('入口 Wiki 是协议 39 起的唯一入口：结果里给出 wikiPath，并提示遗留的 manifest 链路', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, { routeIds: ['method.market.guide'] })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.entryWikiPath, WIKI_PATH, '配置声明的入口 Wiki 要交给会话')
  // 仍然靠 manifest 槽位寻址时，如实带迁移提示（不是错误，也不阻断）：
  // ① 取数层说"这一轮按槽位读取"；② 工具层说"该切成入口 Wiki 了"。
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings[0], /按 manifest 槽位读取（遗留通道）/)
  assert.match(result.warnings[1], /仍走\*\*遗留的 manifest 槽位\*\*/)
  assert.match(result.warnings[1], /wikiPath/)
  assert.match(result.warnings[1], /入口 Wiki/)
  assert.deepEqual(result.wikiPaths, [])
})

test('按入口 Wiki 读取：**不需要 manifest**，正文里的 links[] 带回给会话当下一跳', async () => {
  // 入口 Wiki 写的是**库内相对链接**；Host 把它解析成库内完整路径，Agent 下一轮按它读。
  const entryBody = [
    '# 房地产估值 Wiki',
    '',
    '先读[方法选择](02 估值方法/01 房地产评估方法选择方案.adoc)。',
    '',
  ].join('\n')
  // 库里放一份入口 Wiki（`01 房地产` 那一层），并给它一份带链接的正文。
  const tree = { ...TREE, 'f-02': [...TREE['f-02'], DOC('f-99', 'wiki', 'md')] }
  const ctx = makeCtx({ tree, exported: { ...EXPORTED, 'f-99': entryBody } })
  const { deps } = makeDeps({ ctx })
  const result = await valuationKnowledgeTools(deps)[0].execute(
    { caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] },
    execOf(openValuation(deps)),
  )
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.wikiPaths, [WIKI_PATH])
  assert.deepEqual(result.routeIds, [`wiki:${WIKI_PATH}`])
  assert.equal(result.states.length, 1)
  assert.equal(result.states[0].state, 'found', result.states[0].error)
  // 入口 Wiki 的库内相对链接被解析成**库内完整路径** —— 这就是会话的下一跳。
  const entry = result.entries.find((item) => item.routeId === `wiki:${WIKI_PATH}`)
  assert.equal(entry.links.length, 1)
  assert.equal(entry.links[0].path, '01 估值与测算/01 房地产/02 估值方法/01 房地产评估方法选择方案.adoc')
  // 遗留通道的提示仍然在（本库还声明了槽位表），但它**没有**参与这一轮的取数。
  assert.match(result.warnings.join('；'), /按 Wiki 路径读取/)
})

test('只回报可用槽位时（没取正文）不产生迁移提示：那一轮没有走槽位寻址', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, {})
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.wikiPaths, [])
  assert.equal(result.entryWikiPath, WIKI_PATH)
})

test('请求 manifest 没声明的 routeId → input 错误，不取任何数', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, { routeIds: ['method.income.guide'] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
  assert.match(result.error, /method\.income\.guide/)
  assert.match(result.error, /method\.market\.guide/, '要把本库声明了哪些槽位一并说清')
  assert.deepEqual(snapshotBodies(ctx), [])
})

// ── 知识库不可达：没有本地 references 兜底 ────────────────────────────────

test('知识库不可达 → 如实失败（唯一真停），不把技能自带 references 当正文', async () => {
  const ctx = makeCtx({ dwsFails: true })
  const result = await materialize(ctx, { routeIds: ['method.market.guide'] })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /唯一真停/)
  assert.equal(result.spaceVerified, false)
  assert.equal(result.failures.length > 0, true, '知识库失败要留证据（否则查不出库挂过）')
  // 没有任何一份正文来自技能自带的 references/。
  assert.deepEqual(snapshotBodies(ctx), [])
  assert.equal(JSON.stringify(result).includes('references/'), false)
})

// ── 索引写失败 ─────────────────────────────────────────────────────────────

test('索引写失败不返回 ok：知识落盘但来源索引没写成功也不算物化完成', async () => {
  const ctx = makeCtx({ indexWriteFails: true })
  const result = await materialize(ctx, { routeIds: ['method.market.guide'] })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /索引/)
  assert.equal(result.indexFiles.includes(KNOWLEDGE_INDEX_FILE), false, '汇总索引没写成功就不算落盘')
  assert.equal(result.indexPath, '')
  assert.deepEqual(snapshotBodies(ctx), [`${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/method.market.guide/02-市场法.md`],
    '正文确实取到了，失败的是索引')
})

// ── 正常路径（假 DWS 目录树） ─────────────────────────────────────────────

test('按 manifest 取一份方法正文：正文落盘、索引写出、模型可见结果无 nodeId', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, { routeIds: ['method.market.guide'] })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.spaceName, VALUATION_KNOWLEDGE_SPACE)
  assert.equal(result.spaceVerified, true)
  assert.deepEqual(result.routeIds, ['method.market.guide'])
  assert.deepEqual(result.states.map((item) => item.state), ['found'])
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].routeId, 'method.market.guide')
  assert.equal(result.entries[0].nodeName, '02-市场法.md')
  assert.equal(result.entries[0].resolvedPath, '01 估值与测算/01 房地产/02 估值方法/02-市场法.md')
  assert.equal(result.entries[0].bodyNonEmpty, true)
  assert.match(result.entries[0].digest, /^sha256:[0-9a-f]{64}$/)

  // 只拉了市场法正文：方法选择 / 收益法 / 模板都没有被取。
  assert.equal(dwsCommands(ctx).some((command) => command.includes('--node f-11')), false)
  assert.equal(dwsCommands(ctx).some((command) => command.includes('--node f-13')), false)
  assert.equal(dwsCommands(ctx).some((command) => command.includes('--node f-52')), false, '模板走另一条通道')
  assert.deepEqual(snapshotBodies(ctx), [
    `${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/method.market.guide/02-市场法.md`,
  ])
  // manifest 自己那一份也留档：才能回答"当时按哪一版清单取的数"。
  assert.equal(ctx.files.has(`${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/${KNOWLEDGE_MANIFEST_FILE}`), true)

  // 来源索引：逐字对齐 knowledge-source.schema.json。
  const indexKey = [...ctx.files.keys()].find((path) => path.endsWith(KNOWLEDGE_INDEX_FILE))
  const aggregate = JSON.parse(ctx.files.get(indexKey))
  assert.equal(aggregate.projectId, VALUATION_ID)
  assert.equal(Object.hasOwn(aggregate, 'stage'), false, '阶段不再是取数口径的一部分')
  assert.deepEqual(aggregate.routeIds, ['method.market.guide'])
  assert.equal(aggregate.manifestDigest, result.manifestDigest)
  const perRouteKey = [...ctx.files.keys()].find((path) => path.endsWith('method.market.guide.json'))
  assert.ok(perRouteKey !== undefined, `要落一条本路由的 schema 文档：${[...ctx.files.keys()].join('、')}`)
  const document = JSON.parse(ctx.files.get(perRouteKey))
  assert.equal(document.schemaVersion, 'crwu.valuation.knowledge-source.v1')
  assert.equal(document.routeId, 'method.market.guide')
  assert.equal(document.spaceName, VALUATION_KNOWLEDGE_SPACE)
  assert.deepEqual(Object.keys(document.entries[0]).sort(),
    ['bodyNonEmpty', 'digest', 'nodeName', 'resolvedPath', 'snapshotFile', 'source', 'updatedAt'])
  assert.equal(document.entries[0].source, 'dws')

  // 模型可见结果里没有 nodeId、没有镜像绝对路径、没有凭据面事实。
  const visible = JSON.stringify(result)
  assert.equal(visible.includes('nodeId'), false)
  assert.equal(visible.includes('f-12'), false)
  assert.equal(/mirrorRoot|\/Users\/|token|sign|secret|password/i.test(visible), false)
  assert.equal(visible.includes('references/'), false)
})

test('**回归锚点**：manifest 里 methodSelection 指向空目录 → 缺口如实回报，估值不被卡住', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, { routeIds: ['method-selection', 'method.market.guide'] })

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.states.map((item) => item.state), ['empty', 'found'])
  assert.equal(result.capabilityGaps.some((gap) => gap.includes('method-selection')), true)
  assert.equal(result.errorKind, '')
  assert.equal(result.entries.length, 1, '其余路由照取，不被这一条拖住')
})

test('二进制模板槽位不走这条通道：如实回报并指向模板工具，不按正文读回乱码', async () => {
  const ctx = makeCtx()
  const result = await materialize(ctx, { routeIds: ['method.market.template'] })

  // availableRouteIds 里**包含**模板槽位（manifest 就是这么声明的），所以 agent 会合理地
  // 请求它 —— 答案必须是"这条槽位是二进制，走另一个工具"，不是"通道未装配"。
  assert.equal(result.availableRouteIds.includes('method.market.template'), true)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.states.map((item) => item.state), ['unreadable'])
  assert.deepEqual(result.entries, [])
  assert.equal(result.states[0].error.includes('crwu_valuation_template_materialize'), true)
  assert.deepEqual(snapshotBodies(ctx), [])
})

test('目录不是正文：manifest 声明的路径落在目录上时按未支持处理，不当成规范命中', async () => {
  // 把方法选择方案改成一个**没有同名文档**的目录：库里只有这个文件夹。
  const tree = { ...TREE, 'f-04': [FOLDER('f-41', '通用口径')], 'f-41': [DOC('f-42', '子文档', 'md')] }
  const ctx = makeCtx({ tree })
  const result = await materialize(ctx, { routeIds: ['method-selection'] })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.states[0].state, 'empty')
  assert.match(JSON.stringify(result.lookupAttempts), /目录/)
  assert.deepEqual(snapshotBodies(ctx).filter((path) => path.includes('method-selection')), [])
})

// ── stage=parameters：在已落盘正文上解析受控规则段 ────────────────────────
//
// 规则段**可以省略**内嵌 `snapshotDigest`（正文引用自己的哈希是做不到的），此时由 Host 把
// 返回摘要绑定到实际落盘正文的哈希；但业务侧**显式写了**一个对不上的摘要时仍必须整段不认。
// 无论哪条失败路径，`parameters` 都恒为空 —— 绝不回退到任何默认值。

/** 一份带 fenced 规则段的 Wiki 正文；用 patch 逐条构造缺口。 */
function wikiRuleBody({ fragment = {}, parameter = {} } = {}) {
  const payload = {
    ruleSetVersion: 'crwu.valuation.rule-parameters.v1',
    routeId: `wiki:${WIKI_PATH}`,
    sectionId: 'S-rates',
    parameters: [{
      ruleId: 'R-RATE-1',
      label: '增值税率',
      valueKind: 'rate',
      value: '0.09',
      unit: '%',
      comparison: 'eq',
      appliesTo: { propertyTypes: ['residential'], methods: ['market'] },
      sourceRef: '财税〔2016〕36号',
      basisGrade: 'mandatory-standard',
      strength: 'must',
      ...parameter,
    }],
    ...fragment,
  }
  return [
    '# 房地产估值 Wiki',
    '',
    '正文里的结构化规则段：',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n')
}

/** 用带规则段的 Wiki 正文跑一次取数（stage=parameters 时追加规则解析）。 */
async function materializeWiki(body, args) {
  const tree = { ...TREE, 'f-02': [...TREE['f-02'], DOC('f-99', 'wiki', 'md')] }
  const ctx = makeCtx({ tree, exported: { ...EXPORTED, 'f-99': body } })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationKnowledgeTools(deps)[0].execute(
    { caseDir: CASE_DIR, wikiPaths: [WIKI_PATH], ...args },
    execOf(sessionId),
  )
  return { ctx, result }
}

/** 落盘的规则记录：在案例目录下的 JSON 里找含本规则的那一份。 */
function persistedRules(ctx) {
  for (const [path, body] of ctx.files) {
    if (!path.startsWith(`${CASE_DIR}/`) || !path.endsWith('.json')) continue
    let doc
    try { doc = JSON.parse(body) } catch { continue }
    const nested = doc?.ruleParameters
    const list = Array.isArray(doc?.parameters)
      ? doc.parameters
      : (Array.isArray(nested?.parameters) ? nested.parameters : null)
    if (list !== null && list.some((item) => item?.ruleId === 'R-RATE-1')) return { path, doc, list }
  }
  return null
}

/**
 * Second Wiki document in the same folder, used to exercise multi-document parameter collection.
 */
const WIKI_PATH_2 = '01 估值与测算/01 房地产/wiki2.md'

function multiWikiTree() {
  return { ...TREE, 'f-02': [...TREE['f-02'], DOC('f-99', 'wiki', 'md'), DOC('f-98', 'wiki2', 'md')] }
}

/** Materialize one or two Wiki documents in a single call and resolve stage=parameters. */
async function materializeWikiDocs({ bodies, args = {}, makeCtxOptions = {} } = {}) {
  const exported = { ...EXPORTED }
  if (bodies.wiki !== undefined) exported['f-99'] = bodies.wiki
  if (bodies.wiki2 !== undefined) exported['f-98'] = bodies.wiki2
  const ctx = makeCtx({ tree: multiWikiTree(), exported, ...makeCtxOptions })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const wikiPaths = bodies.wiki2 === undefined ? [WIKI_PATH] : [WIKI_PATH, WIKI_PATH_2]
  const result = await valuationKnowledgeTools(deps)[0].execute(
    { caseDir: CASE_DIR, wikiPaths, ...args },
    execOf(sessionId),
  )
  return { ctx, result }
}

test('stage=parameters：索引写完后正文被改动 → 不绑定旧摘要，参数为空', async () => {
  const original = wikiRuleBody()
  const mutated = `${original}\n被追加的内容\n`
  const { ctx, result } = await materializeWikiDocs({
    bodies: { wiki: original },
    args: { stage: 'parameters' },
    makeCtxOptions: {
      afterWrite: (key, files) => {
        if (!key.endsWith(KNOWLEDGE_INDEX_FILE)) return
        for (const path of [...files.keys()]) {
          if (path.startsWith(`${CASE_DIR}/`) && path.endsWith('wiki.md')) files.set(path, mutated)
        }
      },
    },
  })

  assert.equal(result.states[0].state, 'found', '正文读取本身照常成功')
  assert.equal(result.ruleParameters.ok, false,
    '正文字节与索引记录的摘要有出入时，不得按旧摘要绑定参数')
  assert.equal(result.ruleParameters.errorKind, 'digest-mismatch')
  assert.deepEqual(result.ruleParameters.parameters, [])
  assert.equal(persistedRules(ctx), null, '正文不可核对时不得写出成功规则记录')
})

test('stage=parameters：有效规则 + 不安全正文 → 整批拒绝，不挑有效那份', async () => {
  const valid = wikiRuleBody()
  const unsafe = wikiRuleBody({
    fragment: { routeId: `wiki:${WIKI_PATH_2}` },
    parameter: { sourceRef: 'https://example.invalid/rule' },
  })
  const { result } = await materializeWikiDocs({
    bodies: { wiki: valid, wiki2: unsafe },
    args: { stage: 'parameters' },
  })

  assert.equal(result.entries.length, 2, '两份正文都取到了')
  assert.equal(result.ruleParameters.ok, false, '存在不安全规则段时不得挑出有效那份')
  assert.equal(result.ruleParameters.errorKind, 'unsafe-content')
  assert.deepEqual(result.ruleParameters.parameters, [])
})

test('stage=parameters：多份正文都没有规则段 → 普通 Wiki 读取照常，参数为空缺口', async () => {
  const { result } = await materializeWikiDocs({
    bodies: {
      wiki: '# 房地产估值 Wiki\n\n只有自然语言。\n',
      wiki2: '# 第二份\n\n也没有结构化规则段。\n',
    },
    args: { stage: 'parameters' },
  })

  assert.deepEqual(result.states.map((item) => item.state), ['found', 'found'])
  assert.equal(result.entries.length, 2)
  assert.equal(result.ruleParameters.ok, false)
  assert.equal(result.ruleParameters.errorKind, 'missing')
  assert.deepEqual(result.ruleParameters.parameters, [])
})

test('stage=parameters：显式写错 routeId → invalid，参数为空且不落记录', async () => {
  const { ctx, result } = await materializeWikiDocs({
    bodies: { wiki: wikiRuleBody({ fragment: { routeId: 'wiki:别的/路径.md' } }) },
    args: { stage: 'parameters' },
  })

  assert.equal(result.ruleParameters.ok, false)
  assert.equal(result.ruleParameters.errorKind, 'invalid')
  assert.deepEqual(result.ruleParameters.parameters, [])
  assert.equal(persistedRules(ctx), null)
})

test('stage=parameters：解析已落盘正文的结构化规则，摘要绑定到实际正文指纹', async () => {
  const body = wikiRuleBody()
  const { ctx, result } = await materializeWiki(body, { stage: 'parameters' })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.states[0].state, 'found')
  const expected = knowledgeDigest(body)
  assert.equal(result.entries[0].digest, expected, '规则段解析用的就是这份已落盘正文')

  assert.equal(result.ruleParameters.ok, true, result.ruleParameters.error)
  assert.equal(result.ruleParameters.snapshotDigest, expected,
    '规则段省略 snapshotDigest 时，Host 把它绑定到实际正文哈希')
  const rule = result.ruleParameters.parameters.find((item) => item.ruleId === 'R-RATE-1')
  assert.ok(rule !== undefined, '要带回结构化参数，而不是自然语言')
  assert.equal(rule.value, '0.09', '规则值逐字带回，不由程序补默认值')
  assert.equal(rule.valueKind, 'rate')
  assert.deepEqual(result.ruleParameters.gaps, [])
  // 模型可见结果里仍然没有原始脚本 / URL 面。
  assert.equal(/https?:\/\//.test(JSON.stringify(result.ruleParameters)), false)

  const record = persistedRules(ctx)
  assert.ok(record !== null, '规则记录要持久化，供后续计算核对')
  const persistedDigest = typeof record.doc.snapshotDigest === 'string'
    ? record.doc.snapshotDigest
    : record.doc.ruleParameters?.snapshotDigest
  assert.equal(persistedDigest, expected)
  assert.equal(record.list.find((item) => item.ruleId === 'R-RATE-1').value, '0.09')
})

test('stage=parameters：显式不匹配的 snapshotDigest 仍必须整段不认', async () => {
  const body = wikiRuleBody({ fragment: { snapshotDigest: `sha256:${'f'.repeat(64)}` } })
  const { result } = await materializeWiki(body, { stage: 'parameters' })

  assert.equal(result.states[0].state, 'found', '正文读取不被规则解析拖垮')
  assert.equal(result.ruleParameters.ok, false)
  assert.equal(result.ruleParameters.errorKind, 'digest-mismatch')
  assert.deepEqual(result.ruleParameters.parameters, [])
})

test('stage=parameters：缺结构化规则段 → 缺口，但普通 Wiki 读取照常成功', async () => {
  const body = ['# 房地产估值 Wiki', '', '只有自然语言，没有结构化段。', ''].join('\n')
  const { ctx, result } = await materializeWiki(body, { stage: 'parameters' })

  assert.equal(result.states[0].state, 'found')
  assert.equal(result.entries.length, 1)
  assert.equal(snapshotBodies(ctx).length, 1, '正文照常落盘：缺规则不阻断普通读取')
  assert.equal(result.ruleParameters.ok, false)
  assert.equal(result.ruleParameters.errorKind, 'missing')
  assert.deepEqual(result.ruleParameters.parameters, [])
})

test('stage=parameters：可执行 / URL 内容 → unsafe-content，参数为空', async () => {
  const body = wikiRuleBody({ parameter: { sourceRef: 'https://example.invalid/rule' } })
  const { result } = await materializeWiki(body, { stage: 'parameters' })

  assert.equal(result.ruleParameters.ok, false)
  assert.equal(result.ruleParameters.errorKind, 'unsafe-content')
  assert.deepEqual(result.ruleParameters.parameters, [])
})

test('stage=parameters：同一份正文两段规则 → ambiguous（不选第一段）', async () => {
  const body = `${wikiRuleBody()}\n${wikiRuleBody({ fragment: { sectionId: 'S-other' } })}`
  const { result } = await materializeWiki(body, { stage: 'parameters' })

  assert.equal(result.ruleParameters.ok, false)
  assert.equal(result.ruleParameters.errorKind, 'ambiguous')
  assert.deepEqual(result.ruleParameters.parameters, [])
})

// ── Repeat materialization / cumulative index / partial failure ───────────────
//
// Field symptom: a second, `stage=parameters` read of the same entry Wiki hit LOCAL_FILE_EXISTS,
// and the failure path overwrote the aggregate index with an empty one, erasing known sources.
// These cases pin "no overwrite on export", "cumulative index" and "partial failure keeps data".

/** Absolute aggregate index path (`知识快照/.知识来源.json`). */
function aggregateIndexPath() {
  return `${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/${KNOWLEDGE_INDEX_FILE}`
}

/** Read the aggregate index currently on disk. */
function readAggregateIndex(ctx) {
  const key = [...ctx.files.keys()].find((path) => path.endsWith(KNOWLEDGE_INDEX_FILE))
  assert.ok(key !== undefined, `没有汇总索引：${[...ctx.files.keys()].join('、')}`)
  return JSON.parse(ctx.files.get(key))
}

/** Content acquisition commands (export or download) issued for one node in a materialization. */
function exportCount(ctx, nodeId) {
  return ctx.commands.filter((command) => (
    (command.includes('+export') || command.includes('+download')) && argAfter(command, '--node') === nodeId
  )).length
}

test('重复取同一已物化 wikiPath：复用已验真快照，不再导出，也不报 LOCAL_FILE_EXISTS', async () => {
  const body = wikiRuleBody()
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': body },
    refuseExistingExport: true,
  })

  const first = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.entries.length, 1)
  const firstDigest = first.entries[0].digest
  assert.equal(exportCount(ctx, 'f-99'), 1)

  // Second call with stage=parameters on the same path: reuse verified bytes, never export again.
  const second = await materialize(ctx, { wikiPaths: [WIKI_PATH], stage: 'parameters' })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.entries.length, 1, '同一路径必须从已验真快照复读出正文')
  assert.equal(second.entries[0].digest, firstDigest, '复用的是同一份已验真正文，指纹不变')
  assert.equal(exportCount(ctx, 'f-99'), 1, '已物化同一路径第二次读取不得再导出')

  assert.equal(second.ruleParameters.ok, true, second.ruleParameters.error)
  const rule = second.ruleParameters.parameters.find((item) => item.ruleId === 'R-RATE-1')
  assert.ok(rule !== undefined, '已验真快照上的规则参数必须照常解析出来')
  assert.equal(rule.value, '0.09')
})

test('复用前逐字节校验：已物化正文被改动 → 不得按旧摘要/旧参数接受', async () => {
  const body = wikiRuleBody()
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': body },
    refuseExistingExport: true,
  })
  const first = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(first.ok, true, first.error)

  // Change the persisted body while the index digest stays: reuse must re-hash and fail closed.
  const snapshotKey = [...ctx.files.keys()].find(
    (path) => path.startsWith(`${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/`) && path.endsWith('wiki.md'),
  )
  assert.ok(snapshotKey !== undefined)
  ctx.files.set(snapshotKey, `${body}\n被追加的内容\n`)

  const second = await materialize(ctx, { wikiPaths: [WIKI_PATH], stage: 'parameters' })
  assert.equal(second.ruleParameters.ok, false, '正文与索引摘要不符时不得复用旧参数')
  assert.deepEqual(second.ruleParameters.parameters, [])
  assert.equal(persistedRules(ctx), null, '正文不可核对时不得写出成功规则记录')
})

test('没有结构化规则段：普通 Wiki 读取照常复用，参数缺口如实为空', async () => {
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': '# A\n只有自然语言，没有 JSON 规则段。\n' },
    refuseExistingExport: true,
  })
  const first = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(first.ok, true, first.error)

  const second = await materialize(ctx, { wikiPaths: [WIKI_PATH], stage: 'parameters' })
  assert.equal(second.entries.length, 1, '没有 JSON 不等于没有正文：普通读取要照常复用')
  assert.equal(exportCount(ctx, 'f-99'), 1, '复用同一路径不得再导出')
  assert.equal(second.ruleParameters.ok, false)
  assert.equal(second.ruleParameters.errorKind, 'missing')
  assert.deepEqual(second.ruleParameters.parameters, [], '没有规则段不得编造参数')
})

test('累积索引：先后取 A、B 两条 wikiPath，汇总索引同时保留 A 与 B', async () => {
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': '# A\n正文 A。\n', 'f-98': '# B\n正文 B。\n' },
  })
  const first = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(first.ok, true, first.error)
  const second = await materialize(ctx, { wikiPaths: [WIKI_PATH_2] })
  assert.equal(second.ok, true, second.error)

  const aggregate = readAggregateIndex(ctx)
  const routeIds = new Set(aggregate.routeIds)
  assert.equal(routeIds.has(`wiki:${WIKI_PATH}`), true, '先取的 A 仍要在汇总索引里')
  assert.equal(routeIds.has(`wiki:${WIKI_PATH_2}`), true, '后取的 B 也要在汇总索引里')

  const snapshots = aggregate.entries.map((entry) => entry.snapshotFile)
  assert.equal(snapshots.some((path) => path.endsWith('wiki.md')), true, 'A 的条目不得被后续刷新抹掉')
  assert.equal(snapshots.some((path) => path.endsWith('wiki2.md')), true, 'B 的条目要落到同一份索引里')
})

test('局部失败刷新：不清空既有良好条目，新失败单独回报', async () => {
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': '# A\n正文 A。\n', 'f-98': '# B\n正文 B。\n' },
  })
  const first = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(first.ok, true, first.error)

  // The knowledge base becomes unreachable on the second refresh: prior good source A must survive.
  ctx.control.dwsFails = true
  const second = await materialize(ctx, { wikiPaths: [WIKI_PATH_2] })

  const aggregate = readAggregateIndex(ctx)
  assert.equal(new Set(aggregate.routeIds).has(`wiki:${WIKI_PATH}`), true,
    '刷新失败不得把已知来源从汇总索引里抹掉')
  assert.equal(aggregate.entries.some((entry) => entry.routeId === `wiki:${WIKI_PATH_2}`), false,
    '失败的 B 没有被取到，不得假装有来源')

  // The new failure must be reported separately, not masked by a blanket ok.
  assert.equal(
    second.states.some((state) => state.routeId === `wiki:${WIKI_PATH_2}` && state.state !== 'found'),
    true,
  )
  assert.equal(second.failures.length > 0 || second.capabilityGaps.length > 0, true)
})

test('既有汇总索引损坏：显式报错，不发起 dws，也不重置索引', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n正文 A。\n' } })
  const indexKey = aggregateIndexPath()
  ctx.files.set(indexKey, '{ this is not json')

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })

  assert.equal(result.ok, false)
  assert.match(result.error, /索引|JSON|解析|损坏/)
  assert.deepEqual(dwsCommands(ctx), [], '索引不可用时不得发起任何 dws 取数')
  assert.equal(ctx.files.get(indexKey), '{ this is not json', '不得重置/覆盖已损坏的索引')
})

test('无效 wikiPath 在任何 dws I/O 之前被拒', async () => {
  for (const wikiPath of ['/绝对路径.md', '01 估值与测算/../../逃逸.md', '01 估值与测算/01 房地产/脚本.exe', 'f-99']) {
    const ctx = makeCtx({ tree: multiWikiTree() })
    const result = await materialize(ctx, { wikiPaths: [wikiPath] })
    assert.equal(result.ok, false, `wikiPath=${wikiPath} 必须被拒`)
    assert.equal(result.errorKind, 'input', `wikiPath=${wikiPath} 应报 input`)
    assert.deepEqual(dwsCommands(ctx), [], `wikiPath=${wikiPath} 不得发起 dws I/O`)
  }
})

test('非本轮估值会话：在发起任何 dws 之前被拒', async () => {
  const ctx = makeCtx({ tree: multiWikiTree() })
  const { deps } = makeDeps({ ctx })
  openValuation(deps)
  const result = await valuationKnowledgeTools(deps)[0].execute(
    { caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] }, execOf('随便一条会话'),
  )

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.deepEqual(dwsCommands(ctx), [])
})

test('既有汇总索引属于别的项目：policy，不取数、不覆盖', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n正文 A。\n' } })
  const indexKey = aggregateIndexPath()
  const foreign = {
    schema: 'crwu.valuation.knowledge.v1',
    projectId: '别的项目',
    planId: null,
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
    spaceVerified: true,
    entries: [],
    routes: [],
    routeIds: [],
  }
  ctx.files.set(indexKey, JSON.stringify(foreign))

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.deepEqual(dwsCommands(ctx), [], '项目不一致时不得发起任何 dws 取数')
  assert.equal(JSON.parse(ctx.files.get(indexKey)).projectId, '别的项目', '不得覆盖别的项目的索引')
})

test('模板先物化、知识后物化：汇总索引同时保留模板与知识条目', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n正文 A。\n' } })
  const templateBytes = 'xlsx-bytes'
  const templateSnapshot = 'method.market.template/01 市场法计算表模板-住宅.xlsx'
  const templateDigest = knowledgeDigest(templateBytes)
  const templateEntry = {
    routeId: 'method.market.template',
    nodeName: '01 市场法计算表模板-住宅.xlsx',
    resolvedPath: '01 估值与测算/01 房地产/05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx',
    source: 'dws',
    digest: templateDigest,
    sizeBytes: templateBytes.length,
    snapshotFile: templateSnapshot,
    mediaType: '',
    updatedAt: '2026-10-01T00:00:00.000Z',
    bodyNonEmpty: true,
    channel: 'exact-route',
    sectionIds: [],
    ruleIds: [],
    templateId: 'method.market.template',
    templateContractVersion: null,
    templateVerified: true,
  }
  ctx.files.set(aggregateIndexPath(), JSON.stringify({
    schema: 'crwu.valuation.knowledge.v1',
    projectId: VALUATION_ID,
    planId: null,
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
    spaceVerified: true,
    manifestDigest: `sha256:${'0'.repeat(64)}`,
    availableRouteIds: ['method.market.template'],
    routeIds: ['method.market.template'],
    digest: knowledgeSnapshotDigest([templateEntry]),
    materializedAt: '2026-10-01T00:00:00.000Z',
    routes: [{
      routeId: 'method.market.template', state: 'found', nodeName: templateEntry.nodeName,
      source: 'dws', digest: templateDigest, snapshotFile: templateSnapshot, error: '',
    }],
    entries: [templateEntry],
    lookupAttempts: [],
    capabilityGaps: [],
    ok: true,
  }))

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(result.ok, true, result.error)

  const aggregate = readAggregateIndex(ctx)
  const routeIds = new Set(aggregate.routeIds)
  assert.equal(routeIds.has('method.market.template'), true, '模板条目不得被知识刷新抹掉')
  assert.equal(routeIds.has(`wiki:${WIKI_PATH}`), true, '知识条目要与模板条目并存')
  assert.equal(aggregate.entries.some((entry) => entry.routeId === 'method.market.template'), true)
  assert.equal(aggregate.entries.some((entry) => entry.routeId === `wiki:${WIKI_PATH}`), true)
})

test('已物化正文损坏后重取：聚合索引保留先前来源元数据，当前路由如实 unreadable', async () => {
  const body = wikiRuleBody()
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': body }, refuseExistingExport: true })
  const first = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(first.ok, true, first.error)
  const firstDigest = first.entries[0].digest

  const snapshotKey = [...ctx.files.keys()].find(
    (path) => path.startsWith(`${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/`) && path.endsWith('wiki.md'),
  )
  assert.ok(snapshotKey !== undefined)
  ctx.files.set(snapshotKey, `${body}\n被追加的内容\n`)

  const second = await materialize(ctx, { wikiPaths: [WIKI_PATH], stage: 'parameters' })
  assert.equal(second.entries.length, 0, '损坏的正文不得作为当前条目')
  assert.equal(second.states[0].state, 'unreadable')
  assert.equal(second.ruleParameters.ok, false)

  const aggregate = readAggregateIndex(ctx)
  const retained = aggregate.entries.find((entry) => entry.routeId === `wiki:${WIKI_PATH}`)
  assert.ok(retained !== undefined, '失败刷新必须保留先前来源元数据供审计')
  assert.equal(retained.digest, firstDigest, '保留的是先前记录的元数据，不是新取内容')
  const route = aggregate.routes.find((item) => item.routeId === `wiki:${WIKI_PATH}`)
  assert.equal(route.state, 'unreadable', '当前失败路由不得被标成 found')
})

test('既有汇总索引条目缺少 digest：invalid，不取数、不覆盖', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n' } })
  const indexKey = aggregateIndexPath()
  const malformed = JSON.stringify({
    schema: 'crwu.valuation.knowledge.v1',
    projectId: VALUATION_ID,
    planId: null,
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
    spaceVerified: true,
    entries: [{
      routeId: `wiki:${WIKI_PATH}`,
      nodeName: 'wiki.md',
      resolvedPath: WIKI_PATH,
      source: 'dws',
      digest: '',
      snapshotFile: 'wiki_a_b.md/wiki.md',
    }],
    routes: [],
    routeIds: [`wiki:${WIKI_PATH}`],
  })
  ctx.files.set(indexKey, malformed)

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /索引|条目|digest/)
  assert.deepEqual(dwsCommands(ctx), [], '结构错误时不得发起任何 dws 取数')
  assert.equal(ctx.files.get(indexKey), malformed, '不得覆盖结构错误的索引')
})

test('既有汇总索引两个路由共用同一落点：invalid，不取数、不覆盖', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n' } })
  const indexKey = aggregateIndexPath()
  const shared = 'wiki_shared/wiki.md'
  const entry = (routeId) => ({
    routeId, nodeName: 'wiki.md', resolvedPath: `${routeId.slice(5)}`, source: 'dws',
    digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 3, snapshotFile: shared,
  })
  const malformed = JSON.stringify({
    schema: 'crwu.valuation.knowledge.v1',
    projectId: VALUATION_ID,
    planId: null,
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
    spaceVerified: true,
    entries: [entry('wiki:one.md'), entry('wiki:two.md')],
    routes: [],
    routeIds: ['wiki:one.md', 'wiki:two.md'],
  })
  ctx.files.set(indexKey, malformed)

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /索引|落点|冲突|共用/)
  assert.deepEqual(dwsCommands(ctx), [])
  assert.equal(ctx.files.get(indexKey), malformed)
})

test('既有汇总索引逃出知识快照目录：拒绝且不取数、不覆盖', async () => {
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': '# A\n' },
    contains: () => false,
  })
  const indexKey = aggregateIndexPath()
  const valid = JSON.stringify({
    schema: 'crwu.valuation.knowledge.v1',
    projectId: VALUATION_ID,
    planId: null,
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
    spaceVerified: true,
    entries: [],
    routes: [],
    routeIds: [],
  })
  ctx.files.set(indexKey, valid)

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /索引|目录|快照/)
  assert.deepEqual(dwsCommands(ctx), [], '索引逃出目录时不得发起任何 dws 取数')
  assert.equal(ctx.files.get(indexKey), valid, '不得覆盖逃出目录的索引')
})

test('已物化快照落点逃出知识快照目录：目标检查 fail closed，不下载、不落盘', async () => {
  const body = wikiRuleBody()
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': body },
    refuseExistingExport: true,
    contains: (_parent, child) => !String(child.displayPath).endsWith('wiki.md'),
  })
  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })

  assert.equal(result.entries.length, 0, '落点越界时不得写入任何条目')
  assert.equal(result.states[0].state, 'unreadable')
  assert.equal(exportCount(ctx, 'f-99'), 0, '目标越界时不得发起取数')
  assert.deepEqual(snapshotBodies(ctx).filter((path) => path.endsWith('wiki.md')), [])
})

// ── Root boundary and catalog reuse ─────────────────────────────────────────

/** Business-library traversal commands (space-list + node-list). */
function treeCount(ctx) {
  return ctx.commands.filter((command) => command.includes('+space-list') || command.includes('+node-list')).length
}

/** One valid aggregate with no entries, for boundary preflight cases. */
function emptyIndex() {
  return JSON.stringify({
    schema: 'crwu.valuation.knowledge.v1',
    projectId: VALUATION_ID,
    planId: null,
    spaceName: VALUATION_KNOWLEDGE_SPACE,
    expectedSpaceName: VALUATION_KNOWLEDGE_SPACE,
    spaceVerified: true,
    entries: [],
    routes: [],
    routeIds: [],
  })
}

test('知识快照根逃出本轮案例：拒绝且不取数、不覆盖索引', async () => {
  const knowledgeDir = `${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}`
  const ctx = makeCtx({
    tree: multiWikiTree(),
    exported: { ...EXPORTED, 'f-99': '# A\n' },
    // The snapshot root itself is outside the exact owned case, even though it "contains" the index.
    contains: (parent, child) => !(String(parent.displayPath) === CASE_DIR && String(child.displayPath) === knowledgeDir),
  })
  const indexKey = aggregateIndexPath()
  const valid = emptyIndex()
  ctx.files.set(indexKey, valid)

  const result = await materialize(ctx, { wikiPaths: [WIKI_PATH] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /索引|目录|案例/)
  assert.deepEqual(dwsCommands(ctx), [], '快照根越界时不得发起任何 dws 取数')
  assert.equal(ctx.files.get(indexKey), valid, '不得覆盖越界索引')
})

test('同一轮目录树只读一次：A/B/重读复用已验证目录', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n', 'f-98': '# B\n' } })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const tool = valuationKnowledgeTools(deps)[0]

  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] }, execOf(sessionId))
  const afterA = treeCount(ctx)
  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH_2] }, execOf(sessionId))
  const afterB = treeCount(ctx)
  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] }, execOf(sessionId))
  const afterReread = treeCount(ctx)

  assert.equal(afterA > 0, true, '第一次必须真的遍历目录树')
  assert.equal(afterB, afterA, '同一轮第二条路径不得重新遍历目录树')
  assert.equal(afterReread, afterA, '重读同一条路径也不得重新遍历目录树')
})

test('已关闭/重开的轮次不共享目录缓存', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n', 'f-98': '# B\n' } })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const tool = valuationKnowledgeTools(deps)[0]

  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] }, execOf(sessionId))
  const afterFirst = treeCount(ctx)
  // Reopen the same round with a new lifetime: the cache key changes.
  const scope = deps.valuationScopes.get(VALUATION_ID)
  deps.valuationScopes.open({ ...scope, openedAt: 2 })
  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH_2] }, execOf(sessionId))

  assert.equal(treeCount(ctx) > afterFirst, true, '重开一轮必须重新遍历目录树')
})

test('失败的目录读取不进缓存：恢复后仍会重读', async () => {
  const ctx = makeCtx({ tree: multiWikiTree(), exported: { ...EXPORTED, 'f-99': '# A\n' }, dwsFails: true })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const tool = valuationKnowledgeTools(deps)[0]

  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] }, execOf(sessionId))
  const afterFail = treeCount(ctx)
  ctx.control.dwsFails = false
  await tool.execute({ caseDir: CASE_DIR, wikiPaths: [WIKI_PATH] }, execOf(sessionId))

  assert.equal(afterFail > 0, true, '失败时也要真的尝试过遍历')
  assert.equal(treeCount(ctx) > afterFail, true, '失败结果不得被缓存')
})

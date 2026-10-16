/**
 * `crwu_valuation_template_materialize` 的**工具接线**测试。
 *
 * 字节验真的纯函数层在 `host-valuation-template.test.mjs` 里覆盖；这里钉的是接线，
 * 专挑最容易静默出错的那几条：
 *
 * 1. **来源只有 manifest 一处**：`methods.<方法>.template` 为 `null` 就是"该方法还没有模板"，
 *    如实报缺口 —— 不拿别的方法的模板顶替，也不按物业类型猜一份。
 * 2. **下载到的不是 xlsx**（HTML 错误页 / 登录页 / 空字节）必须拦在这里，不能落进案例目录
 *    冒充"模板到手了"。
 * 3. **字节真的落盘**才算数（"下载命令成功"不是证据）。
 * 4. 非估值会话不能把模板写进案例目录。
 *
 * 全部替身都是内存实现：不碰真实知识库、凭据、网络。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { valuationTemplateTools } = await import(new URL('src/host/tools/report-evaluation/template.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)
const { KNOWLEDGE_MANIFEST_FILE } = await import(new URL('src/host/tools/report-evaluation/catalog.ts', ROOT).href)
const { KNOWLEDGE_SNAPSHOT_DIR, VALUATION_KNOWLEDGE_SPACE, knowledgeDigest } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-170000-cc33'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const KNOWLEDGE_DIR = `${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}`
const TEMPLATE_ROUTE = 'method.market.template'
const MANIFEST_PATH = '01 估值与测算/01 房地产/00-知识目录与必需项'

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
  valuation: { knowledge: { mirrorRoot: '', manifestPath: MANIFEST_PATH } },
}

const FOLDER = (nodeId, name) => ({ nodeId, name, type: 'FOLDER', extension: '' })
const DOC = (nodeId, name, extension) => ({ nodeId, name, type: 'FILE', extension, updatedAt: '2026-10-01T00:00:00.000Z' })

const MANIFEST_NODE = '00-知识目录与必需项'
const TEMPLATE_NODE = '01 市场法计算表模板-住宅'

const TREE = {
  '': [FOLDER('f-01', '01 估值与测算')],
  'f-01': [FOLDER('f-02', '01 房地产')],
  'f-02': [
    FOLDER('f-03', '02 估值方法'),
    FOLDER('f-05', '05 计算表模板'),
    DOC('f-10', MANIFEST_NODE, 'adoc'),
  ],
  'f-03': [DOC('f-12', '02-市场法', 'md')],
  'f-05': [FOLDER('f-51', '01 市场法')],
  'f-51': [DOC('f-52', TEMPLATE_NODE, 'xlsx')],
}

/**
 * manifest 正文。`income` / `cost` 的模板是 `null`：**"还没有模板"是库侧事实**，
 * 不是一条待修的错误 —— 工具只能如实回报，不能替它挑一份。
 */
function manifestBody({ incomeTemplate = null } = {}) {
  return [
    '# 知识目录与必需项',
    '',
    '```json',
    JSON.stringify({
      version: 1,
      methodSelection: '01 房地产估值通用',
      methods: {
        market: { guide: '02 估值方法/02-市场法.md', template: '05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx' },
        income: { guide: null, template: incomeTemplate },
        cost: { guide: null, template: null },
      },
    }, null, 2),
    '```',
    '',
  ].join('\n')
}

function argAfter(command, flag) {
  const raw = String(command)
  const quoted = new RegExp(`${flag}\\s+'((?:[^']|'\\\\'')*)'`).exec(raw)
  if (quoted !== null) return String(quoted[1]).replace(/'\\''/g, "'")
  const parts = raw.split(/\s+/)
  const index = parts.indexOf(flag)
  if (index < 0) return ''
  return String(parts[index + 1] ?? '').replace(/^'(.*)'$/s, '$1').replace(/'\\''/g, "'")
}

const PKG_BIN_DIR = new URL('bin/darwin-arm64/', ROOT).pathname.replace(/\/$/, '')

/** 一份最小的 ZIP/xlsx 魔数负载（验真只看非空与前四字节）。 */
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
/** 网关改写的 HTML 错误页 / 登录页。 */
const HTML_BYTES = new TextEncoder().encode('<!doctype html><html><body>请先登录</body></html>')

function makeCtx({ templateBytes = XLSX_BYTES, manifest = manifestBody(), tree = TREE, refuseExistingOutput = false, contains = null } = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR, KNOWLEDGE_DIR])
  const files = new Map(['crwu', 'dws', 'ossutil'].map((name) => [`${PKG_BIN_DIR}/${name}`, 'binary']))
  const binaries = new Map()
  const commands = []

  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      if (binaries.has(target.targetKey)) return { type: 'file', size: String(binaries.get(target.targetKey).length), version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey).length), version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async readBytes(target) {
      const bytes = binaries.get(target.targetKey)
      if (bytes === undefined) throw new Error(`no such file: ${String(target.targetKey)}`)
      return bytes
    },
    async writeText(target, content) { files.set(target.targetKey, content); return { operation: 'create', version: 'v' } },
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
        // Real `dws` refuses to overwrite an existing output with LOCAL_FILE_EXISTS; mirror that
        // so a repeated fetch of the same destination cannot pass silently.
        if (refuseExistingOutput && (binaries.has(target) || files.has(target))) {
          return {
            result: async () => ({
              exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: '', truncated: false },
              stderr: { text: 'dws: LOCAL_FILE_EXISTS: 输出文件已存在，拒绝覆盖', truncated: false },
            }),
          }
        }
        if (node === 'f-52') {
          binaries.set(target, templateBytes)
          files.set(target, 'downloaded')
        } else {
          files.set(target, manifest)
        }
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
    directories, files, binaries, commands,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellService
      return undefined
    },
  }
}

function makeDeps({ ctx = makeCtx() } = {}) {
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
      ctx, config: CONFIG, state, access,
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
    name: VALUATION_TOOL_NAMES.templateMaterialize, arguments: {},
    signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

const ARGS = { caseDir: CASE_DIR, method: 'market' }

/** `知识快照/` 下落的模板字节。 */
function landedBytes(ctx) {
  return [...ctx.binaries.keys()].filter((path) => path.startsWith(`${KNOWLEDGE_DIR}/`))
}

test('模板工具在注册清单里，且不进审核必需集', () => {
  assert.equal(VALUATION_TOOL_NAMES.templateMaterialize, 'crwu_valuation_template_materialize')
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_template_materialize'), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_valuation_template_materialize'), false)
})

test('参数面：按**已确定**的方法取模板，显式 wikiPath 是库内相对路径，不是命令/文件系统面', () => {
  const { deps } = makeDeps()
  const tool = valuationTemplateTools(deps)[0]
  const keys = Object.keys(tool.parameters.properties ?? tool.parameters).sort()
  // 显式 `wikiPath`（单条库内相对路径）是新增的可选来源通道；method 仍然必填。
  assert.deepEqual(keys, ['caseDir', 'method', 'planId', 'spaceName', 'wikiPath'])
  const schema = JSON.stringify(tool.parameters)
  for (const forbidden of ['propertyType', 'nodeId', 'command', 'argv', 'url', 'mirror']) {
    assert.equal(schema.includes(forbidden), false, `参数面不许出现 ${forbidden}`)
  }
})

test('方法必须已确定：auto / 空 / 未知方法都在任何 I/O 之前被拒', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  for (const method of ['auto', '', 'whatever']) {
    const result = await valuationTemplateTools(deps)[0].execute({ ...ARGS, method }, execOf(sessionId))
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'input')
    assert.match(result.error, /已\*\*确定\*\*的方法|已确定/)
  }
  assert.deepEqual(landedBytes(ctx), [])
})

test('manifest 读不到 → capability-gap（唯一真停），不猜一份模板', async () => {
  // 导出成功但产物是空的：manifest 就是没拿到。
  const { deps } = makeDeps({ ctx: makeCtx({ manifest: '' }) })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(ARGS, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /唯一真停/)
  assert.equal(result.snapshotFile, '')
})

test('manifest 没为该方法声明模板（null）→ 如实说"该方法还没有模板"，不拿市场法的顶替', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute({ ...ARGS, method: 'income' }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(result.routeId, 'method.income.template')
  assert.match(result.error, /还没有模板/)
  assert.equal(result.availableRouteIds.includes(TEMPLATE_ROUTE), true, '要把本库声明了哪些槽位说清')
  // 一条字节都没下载：市场法模板没有被拿来顶替。
  assert.equal(ctx.commands.some((command) => command.includes('+download')), false)
  assert.deepEqual(landedBytes(ctx), [])
})

test('已发布口径：按 manifest 取回模板字节，落盘并回报指纹/字节数', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(ARGS, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.method, 'market')
  assert.equal(result.routeId, TEMPLATE_ROUTE)
  assert.equal(result.nodeName, `${TEMPLATE_NODE}.xlsx`)
  assert.equal(result.source, 'dws')
  assert.equal(result.spaceName, VALUATION_KNOWLEDGE_SPACE)
  assert.equal(result.spaceVerified, true)
  assert.equal(result.sizeBytes, XLSX_BYTES.length)
  assert.equal(result.digest, knowledgeDigest(XLSX_BYTES))
  assert.equal(result.snapshotFile, `${TEMPLATE_ROUTE}/${TEMPLATE_NODE}.xlsx`)
  assert.match(result.manifestDigest, /^sha256:[0-9a-f]{64}$/)

  // 字节**真的**落在案例目录的 知识快照/ 下（"下载命令成功"不是证据）。
  assert.deepEqual(landedBytes(ctx), [`${KNOWLEDGE_DIR}/${TEMPLATE_ROUTE}/${TEMPLATE_NODE}.xlsx`])
  // 模型可见结果里没有 nodeId / 绝对路径 / 命令。
  const visible = JSON.stringify(result)
  assert.equal(visible.includes('nodeId'), false)
  assert.equal(visible.includes('f-52'), false)
  assert.equal(visible.includes('dws '), false)
})

test('下载到的不是 xlsx（登录页/错误页）→ 拒绝，并点明不要按工作簿打开', async () => {
  const { deps } = makeDeps({ ctx: makeCtx({ templateBytes: HTML_BYTES }) })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(ARGS, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match([result.error, ...result.capabilityGaps].join('；'), /ZIP\/xlsx|不是 ZIP/)
  assert.match([result.error, ...result.capabilityGaps].join('；'), /不要按工作簿打开/)
  // 关键：没有一条"已验真的模板"被交出去。
  assert.equal(result.snapshotFile, '')
  assert.equal(result.digest, '')
  assert.equal(result.sizeBytes, 0)
})

test('空字节 → 拒绝：0 字节不是一份可用的工作簿', async () => {
  const { deps } = makeDeps({ ctx: makeCtx({ templateBytes: new Uint8Array(0) }) })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(ARGS, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.match([result.error, ...result.capabilityGaps].join('；'), /0 字节/)
  assert.equal(result.snapshotFile, '')
})

test('非估值会话不能把模板写进案例目录', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(ARGS, execOf('随便一条会话'))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.deepEqual(landedBytes(ctx), [])
  assert.equal(ctx.commands.some((command) => command.includes('+download')), false)
})

test('manifest 自己那一份被留档：能回答"当时按哪一版清单取的模板"', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(ARGS, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.equal(ctx.files.has(`${KNOWLEDGE_DIR}/${KNOWLEDGE_MANIFEST_FILE}`), true)
})

// ── Explicit wikiPath: bypass an obsolete manifest slot ──────────────────────
//
// Field symptom: the manifest entry was stale/unreadable while the xlsx still exists in the
// same business knowledge base. An explicit wiki-relative path must fetch and verify that file
// directly, never stopping at the manifest.

/** Explicit template path (wiki-relative, posix); targets fixture node `f-52` verbatim. */
const TEMPLATE_WIKI_PATH = '01 估值与测算/01 房地产/05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx'

/** Commands that actually fetch content (directory setup and path probes excluded). */
function fetchCommands(ctx) {
  return ctx.commands.filter((command) => command.includes('+download') || command.includes('+export'))
}

/** Business knowledge-base tree reads. */
function treeCommands(ctx) {
  return ctx.commands.filter((command) => command.includes('+node-list') || command.includes('+space-list'))
}

test('显式 wikiPath：manifest 读不到也按库内 xlsx 路径取回并逐字节验真', async () => {
  const ctx = makeCtx({ manifest: '' })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(
    { ...ARGS, wikiPath: TEMPLATE_WIKI_PATH }, execOf(sessionId),
  )

  assert.equal(result.ok, true, result.error)
  assert.equal(result.method, 'market')
  assert.equal(result.nodeName, `${TEMPLATE_NODE}.xlsx`)
  assert.equal(result.source, 'dws')
  assert.equal(result.sizeBytes, XLSX_BYTES.length)
  assert.equal(result.digest, knowledgeDigest(XLSX_BYTES))

  // Bytes really land under the case knowledge snapshot; a successful command is not evidence.
  const landed = landedBytes(ctx)
  assert.equal(landed.length, 1)
  assert.match(landed[0], /01 市场法计算表模板-住宅\.xlsx$/)
  assert.equal(ctx.binaries.get(landed[0]).length, XLSX_BYTES.length)
})

test('显式 wikiPath：穿越 / 绝对 / 非模板后缀在任何库 I/O 之前被拒', async () => {
  const invalid = [
    '/01 估值与测算/模板.xlsx',
    '01 估值与测算/../../逃逸.xlsx',
    '01 估值与测算/01 房地产/05 计算表模板/01 市场法/模板.md',
    '01 估值与测算/01 房地产/05 计算表模板/01 市场法/模板.txt',
  ]
  for (const wikiPath of invalid) {
    const ctx = makeCtx()
    const { deps } = makeDeps({ ctx })
    const sessionId = openValuation(deps)
    const result = await valuationTemplateTools(deps)[0].execute({ ...ARGS, wikiPath }, execOf(sessionId))

    assert.equal(result.ok, false, `wikiPath=${wikiPath} 必须被拒`)
    assert.equal(result.errorKind, 'input', `wikiPath=${wikiPath} 应报 input`)
    assert.deepEqual(treeCommands(ctx), [], `wikiPath=${wikiPath} 不得读业务库目录树`)
    assert.deepEqual(fetchCommands(ctx), [], `wikiPath=${wikiPath} 不得发起取数`)
    assert.deepEqual(landedBytes(ctx), [])
  }
})

test('显式 wikiPath：URL / nodeId 形态不得被当作模板路径', async () => {
  for (const wikiPath of ['https://example.invalid/模板.xlsx', 'f-52']) {
    const ctx = makeCtx()
    const { deps } = makeDeps({ ctx })
    const sessionId = openValuation(deps)
    const result = await valuationTemplateTools(deps)[0].execute({ ...ARGS, wikiPath }, execOf(sessionId))

    assert.equal(result.ok, false, `wikiPath=${wikiPath} 必须被拒`)
    assert.deepEqual(fetchCommands(ctx), [], `wikiPath=${wikiPath} 不得发起取数`)
    assert.deepEqual(landedBytes(ctx), [])
  }
})

test('显式 wikiPath：库内缺失 → 不取数、如实失败，不拿 manifest 槽位顶替', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const missing = '01 估值与测算/01 房地产/05 计算表模板/01 市场法/不存在的模板.xlsx'
  const result = await valuationTemplateTools(deps)[0].execute({ ...ARGS, wikiPath: missing }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.match([result.error, ...result.capabilityGaps].join('；'), /不存在|未取到|没取到/)
  assert.deepEqual(fetchCommands(ctx).filter((command) => command.includes('--node f-52')), [])
  assert.deepEqual(landedBytes(ctx), [])
})

test('显式 wikiPath：同目录折叠同名多命中 → ambiguous，绝不选第一份', async () => {
  // A same-name sibling that differs only by hyphen/space: folding makes it ambiguous, so the
  // whole request must fail rather than pick one.
  const tree = { ...TREE, 'f-51': [...TREE['f-51'], DOC('f-53', '01 市场法计算表模板 住宅', 'xlsx')] }
  const ctx = makeCtx({ tree })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationTemplateTools(deps)[0].execute(
    { ...ARGS, wikiPath: TEMPLATE_WIKI_PATH }, execOf(sessionId),
  )

  assert.equal(result.ok, false)
  assert.match([result.error, ...result.capabilityGaps].join('；'), /多命中|ambiguous|不选/)
  assert.deepEqual(fetchCommands(ctx), [])
  assert.deepEqual(landedBytes(ctx), [])
})

test('重复取同一显式模板路径：两次都成功，保留第一次已验真文件与指纹', async () => {
  // Real `drive +download` fails with LOCAL_FILE_EXISTS when the target exists: either use a fresh
  // destination or reuse the verified file; never delete the old artifact or pass an overwrite flag.
  const ctx = makeCtx({ manifest: '', refuseExistingOutput: true })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const tool = valuationTemplateTools(deps)[0]
  const args = { ...ARGS, wikiPath: TEMPLATE_WIKI_PATH }

  const first = await tool.execute(args, execOf(sessionId))
  assert.equal(first.ok, true, first.error)
  const firstTarget = landedBytes(ctx)[0]
  assert.ok(firstTarget !== undefined, `第一次必须落盘：${[...ctx.binaries.keys()].join('、')}`)
  const firstBytes = ctx.binaries.get(firstTarget)
  assert.equal(firstBytes.length, XLSX_BYTES.length)

  const second = await tool.execute(args, execOf(sessionId))
  assert.equal(second.ok, true, second.error)
  assert.equal(second.digest, first.digest, '第二次必须回报同一份已验真指纹')
  assert.equal(second.sizeBytes, first.sizeBytes)
  // The first verified file stays byte-for-byte intact.
  assert.deepEqual(ctx.binaries.get(firstTarget), firstBytes)

  for (const command of ctx.commands) {
    assert.equal(/rm -f|Remove-Item|--overwrite|--clobber|--force/.test(command), false,
      `显式模板路径的重复取数不得用破坏性手段：${command}`)
  }

  const downloads = ctx.commands.filter((command) => command.includes('+download') && command.includes('--node f-52'))
  if (second.snapshotFile === first.snapshotFile) {
    // Reusing the same destination must not trigger a second download.
    assert.equal(downloads.length, 1, '复用同一已验真文件时不得再发起下载')
  } else {
    // A fresh destination allows a second download; the old file is still there.
    assert.equal(downloads.length, 2, '换新落点才允许第二次下载')
  }
})

test('显式 wikiPath：模板落点逃出知识快照目录 → 目标检查 fail closed，不下载', async () => {
  const ctx = makeCtx({
    manifest: '',
    refuseExistingOutput: true,
    contains: (_parent, child) => !String(child.displayPath).endsWith('.xlsx'),
  })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const tool = valuationTemplateTools(deps)[0]
  const args = { ...ARGS, wikiPath: TEMPLATE_WIKI_PATH }

  const result = await tool.execute(args, execOf(sessionId))
  assert.equal(result.ok, false, '落点越界时不得复用或写入')
  assert.equal(result.snapshotFile, '')

  const downloads = ctx.commands.filter(
    (command) => command.includes('+download') && argAfter(command, '--node') === 'f-52',
  )
  assert.equal(downloads.length, 0, '目标越界时不得发起下载')
})

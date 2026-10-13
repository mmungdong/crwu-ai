/**
 * `crwu_valuation_knowledge_materialize` 的**降级路径**测试（协议 32）。
 *
 * 决策逻辑（哪一份、从哪来、缺了算不算致命）已经在
 * `host-valuation-knowledge.test.mjs` 里被穷尽覆盖；这里只测**工具接线**，
 * 而且专挑最容易静默出错的那条：**知识库读不到时必须退到技能自带参考文件**。
 *
 * 为什么这条最危险：如果"读不到知识库"被当成"没有知识"，整轮估值会在
 * "缺少必需知识"上停下 —— 看起来像业务问题（规范没发布），实际是能力问题（库不可达）；
 * 反过来若把本地参考冒充成知识库正文，证据里就永远看不出知识库其实没读到。
 * 两种错都不会报错，只会让人得出相反的结论。
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
const { KNOWLEDGE_INDEX_FILE, KNOWLEDGE_SNAPSHOT_DIR, VALUATION_KNOWLEDGE_ROUTES } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-140000-aa11'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

/** 内存 fs + 只让 `mkdir` 成功的 shell（于是**所有 dws 调用都失败**）。 */
function makeCtx({ dwsFails = true } = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR])
  const files = new Map()
  const commands = []
  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) { files.set(target.targetKey, content); return { operation: 'create', version: 'v' } },
    contains(parent, child) {
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
      // 三类命令分开：**只读探测**与 **mkdir** 照常成功（案例目录要建得出来、后置条件要读得到），
      // 只有真正的 `dws` 调用失败 —— 模拟的正是"知识库不可达"而不是"沙箱坏了"。
      // 用一个"全都失败"的 shell 会连目录后置条件都读不到，测出来的是夹具的缺口。
      const probe = probeAnswer(command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(path),
      })
      const isLocal = command.startsWith('mkdir') || probe !== undefined
      const exitCode = isLocal ? 0 : (dwsFails ? 1 : 0)
      applyShellEffect(command, exitCode, {
        addDir: (path) => directories.add(path),
        removeFile: (path) => { files.delete(path) },
      })
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: exitCode === 0 ? (probe ?? '') : '', truncated: false },
          stderr: { text: exitCode === 0 ? '' : 'dws: 未登录 / 网络不可达', truncated: false },
        }),
      }
    },
  }
  return {
    directories, files, commands,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellService
      return undefined
    },
  }
}

function makeDeps({ ctx = makeCtx(), scopes = new ValuationScopes() } = {}) {
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, state, scopes,
    deps: {
      ctx, config: { ...CONFIG }, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
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

test('注册面：知识准备 Tool 在注册清单里，但**不在**审核必需集', () => {
  assert.equal(CRWU_BUSINESS_TOOLS.includes(VALUATION_TOOL_NAMES.knowledgeMaterialize), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes(VALUATION_TOOL_NAMES.knowledgeMaterialize), false)
})

test('非估值会话被拒（普通会话不许把知识倒进案例目录）', async () => {
  const { deps } = makeDeps()
  const result = await valuationKnowledgeTools(deps)[0]
    .execute({ caseDir: CASE_DIR, method: 'market' }, execOf('随便一条会话'))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /不是本轮估值会话/)
})

test('知识库不可达 → 退到技能自带参考文件：来源标 local、记失败、不停止估值', async () => {
  const ctx = makeCtx({ dwsFails: true })
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  const result = await valuationKnowledgeTools(deps)[0]
    .execute({ caseDir: CASE_DIR, method: 'market' }, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.spaceFound, false, '知识库没读到就要如实说')
  assert.equal(result.failures.length > 0, true, '知识库失败要留证据（否则查不出库挂过）')
  assert.match(JSON.stringify(result.failures), /dws|知识库/)

  // 市场法需要 5 份（01/02/05/06/07）；本地全部存在，所以每份都该有正文。
  const expected = VALUATION_KNOWLEDGE_ROUTES
    .filter((route) => route.methods.length === 0 || route.methods.includes('market'))
    .map((route) => route.route)
  assert.deepEqual(result.sources.map((item) => item.route).sort(), [...expected].sort())
  for (const item of result.sources) {
    assert.equal(item.source, 'local', `${item.route} 应该标成本地参考`)
    assert.match(String(item.digest), /^sha256:[0-9a-f]{64}$/, `${item.route} 必须带正文指纹`)
    assert.equal(item.updatedAt, '', '本地文件不拿 mtime 冒充知识库更新时间')
  }

  // 正文真的落到了 `<案例>/知识快照/`，而且不是空文件。
  const all = [...ctx.files.keys()].filter((path) => path.startsWith(`${CASE_DIR}/${KNOWLEDGE_SNAPSHOT_DIR}/`))
  const bodies = all.filter((path) => !path.endsWith(KNOWLEDGE_INDEX_FILE))
  assert.equal(bodies.length, expected.length, `正文文件数不对：${all.join('、')}`)
  assert.equal(all.some((path) => path.endsWith(KNOWLEDGE_INDEX_FILE)), true, '要写知识来源索引')
  for (const path of bodies) {
    assert.ok(String(ctx.files.get(path)).length > 200, `${path} 正文太短`)
  }
})

test('知识来源索引：写清库名 / 是否读到库 / 方法 / 指纹 / 每条来源', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  const result = await valuationKnowledgeTools(deps)[0]
    .execute({ caseDir: CASE_DIR, method: 'income' }, execOf(sessionId))

  const index = JSON.parse(ctx.files.get(result.indexPath))
  assert.equal(index.schema, 'crwu.valuation.knowledge.v1')
  assert.equal(index.spaceName, '中瑞世联业务知识库')
  assert.equal(index.spaceFound, false)
  assert.equal(index.method, 'income')
  assert.equal(index.digest, result.digest)
  assert.equal(index.sources.length, result.sources.length)
  // 收益法不需要市场法与成本法正文。
  const nodes = index.sources.map((item) => item.route)
  assert.equal(nodes.some((route) => route.endsWith('02-市场法')), false)
  assert.equal(nodes.some((route) => route.endsWith('03-收益法')), true)
  // 索引里不许出现凭据面的事实。
  assert.equal(/token|sign|secret|password/i.test(JSON.stringify(index)), false)
})

test('同一批知识两次取数得到同一个快照指纹（可核对）', async () => {
  const first = makeDeps({ ctx: makeCtx() })
  const second = makeDeps({ ctx: makeCtx() })
  const one = await valuationKnowledgeTools(first.deps)[0]
    .execute({ caseDir: CASE_DIR, method: 'cost' }, execOf(openValuation(first.deps)))
  const two = await valuationKnowledgeTools(second.deps)[0]
    .execute({ caseDir: CASE_DIR, method: 'cost' }, execOf(openValuation(second.deps)))
  assert.equal(one.digest, two.digest)
  assert.match(one.digest, /^sha256:[0-9a-f]{64}$/)
})

test('清单随方法变化（界面据此说明"这一轮需要哪些规范"）', async () => {
  const { deps } = makeDeps({ ctx: makeCtx() })
  const result = await valuationKnowledgeTools(deps)[0]
    .execute({ caseDir: CASE_DIR, method: 'cost' }, execOf(openValuation(deps)))
  const nodes = result.checklist.map((item) => item.node)
  assert.equal(nodes.includes('04-成本法'), true)
  assert.equal(nodes.includes('02-市场法'), false)
  assert.equal(result.checklist.find((item) => item.node === '01-房地产估值通用').required, true)
})

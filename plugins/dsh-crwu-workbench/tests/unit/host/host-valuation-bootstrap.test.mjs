/**
 * 报告评估的**案例 scope 与输入交接**（协议 32）单元测试。
 *
 * 这一层要钉死的不变量：
 *
 * 1. 估值 id 是**单段安全目录名**（`..` / 分隔符 / 绝对路径一律不合法）—— 它是案例目录名；
 * 2. 案例 scope 的归属判据是**会话 id 逐字相等**：普通会话判据只认"`<工作区>/<某段>` 这个形状"，
 *    认不出归属，所以同一条估值会话能把 caseDir 指到**另一个**案例目录 —— 这里必须挡住；
 * 3. 冻结的输入（方法 / 基准日 / 补充要求 / 清单）**只能消费不能改写**：交接工具没有那些参数，
 *    子会话提交 `valuationId` 也只能对上自己那一轮；
 * 4. 落盘的只有**输入**（三个子目录 + `估值输入.json`），产出文件由 AI 自己写。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { requireCaseAccess } = await import(new URL('src/host/domains/report-audit/case-access.ts', ROOT).href)
const { valuationBootstrapTools } = await import(new URL('src/host/tools/report-evaluation/bootstrap.ts', ROOT).href)
const { VALUATION_TOOL_NAMES, VALUATION_CHILD_TOOLS } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const {
  ValuationScopes, isSafeValuationId, mintValuationId, valuationMethodLabel,
} = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-101500-ab12'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 内存 fs + 会真的作用到它的 shell（`ensureDirectory` 会回读后置条件）。 */
function makeCtx({ failMkdir = false } = {}) {
  const directories = new Set([WORKSPACE])
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
    /** 案例门禁用 `fs.contains` 判断"在不在允许根之下"（真实现是规范化比较）。 */
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
      const exitCode = failMkdir ? 1 : 0
      applyShellEffect(command, exitCode, {
        addDir: (path) => directories.add(path),
        removeFile: (path) => { files.delete(path) },
      })
      const probe = probeAnswer(command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(path) || files.has(probeKey(path)),
      })
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: probe ?? '', truncated: false }, stderr: { text: '', truncated: false },
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

function makeState(patch = {}) {
  const state = createWorkbenchState(CONFIG)
  // 缺省**已允许**本机访问：绝大多数用例关心的是业务行为；验授权闸门的用例显式传
  // `localAccess: missingConsent()`。
  return {
    ...state,
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '中瑞世联工作区',
    caseRoot: WORKSPACE,
    ...patch,
  }
}

const PDF_SHA = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function snapshotOf(patch = {}) {
  return {
    valuationId: VALUATION_ID,
    method: 'market',
    baseDate: '2026-06-30',
    supplementalPrompt: '请按市场法测算，注意可比案例的可比性。',
    digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    frozenAt: '2026-10-12T02:15:00.000Z',
    files: [
      { fileName: '估值报告.pdf', relativePath: '材料-源/估值报告.pdf', kind: 'pdf', sizeBytes: 1024, sha256: PDF_SHA },
    ],
    ...patch,
  }
}

function makeDeps({ ctx = makeCtx(), state = makeState(), scopes = new ValuationScopes() } = {}) {
  // 案例目录先建出来：本文件测的是**归属**（谁有权用哪个目录），不是"目录在不在"。
  // 目录不存在时普通会话判据会先以 `input` 失败，把归属断言掩盖掉。
  ctx.directories.add(CASE_DIR)
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, state, scopes, access,
    deps: {
      ctx,
      config: { ...CONFIG },
      state,
      access,
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

function execOf(sessionId) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.caseBootstrap,
    arguments: {}, signal: new AbortController().signal,
    agent: { id: sessionId }, deferContext() {}, concludeTurn() {},
  }
}

function bootstrap(deps) {
  return valuationBootstrapTools(deps)[0]
}

/** 开一轮估值（Host 在确认抽屉确认时做的事：冻结快照 + 绑定会话 + 建案例目录）。 */
function openValuation(deps, ctx, patch = {}) {
  const sessionId = patch.sessionId ?? 'valuation-session-1'
  const scope = {
    valuationId: patch.valuationId ?? VALUATION_ID,
    casePath: patch.casePath ?? CASE_DIR,
    sessionId,
    workspaceId: 'w1',
    workspacePath: WORKSPACE,
    snapshot: patch.snapshot ?? snapshotOf(),
    openedAt: patch.openedAt ?? 1_000,
  }
  ctx.directories.add(scope.casePath)
  deps.valuationScopes.open(scope)
  return { scope, sessionId }
}

// ── 估值 id 与注册面 ────────────────────────────────────────────────────────

test('估值 id 是可读的单段目录名；`..` / 分隔符 / 绝对路径一律不合法', () => {
  const id = mintValuationId(new Date(2026, 9, 12, 10, 15, 0), () => 0.5)
  assert.match(id, /^估值-20261012-101500-[0-9a-f]{4}$/)
  assert.equal(isSafeValuationId(id), true)
  // 同一秒连开两轮不能撞目录。
  assert.notEqual(id, mintValuationId(new Date(2026, 9, 12, 10, 15, 0), () => 0.9))

  for (const bad of ['', ' ', '..', '.', 'a/b', 'a\\b', '/abs', 'C:\\x', 'x..y', 'a'.repeat(129)]) {
    assert.equal(isSafeValuationId(bad), false, JSON.stringify(bad))
  }
})

test('方法名覆盖三种明确指定的方法', () => {
  assert.deepEqual(
    ['market', 'income', 'cost'].map(valuationMethodLabel),
    ['市场法', '收益法', '成本法'],
  )
})

test('估值 Tool 有自己的分组：**不混进**审核必需集', () => {
  assert.equal(VALUATION_CHILD_TOOLS.includes('crwu_valuation_case_bootstrap'), true)
  assert.equal(VALUATION_CHILD_TOOLS.includes('crwu_run_python_script'), true)
  for (const name of VALUATION_CHILD_TOOLS) {
    assert.equal(REQUIRED_AUDIT_TOOLS.includes(name), false, `${name} 不许进审核必需集`)
  }
  // 注册面里要有它（装了插件就该有这个工具），但那是另一张名单。
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_case_bootstrap'), true)
})

// ── 案例 scope 注册表 ───────────────────────────────────────────────────────

test('scope 注册表：按会话与按 id 双向可查；结束一轮就释放访问权', () => {
  const scopes = new ValuationScopes()
  const scope = {
    valuationId: VALUATION_ID, casePath: CASE_DIR, sessionId: 's-1',
    workspaceId: 'w1', workspacePath: WORKSPACE, snapshot: snapshotOf(), openedAt: 1,
  }
  scopes.open(scope)
  assert.equal(scopes.scopeOf('s-1')?.casePath, CASE_DIR)
  assert.equal(scopes.get(VALUATION_ID)?.sessionId, 's-1')
  assert.equal(scopes.scopeOf('s-2'), undefined)
  assert.equal(scopes.get('别的 id'), undefined)

  assert.equal(scopes.close(VALUATION_ID), true)
  assert.equal(scopes.scopeOf('s-1'), undefined, '结束后这条会话立刻失去案例访问权')
  assert.equal(scopes.get(VALUATION_ID), undefined)
  assert.equal(scopes.close(VALUATION_ID), false, '重复结束是幂等的 false')
})

test('scope 注册表有界：超过上限淘汰最旧的（不留无界增长）', () => {
  const scopes = new ValuationScopes(2)
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    scopes.open({
      valuationId: id, casePath: `${WORKSPACE}/${id}`, sessionId: `s-${id}`,
      workspaceId: 'w1', workspacePath: WORKSPACE, snapshot: snapshotOf({ valuationId: id }), openedAt: index + 1,
    })
  }
  assert.equal(scopes.size, 2)
  assert.equal(scopes.get('a'), undefined, '最旧的那一轮被淘汰')
  assert.equal(scopes.get('c')?.sessionId, 's-c')
})

test('同一会话改用新一轮估值时，旧一轮的结束不会把它一起抹掉', () => {
  const scopes = new ValuationScopes()
  const base = { casePath: CASE_DIR, sessionId: 's-1', workspaceId: 'w1', workspacePath: WORKSPACE }
  scopes.open({ ...base, valuationId: 'old', snapshot: snapshotOf(), openedAt: 1 })
  scopes.open({ ...base, valuationId: 'new', snapshot: snapshotOf(), openedAt: 2 })
  assert.equal(scopes.scopeOf('s-1')?.valuationId, 'new')
  scopes.close('old')
  assert.equal(scopes.scopeOf('s-1')?.valuationId, 'new', '结束旧一轮不该把新一轮的会话映射删掉')
})

// ── 案例门禁 ────────────────────────────────────────────────────────────────

test('案例门禁：估值会话只认自己那一份案例目录，指到别处一律 policy 拒绝', async () => {
  const { ctx, state, deps } = makeDeps()
  openValuation(deps, ctx)

  const mine = await requireCaseAccess(ctx, state, deps.discussionScopes, execOf('valuation-session-1'), { caseDir: CASE_DIR }, { valuation: deps.valuationScopes })
  assert.equal(mine.ok, true)
  assert.equal(mine.kind, 'valuation')
  assert.equal(mine.casePath, CASE_DIR)

  // 空 caseDir 也放行（Host 用它自己的记录），但**别的**目录不行。
  const implicit = await requireCaseAccess(ctx, state, deps.discussionScopes, execOf('valuation-session-1'), {}, { valuation: deps.valuationScopes })
  assert.equal(implicit.ok, true)
  assert.equal(implicit.casePath, CASE_DIR)

  const foreign = await requireCaseAccess(ctx, state, deps.discussionScopes, execOf('valuation-session-1'), { caseDir: `${WORKSPACE}/估值-别的` }, { valuation: deps.valuationScopes })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.errorKind, 'policy')

  // 别的会话**拿不到估值 scope**。它仍然可能被**普通会话判据**放行 —— 那是既有口径
  // （`<工作区>/<某段>` 这个形状对用户自己的会话是允许的）。这里断言的是：
  // 它绝不会被当作"本轮估值会话"，于是估值 Tool 在下一步就以 policy 拒绝。
  const other = await requireCaseAccess(ctx, state, deps.discussionScopes, execOf('valuation-session-2'), { caseDir: CASE_DIR }, { valuation: deps.valuationScopes })
  assert.notEqual(other.kind, 'valuation', '别的会话不许被认成本轮估值')
})

// ── 输入交接 ────────────────────────────────────────────────────────────────

test('交接：落盘三个子目录与冻结输入，返回方法与基准日（取自快照，不是模型提交的）', async () => {
  const { ctx, deps } = makeDeps()
  const { sessionId, scope } = openValuation(deps, ctx)

  const result = await bootstrap(deps).execute({ valuationId: VALUATION_ID, caseDir: CASE_DIR }, execOf(sessionId))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.method, 'market')
  assert.equal(result.baseDate, '2026-06-30')
  assert.equal(result.digest, scope.snapshot.digest)
  assert.equal(result.fileCount, 1)
  assert.equal(result.files[0].fileName, '估值报告.pdf')

  for (const path of [result.materialDir, result.evidenceDir, result.knowledgeDir]) {
    assert.equal(ctx.directories.has(path), true, `${path} 必须建出来`)
  }
  assert.equal(result.materialDir, `${CASE_DIR}/材料-源`)
  assert.equal(result.evidenceDir, `${CASE_DIR}/来源证据`)
  assert.equal(result.knowledgeDir, `${CASE_DIR}/知识快照`)

  const written = JSON.parse(ctx.files.get(result.inputPath))
  assert.equal(written.method, 'market')
  assert.equal(written.baseDate, '2026-06-30')
  assert.equal(written.supplementalPrompt, '请按市场法测算，注意可比案例的可比性。')
  assert.equal(written.digest, scope.snapshot.digest)
  assert.deepEqual(written.files, scope.snapshot.files)
})

test('交接：未指定基准日时落盘与回传都是**空串**（不从资料里补一个）', async () => {
  const { ctx, deps } = makeDeps()
  const { sessionId } = openValuation(deps, ctx, { snapshot: snapshotOf({ method: 'auto', baseDate: '' }) })
  const result = await bootstrap(deps).execute({ valuationId: VALUATION_ID, caseDir: CASE_DIR }, execOf(sessionId))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.method, 'auto')
  assert.equal(result.baseDate, '', '基准日没选就是空串')
  const written = JSON.parse(ctx.files.get(result.inputPath))
  assert.equal(written.baseDate, '')
})

test('交接：非估值会话被拒（审核 / 普通会话不许碰估值输入）', async () => {
  const { deps } = makeDeps()
  const result = await bootstrap(deps).execute({ valuationId: VALUATION_ID, caseDir: CASE_DIR }, execOf('随便一条会话'))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy', result.error)
  assert.match(result.error, /不是本轮估值会话/)
})

test('交接：找不到冻结输入的估值 id 一律 not-found（绝不用模型报的参数顶替）', async () => {
  const { ctx, deps } = makeDeps()
  const { sessionId } = openValuation(deps, ctx)
  for (const id of ['', '估值-不存在的']) {
    const result = await bootstrap(deps).execute({ valuationId: id, caseDir: CASE_DIR }, execOf(sessionId))
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'not-found')
  }
})

test('交接：valuationId 与案例目录不属于同一轮时拒绝', async () => {
  const { ctx, deps } = makeDeps()
  const { sessionId } = openValuation(deps, ctx)
  // 另一轮估值（另一个案例目录）也登记着：模型拿它去套本轮会话。
  const otherId = '估值-20261012-101600-cd34'
  const otherCase = `${WORKSPACE}/${otherId}`
  ctx.directories.add(otherCase)
  deps.valuationScopes.open({
    valuationId: otherId, casePath: otherCase, sessionId: '别的会话',
    workspaceId: 'w1', workspacePath: WORKSPACE, snapshot: snapshotOf({ valuationId: otherId }), openedAt: 2,
  })
  const result = await bootstrap(deps).execute({ valuationId: otherId, caseDir: CASE_DIR }, execOf(sessionId))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /同一轮估值/)
})

test('交接：案例目录建不出来时**不写输入文件**（先目录、后文件）', async () => {
  const ctx = makeCtx({ failMkdir: true })
  const { deps } = makeDeps({ ctx })
  const { sessionId } = openValuation(deps, ctx)
  const result = await bootstrap(deps).execute({ valuationId: VALUATION_ID, caseDir: CASE_DIR }, execOf(sessionId))
  assert.equal(result.ok, false)
  assert.match(result.error, /创建估值案例子目录失败/)
  assert.equal(ctx.files.has(`${CASE_DIR}/估值输入.json`), false, '目录没建好就不许写输入文件')
})

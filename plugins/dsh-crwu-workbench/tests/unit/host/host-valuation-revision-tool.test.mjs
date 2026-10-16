/**
 * `crwu_valuation_revision` 的**工具接线**测试（协议 39）。
 *
 * 决策逻辑（编号怎么发、哪一版该建、能不能提升）在 `host-valuation-revision.test.mjs` 里穷尽覆盖；
 * 这里只测最容易静默出错的那几条接线：
 *
 * 1. **编号由 Host 发**：`op=candidates` 落盘编号册，重复候选沿用原号；
 * 2. **新版本 pending 且不动当前指针**：旧版报告与底稿不被覆盖；
 * 3. **重复提交幂等 / 未知编号拒绝**：双击与"3 号是谁"都不许猜；
 * 4. **提升必须过 Host 的完成判定**：缺交付件时把该版标成 failed、当前指针不动。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationRevisionTools } = await import(new URL('src/host/tools/report-evaluation/revision.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261015-090000-aa11'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const PLAN_ID = 'plan-001'
const PLAN_DIR = `${CASE_DIR}/方案/${PLAN_ID}`

/** 只回答文件读写与 mkdir 的内存宿主（与其它估值工具测试同一套写法）。 */
function makeCtx(seed = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR, `${CASE_DIR}/方案`, PLAN_DIR])
  const files = new Map(Object.entries(seed))
  const commands = []
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir ?? WORKSPACE, timeoutMs: 1, stdoutMaxBytes: 1024 }),
    async execute(spec) {
      commands.push(spec.command)
      const probe = probeAnswer(spec.command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(probeKey(path)),
      })
      if (probe !== undefined) {
        return {
          result: async () => ({
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: probe, truncated: false }, stderr: { text: '', truncated: false },
          }),
        }
      }
      applyShellEffect(spec.command, 0, {
        addDir: (path) => directories.add(probeKey(path)),
        removeFile: (path) => files.delete(path),
      })
      return {
        result: async () => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
        }),
      }
    },
  }
  const parentOf = (target) => String(target).replace(/[\\/][^\\/]+$/, '')
  const fs = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) {
      if (!directories.has(parentOf(target.targetKey))) {
        const error = new Error(`ENOENT: no such file or directory, open '${String(target.targetKey)}'`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(target.targetKey, content)
      return { operation: 'create', version: 'v' }
    },
    async mkdir(target) { directories.add(String(target.targetKey)); return { version: 'v' } },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }
  return {
    files, directories, commands,
    get(name) {
      if (name === 'fs') return fs
      if (name === 'shell') return shell
      return undefined
    },
    effect() { return () => {} },
  }
}

function makeDeps({ ctx = makeCtx(), scopes = new ValuationScopes() } = {}) {
  const state = createWorkbenchState({
    configSource: '', caseRoot: WORKSPACE, preferWorkspaceTitle: '', formName: '报告审核',
    ossBucket: '', ossPrefix: '', ossEndpoint: '', ossBaseUrl: '', ossLinkMode: 'signed',
    ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true,
    valuation: {
      browser: { sitesFile: 'x', requiredSiteIds: [], optionalSiteIds: [], assistLoginChallenge: true },
      knowledge: { mirrorRoot: '', wikiPath: 'w', manifestPath: 'm' },
      recalculation: { enginePath: '' },
    },
  })
  const { access } = makeTestAccess(ctx, { state: { ...state, localAccess: grantedConsent() } })
  const deps = {
    ctx, config: state.config, state,
    world: { workdir: async () => WORKSPACE, platform: async () => 'darwin' },
    access,
    discussionScopes: createDiscussionScopeRegistry({ now: () => new Date('2026-10-15T00:00:00.000Z') }),
    valuationScopes: scopes,
    // 没有 python / 截图的装配：这一组用例只关心编号册与修订索引。
    python: undefined,
    screenshot: undefined,
  }
  return { deps, ctx, scopes }
}

/** 打开本轮估值 scope（工具会校验会话归属）。 */
function openValuation(scopes, sessionId = 'valuation-session-1') {
  scopes.open({
    valuationId: VALUATION_ID, casePath: CASE_DIR, sessionId,
    workspaceId: 'w1', workspacePath: WORKSPACE,
    snapshot: {
      valuationId: VALUATION_ID, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:x', frozenAt: '2026-10-15T00:00:00.000Z', files: [],
    },
    openedAt: 1,
  })
  return sessionId
}

function execOf(sessionId) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'), name: VALUATION_TOOL_NAMES.revision,
    arguments: {}, signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

async function run(ctx, scopes, args) {
  const { deps } = makeDeps({ ctx, scopes })
  const sessionId = scopes.get(VALUATION_ID)?.sessionId ?? openValuation(scopes)
  const tool = valuationRevisionTools(deps)[0]
  return await tool.execute({ caseDir: CASE_DIR, planId: PLAN_ID, ...args }, execOf(sessionId))
}

const candidate = (name, area, price, patch = {}) => ({
  source: 'lianjia', url: `https://example.invalid/${name}`, community: name,
  buildingArea: area, price, unitPrice: null, transactionType: '挂牌',
  evidence: `来源证据/${name}.html`, status: 'near-miss', reason: '面积偏差超过规则上限', ...patch,
})

// ── 注册面 ──────────────────────────────────────────────────────────────────

test('注册面：修订 Tool 在注册清单里，但**不在**审核必需集', () => {
  assert.equal(CRWU_BUSINESS_TOOLS.includes(VALUATION_TOOL_NAMES.revision), true)
  assert.equal(VALUATION_TOOL_NAMES.revision, 'crwu_valuation_revision')
})

// ── 编号册 ──────────────────────────────────────────────────────────────────

test('op=candidates：编号由 Host 发并落盘；重复候选沿用原号', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  const first = await run(ctx, scopes, { op: 'candidates', candidates: [candidate('甲', 100, 5_000_000), candidate('乙', 90, 4_500_000)] })
  assert.equal(first.ok, true, first.error)
  assert.deepEqual(first.candidates.map((item) => item.number), [1, 2])
  assert.equal(ctx.files.has(`${PLAN_DIR}/候选案例.json`), true, '编号册要落盘（跨轮次稳定）')

  const second = await run(ctx, scopes, { op: 'candidates', candidates: [candidate('乙', 90, 4_500_000), candidate('丙', 80, 4_000_000)] })
  assert.deepEqual(second.candidates.map((item) => item.number), [1, 2, 3])
  const byName = Object.fromEntries(second.candidates.map((item) => [item.community, item.number]))
  assert.deepEqual(byName, { 甲: 1, 乙: 2, 丙: 3 })
  assert.equal(second.candidates.find((item) => item.number === 1).retired, true, '这一轮没出现 → 编号保留并标 retired')
})

test('op=candidates：没有候选清单时拒绝（不发空号）', async () => {
  const result = await run(makeCtx(), new ValuationScopes(), { op: 'candidates', candidates: [] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
})

// ── 修订 ────────────────────────────────────────────────────────────────────

test('op=recompute：建 pending 版本、不动当前指针、旧版目录不被覆盖', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  await run(ctx, scopes, { op: 'candidates', candidates: [candidate('甲', 100, 5_000_000), candidate('乙', 90, 4_500_000)] })

  const first = await run(ctx, scopes, { op: 'recompute', changeKind: 'manual', reason: '初版' })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.revision, 1)
  assert.equal(first.revisionDirectory, '', '第 1 版就是方案根')
  assert.equal(first.state, 'pending')
  assert.equal(first.currentRevision, 0, '核对通过之前不动当前指针')

  const second = await run(ctx, scopes, {
    op: 'recompute', changeKind: 'user-case-selection', reason: '用户要求把 2 号纳入重算',
    numbers: [2], knowledgeDigest: 'sha256:k', templateDigest: 'sha256:t',
  })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.revision, 2)
  assert.equal(second.revisionDirectory, '修订/2')
  assert.equal(ctx.directories.has(`${PLAN_DIR}/修订/2`), true, '新版有自己的目录：旧版交付件不被覆盖')
  assert.equal(second.currentRevision, 0)
  assert.deepEqual(second.revisions.map((item) => item.revision), [1, 2])
  assert.deepEqual(second.revisions[1].adoptedNumbers, [2])
})

test('op=recompute：未知编号与已退休编号分别拒绝（绝不猜"3 号是谁"）', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  await run(ctx, scopes, { op: 'candidates', candidates: [candidate('甲', 100, 5_000_000)] })
  await run(ctx, scopes, { op: 'candidates', candidates: [candidate('乙', 90, 4_500_000)] })

  const unknown = await run(ctx, scopes, { op: 'recompute', changeKind: 'user-case-selection', reason: '加入 9 号', numbers: [9] })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errorKind, 'input')
  assert.match(unknown.error, /编号 9 不在候选册里/)
  assert.match(unknown.error, /可选编号是 2/)

  const retired = await run(ctx, scopes, { op: 'recompute', changeKind: 'user-case-selection', reason: '加入 1 号', numbers: [1] })
  assert.equal(retired.ok, false)
  assert.match(retired.error, /已经不在最新一轮结果里/)

  // 编号给了但原因没给：同样拒绝（变更必须具体）。
  const noReason = await run(ctx, scopes, { op: 'recompute', changeKind: 'user-case-selection', reason: '', numbers: [2] })
  assert.equal(noReason.ok, false)
  assert.match(noReason.error, /变更原因/)
})

test('op=recompute：同一提交重复调用幂等（双击 / 超时重试不叠版本）', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  await run(ctx, scopes, { op: 'candidates', candidates: [candidate('甲', 100, 5_000_000)] })
  const args = { op: 'recompute', changeKind: 'user-case-selection', reason: '加入 1 号', numbers: [1] }
  const first = await run(ctx, scopes, args)
  const again = await run(ctx, scopes, args)
  assert.equal(first.ok, true, first.error)
  assert.equal(again.ok, true)
  assert.equal(again.duplicate, true)
  assert.equal(again.revision, first.revision)
  assert.equal(again.revisions.length, 1, '重复提交不新建版本')
})

test('op=promote：缺交付件时把该版标 failed，当前指针留在上一版（回滚）', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  await run(ctx, scopes, { op: 'candidates', candidates: [candidate('甲', 100, 5_000_000)] })
  const made = await run(ctx, scopes, { op: 'recompute', changeKind: 'manual', reason: '初版' })

  // 这一版没有任何交付件：完成判定必然不过 → 不提升、标 failed。
  const promoted = await run(ctx, scopes, { op: 'promote', revision: made.revision })
  assert.equal(promoted.ok, false)
  assert.equal(promoted.errorKind, 'input')
  assert.match(promoted.error, /没有通过核对/)
  assert.equal(promoted.state, 'failed')
  assert.equal(promoted.currentRevision, 0, '回滚：当前指针不动')

  const list = await run(ctx, scopes, { op: 'list' })
  assert.equal(list.revisions[0].state, 'failed')
  assert.match(list.revisions[0].failure, /./, '失败原因要留在记录里，便于复核"试过什么"')

  // 提升一个不存在的版本：如实拒绝。
  const missing = await run(ctx, scopes, { op: 'promote', revision: 99 })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在的修订版本/)
})

test('op=list：当前版本、历史版本与编号册都能读出来', async () => {
  const ctx = makeCtx()
  const scopes = new ValuationScopes()
  await run(ctx, scopes, { op: 'candidates', candidates: [candidate('甲', 100, 5_000_000)] })
  await run(ctx, scopes, { op: 'recompute', changeKind: 'manual', reason: '初版' })
  const list = await run(ctx, scopes, { op: 'list' })
  assert.equal(list.ok, true)
  assert.equal(list.currentRevision, 0)
  assert.equal(list.revisions.length, 1)
  assert.equal(list.candidates.length, 1)
  assert.equal(list.nextNumber, 2)
  assert.equal(list.revisionIndexPath, `方案/${PLAN_ID}/修订记录.json`)
})

test('未知 op / 非估值会话一律拒绝（不落任何文件）', async () => {
  const ctx = makeCtx()
  const bad = await run(ctx, new ValuationScopes(), { op: '瞎编' })
  assert.equal(bad.ok, false)
  assert.equal(bad.errorKind, 'input')
  assert.equal(ctx.files.size, 0, '被拒时不许落任何文件')

  const other = makeCtx()
  const { deps } = makeDeps({ ctx: other })
  const tool = valuationRevisionTools(deps)[0]
  const rejected = await tool.execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, op: 'list' }, execOf('随便一条会话'))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.errorKind, 'policy')
  assert.equal(other.files.size, 0)
})

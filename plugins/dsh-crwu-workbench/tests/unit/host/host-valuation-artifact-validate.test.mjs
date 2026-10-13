/**
 * 交付校验 Tool（协议 32）的接线测试。
 *
 * 两个脚本自身的规则由 `skills/biz/.../scripts/test_valuation_contracts.py` 穷尽覆盖
 * （每条硬规则都要真的红）。这里测的是**接线**，以及一条最危险的失效模式：
 *
 * **"没有交付件"与"交付件不合格"必须都报失败。** 一个只回 `ok:false` 却说不清缺哪一件的
 * 校验工具，会让人反复重跑估值而不是去补那一件文件；而"文件不齐还算通过"更糟 ——
 * 它会把没有底稿的结论放出去。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationArtifactValidateTools } = await import(new URL('src/host/tools/report-evaluation/artifact-validate.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { VALUATION_OUTPUT_FILES } = await import(new URL('src/host/tools/report-evaluation/artifacts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { ValuationLifecycles } = await import(
  new URL('src/host/domains/report-evaluation/lifecycle/registry.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-180000-cc33'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

/**
 * 内存 fs + 可编排的 shell。
 *
 * `mkdir` 与只读探测照常成功（案例目录要建得出来、后置条件要读得到）；
 * Python 脚本调用由 `scriptRoute` 决定 stdout / 退出码。
 */
function makeCtx({ scriptRoute = () => ({ stdout: 'OK: 通过\n', exitCode: 0 }) } = {}) {
  const files = new Map()
  const directories = new Set([WORKSPACE, CASE_DIR])
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
      const probe = probeAnswer(command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(path),
      })
      const isMkdir = command.startsWith('mkdir')
      const isProbe = probe !== undefined
      const isPython = command.includes('python') || command.includes('check_workbook_contract') || command.includes('validate_result')
      const spec = isPython && !isMkdir && !isProbe ? scriptRoute(command) : { stdout: '', exitCode: 0 }
      const exitCode = isMkdir || isProbe ? 0 : spec.exitCode
      applyShellEffect(command, exitCode, {
        addDir: (path) => directories.add(path),
        removeFile: (path) => { files.delete(path) },
      })
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: exitCode === 0 || isPython ? (isProbe ? (probe ?? '') : spec.stdout) : '', truncated: false },
          stderr: { text: spec.stderr ?? '', truncated: false },
        }),
      }
    },
  }
  return {
    files, directories, commands,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellService
      return undefined
    },
  }
}

const PYTHON_STUB = {
  cached: () => null,
  check: async () => ({
    ok: true, state: 'ok', path: '/dsh/python/bin/python3', versionText: '3.12.4',
    distributions: { openpyxl: '3.1.5' }, missingPackages: [], error: '', source: 'stub',
  }),
}

function makeDeps({
  ctx = makeCtx(),
  scopes = new ValuationScopes(),
  lifecycles = new ValuationLifecycles(),
} = {}) {
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, state, scopes, lifecycles,
    deps: {
      ctx, config: { ...CONFIG }, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
      // 交付校验结论要写回轮次（§9：完成门槛据此判断"两道校验都过了"）。
      valuationLifecycles: lifecycles,
      python: PYTHON_STUB,
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
  // 轮次要**真的开一轮**：交付校验结论写回的正是它（`setValidation` 找不到轮次会拒绝）。
  deps.valuationLifecycles?.open({
    valuationId: VALUATION_ID, casePath: CASE_DIR, workspaceId: 'w1', workspacePath: WORKSPACE,
    method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:x',
  })
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
    name: VALUATION_TOOL_NAMES.artifactValidate, arguments: {},
    signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

/** 把三个交付件都放好（内容不必真实：脚本是替身）。 */
function placeDeliverables(ctx) {
  ctx.files.set(`${CASE_DIR}/估值底稿.xlsx`, 'xlsx-bytes')
  ctx.files.set(`${CASE_DIR}/估值报告.html`, '<html>报告</html>')
  ctx.files.set(`${CASE_DIR}/估值结果.json`, '{"valuationId":"x"}')
}

test('注册面：交付校验 Tool 在注册清单里，且**不在**审核必需集', () => {
  assert.equal(CRWU_BUSINESS_TOOLS.includes(VALUATION_TOOL_NAMES.artifactValidate), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes(VALUATION_TOOL_NAMES.artifactValidate), false)
})

test('非估值会话被拒', async () => {
  const { deps } = makeDeps()
  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf('随便一条会话'))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
})

test('交付件齐备且两份校验通过 → ok，并给出每个交付件的字节数与指纹', async () => {
  const ctx = makeCtx()
  placeDeliverables(ctx)
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.checks.map((item) => item.name), ['工作簿契约', '结果口径'])
  assert.equal(result.checks.every((item) => item.ok), true)
  assert.deepEqual(result.problems, [])
  // 清单覆盖全部中间件与交付件；存在的都有指纹，不存在的 bytes=0 / digest 空。
  assert.deepEqual(result.artifacts.map((item) => item.name), [...VALUATION_OUTPUT_FILES])
  const workbook = result.artifacts.find((item) => item.name === '估值底稿.xlsx')
  assert.equal(workbook.exists, true)
  assert.ok(workbook.bytes > 0)
  assert.match(workbook.digest, /^sha256:[0-9a-f]{64}$/)
  const params = result.artifacts.find((item) => item.name === '估值参数.json')
  assert.deepEqual(params, { name: '估值参数.json', exists: false, bytes: 0, digest: '' })
})

test('两个校验脚本都被**落到案例目录的 scripts/ 里**再执行（不放后门）', async () => {
  const ctx = makeCtx()
  placeDeliverables(ctx)
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  await valuationArtifactValidateTools(deps)[0].execute({ caseDir: CASE_DIR }, execOf(sessionId))

  assert.equal(ctx.files.has(`${CASE_DIR}/scripts/check_workbook_contract.py`), true)
  assert.equal(ctx.files.has(`${CASE_DIR}/scripts/validate_result.py`), true)
  // argv 里的解释器参数必须是案例内的脚本路径。
  for (const command of ctx.commands) {
    if (!command.includes('python')) continue
    if (!/check_workbook_contract|validate_result/.test(command)) continue
    assert.match(command, new RegExp(`${CASE_DIR}/scripts/(check_workbook_contract|validate_result)\\.py`))
  }
})

test('结果口径校验不过 → ok:false，并逐条带回脚本报的问题', async () => {
  const ctx = makeCtx({
    scriptRoute: (command) => (command.includes('validate_result')
      ? { stdout: 'FAIL baseDate 为空，但 manual_confirmation_items 里没有「本次未指定评估基准日」\nFAIL 结果契约不通过\n', exitCode: 1 }
      : { stdout: 'OK: 通过\n', exitCode: 0 }),
  })
  placeDeliverables(ctx)
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
  assert.match(result.error, /交付校验未通过/)
  assert.equal(result.problems.some((item) => /结果口径/.test(item)), true, '问题要带上是哪一份校验报的')
  assert.match(result.problems.join('；'), /未指定评估基准日/)
  const workbookCheck = result.checks.find((item) => item.name === '工作簿契约')
  const resultCheck = result.checks.find((item) => item.name === '结果口径')
  assert.equal(workbookCheck.ok, true)
  assert.equal(resultCheck.ok, false)
})

test('工作簿契约不过 → ok:false（且不去跑结果口径以外的事）', async () => {
  const ctx = makeCtx({
    scriptRoute: (command) => (command.includes('check_workbook_contract')
      ? { stdout: 'FAIL 底稿里有隐藏表：案例\n', exitCode: 1 }
      : { stdout: 'OK: 通过\n', exitCode: 0 }),
  })
  placeDeliverables(ctx)
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId))
  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /隐藏表/)
})

test('缺交付件 → 直接报缺哪一件，并**不**去跑那份校验（少一句误导性的"找不到"）', async () => {
  const ctx = makeCtx()
  ctx.files.set(`${CASE_DIR}/估值结果.json`, '{}')
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /缺少交付件：估值底稿\.xlsx/)
  assert.match(result.problems.join('；'), /缺少交付件：估值报告\.html/)
  assert.deepEqual(result.checks.map((item) => item.name), ['结果口径'], '底稿不在就不跑工作簿契约')
})

test('DSH Python 不可用 → 如实报能力缺口（不退回系统解释器，也不谎报通过）', async () => {
  const ctx = makeCtx()
  placeDeliverables(ctx)
  const scopes = new ValuationScopes()
  const { deps } = makeDeps({ ctx, scopes })
  deps.python = {
    cached: () => null,
    check: async () => ({
      ok: false, state: 'missing', path: '', versionText: '', distributions: {},
      missingPackages: [], error: '包内没有运行时', source: 'stub',
    }),
  }
  const sessionId = openValuation(deps)
  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /Python 不可用/)
  assert.equal(result.ok === false && result.checks.every((item) => item.ok === false), true)
})

test('脚本超时也算不通过（不许把"没跑完"当成通过）', async () => {
  const ctx = makeCtx({
    scriptRoute: (command) => (command.includes('validate_result')
      ? { stdout: 'FAIL 结果契约不通过\n', exitCode: 1, stderr: 'timeout' }
      : { stdout: 'OK: 通过\n', exitCode: 0 }),
  })
  placeDeliverables(ctx)
  const { deps } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationArtifactValidateTools(deps)[0]
    .execute({ caseDir: CASE_DIR }, execOf(sessionId))
  assert.equal(result.ok, false)
  const check = result.checks.find((item) => item.name === '结果口径')
  assert.equal(check.ok, false)
})

test('校验结论要**写回轮次**：完成门槛据此判断"交付前两道校验都过了"', async () => {
  const ctx = makeCtx()
  placeDeliverables(ctx)
  const { deps, lifecycles } = makeDeps({ ctx })
  const sessionId = openValuation(deps)

  await valuationArtifactValidateTools(deps)[0].execute({ caseDir: CASE_DIR }, execOf(sessionId))
  const record = lifecycles.get(VALUATION_ID)
  assert.equal(record.validationPassed, true, '两道校验都过 → 写回 true')
  assert.deepEqual(record.validationProblems, [])
})

test('校验结论与写回**一致**：过了就是 true，没过就是 false + 逐条原因', async () => {
  const ctx = makeCtx()
  placeDeliverables(ctx)
  const { deps, lifecycles } = makeDeps({ ctx })
  const sessionId = openValuation(deps)
  const result = await valuationArtifactValidateTools(deps)[0].execute({ caseDir: CASE_DIR }, execOf(sessionId))
  const record = lifecycles.get(VALUATION_ID)
  assert.equal(record.validationPassed, result.ok,
    '写回必须与校验结论一致：把"没过"记成"没跑过"会让界面给出错误的下一步')
  if (!result.ok) {
    assert.ok((record.validationProblems ?? []).length > 0, '没过要留下逐条原因')
    assert.deepEqual(record.validationProblems, result.problems)
  }
})

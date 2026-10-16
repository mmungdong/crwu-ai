/**
 * `crwu_valuation_listing_reference` 的**注册面与一次性交付**契约测试。
 *
 * 现场：挂牌参考估值被拆成多次调用（计算 / 底稿 / 报告各一次），一轮 13 分钟。
 * 本测试钉住的是一条注册 Tool：
 *
 * 1. 名称与注册面正确，参数面**只有** `caseDir / planId / revision`；
 * 2. 固定输入是"该方案 revision 下的 `挂牌参考输入.json`"，不是调用方给的任意路径；
 * 3. 内部只跑一次配置好的 DSH Python，装载打包的脚本 / schema / 模板；
 * 4. 外来方案、错的输入身份、缺运行时 / 装载失败 / 产物缺失都在**成功之前**结构化失败；
 * 5. 成功只可能 `partial`：挂牌参考不是正式结论，绝不许回 `completed`。
 *
 * 源文件尚未交付时，先在"入口存在"这一步给出精确的缺交付说明，而不是 import 报错。
 * 行为用例在源文件缺席时 `skip`，交付后自动生效 —— 不因为"还没实现"把断言删掉。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)
const TOOL_SOURCE = new URL('src/host/tools/report-evaluation/listing-reference.ts', ROOT)
const toolDelivered = existsSync(TOOL_SOURCE)

const { createDiscussionScopeRegistry } = await import(
  new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261015-120000-cc03'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const PLAN_ID = 'plan-001'
const PLAN_DIR = `${CASE_DIR}/方案/${PLAN_ID}`
const REVISION = 2
const REVISION_DIR = `${PLAN_DIR}/修订/${REVISION}`
const INPUT_FILE = '挂牌参考输入.json'
const SCRIPT = 'build_listing_reference.py'
const OUTPUTS = ['计算轨迹.json', '估值底稿.xlsx', '估值报告数据.json', '估值报告.html']
/** 打包脚本自己 import 的同目录依赖 + 报告数据 schema + 报告模板。 */
const STAGED_FILES = [
  `scripts/${SCRIPT}`,
  'scripts/calculate_market.py',
  'scripts/build_report_data.py',
  'scripts/build_report.py',
  'scripts/evidence_index.py',
  'schemas/valuation-report-data.schema.json',
  'template/valuation-report.html',
]
const RUNTIME_PATH = '/dsh/python/bin/python3'

const PYTHON_STUB = {
  cached: () => null,
  check: async () => ({
    ok: true, state: 'ok', path: RUNTIME_PATH, versionText: '3.12.4',
    distributions: { openpyxl: '3.1.5' }, missingPackages: [], error: '', source: 'stub',
  }),
}

/** 内存 fs + 可编排 shell：只回答案例内路径事实与一次 Python 调用。 */
function makeCtx({ pythonStdout, pythonExitCode = 0, pythonStderr = '' } = {}) {
  const files = new Map()
  const directories = new Set([WORKSPACE, CASE_DIR, `${CASE_DIR}/方案`, PLAN_DIR])
  const commands = []
  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey)
        ? { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) { files.set(target.targetKey, content); return { operation: 'create', version: 'v' } },
    async mkdir(target) { directories.add(String(target.targetKey)); return { version: 'v' } },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }
  const shell = {
    resolve: (request) => ({ ...request, workdir: request?.workdir ?? WORKSPACE, timeoutMs: 1, stdoutMaxBytes: 65536 }),
    async execute(spec) {
      const command = String(spec?.command ?? '')
      commands.push(command)
      const probe = probeAnswer(command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(probeKey(path)),
      })
      const isScriptRun = command.includes(SCRIPT)
      const exitCode = isScriptRun ? pythonExitCode : 0
      applyShellEffect(command, exitCode, {
        addDir: (path) => directories.add(probeKey(path)),
        removeFile: (path) => { files.delete(path) },
      })
      const stdout = probe !== undefined ? probe
        : isScriptRun
          ? (pythonStdout ?? JSON.stringify({ reused: false, outputs: OUTPUTS }))
          : ''
      const stderr = isScriptRun ? pythonStderr : ''
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false },
        }),
      }
    },
  }
  return {
    files, directories, commands,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shell
      return undefined
    },
    effect() { return () => {} },
  }
}

function makeDeps({ ctx = makeCtx(), python = PYTHON_STUB } = {}) {
  const scopes = new ValuationScopes()
  const state = {
    localAccess: grantedConsent(), workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区', caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, scopes,
    deps: {
      ctx, state, access,
      config: {},
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
      ...(python === undefined ? {} : { python }),
      world: {
        platform: async () => 'darwin-arm64', home: async () => '/Users/x',
        workdir: async () => WORKSPACE, cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
      },
    },
  }
}

/** Register the valuation round and its plan; the Tool only ever reads this registry. */
function openValuation(scopes, { sessionId = 'valuation-session-1', planIds = [PLAN_ID] } = {}) {
  scopes.open({
    valuationId: VALUATION_ID, casePath: CASE_DIR, sessionId,
    workspaceId: 'w1', workspacePath: WORKSPACE,
    projectId: VALUATION_ID, planIds,
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
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'), name: 'crwu_valuation_listing_reference',
    arguments: {}, signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

/** Fixed input file: identity fields are the ones the Tool must cross-check against scope. */
function writeInput(ctx, dir, { projectId = VALUATION_ID, planId = PLAN_ID } = {}) {
  ctx.files.set(`${dir}/${INPUT_FILE}`, JSON.stringify({
    valuationMode: 'listing-reference', projectId, planId,
    inputDigest: 'sha256:' + 'a'.repeat(64),
  }))
}

function placeOutputs(ctx, dir) {
  for (const name of OUTPUTS) ctx.files.set(`${dir}/${name}`, `${name}-bytes`)
}

async function runTool(setup, args, sessionId = 'valuation-session-1') {
  const { valuationListingReferenceTools } = await import(TOOL_SOURCE.href)
  const tool = valuationListingReferenceTools(setup.deps)[0]
  return await tool.execute({ caseDir: CASE_DIR, planId: PLAN_ID, ...args }, execOf(sessionId))
}

function skipIfMissing(t) {
  if (toolDelivered) return false
  t.skip('listing-reference.ts 尚未交付')
  return true
}

/** Read one CLI flag value from a composed command (quote-agnostic, spaces unsupported in paths). */
function argValue(command, flag) {
  const match = new RegExp(`${flag}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`).exec(command)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

test('挂牌参考 Tool 已交付到固定源文件', () => {
  assert.equal(
    toolDelivered,
    true,
    '缺少挂牌参考 Tool：src/host/tools/report-evaluation/listing-reference.ts'
      + '（固定输入 挂牌参考输入.json，一次交付 计算轨迹/估值底稿/估值报告数据/估值报告）',
  )
})

test('注册面与参数面：名称固定，参数只有 caseDir / planId / revision', async (t) => {
  if (skipIfMissing(t)) return
  const { valuationListingReferenceTools } = await import(TOOL_SOURCE.href)
  const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
  const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(
    new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
  assert.equal(VALUATION_TOOL_NAMES.listingReference, 'crwu_valuation_listing_reference')
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_listing_reference'), true,
    '挂牌参考 Tool 必须进注册清单')
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_valuation_listing_reference'), false,
    '它不是审核必需工具')

  const { deps } = makeDeps()
  const tool = valuationListingReferenceTools(deps)[0]
  const inputProperties = tool.parameters.properties ?? tool.parameters
  const keys = Object.keys(inputProperties).sort()
  assert.deepEqual(keys, ['caseDir', 'planId', 'revision'])
  // `description` is schema metadata and may legitimately mention "script"; only actual input
  // property names are constrained here.
  for (const forbidden of ['command', 'argv', 'script', 'path', 'url', 'python']) {
    assert.equal(keys.includes(forbidden), false, `参数面不许出现输入键 ${forbidden}`)
  }
})

test('非估值会话被拒，且不落任何文件、不发任何命令', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  const result = await runTool(setup, {}, '随便一条会话')
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.equal(ctx.commands.length, 0)
  assert.equal(ctx.files.size, 0, '被拒的调用不得落任何脚本 / 产物')
})

test('外来案例目录在 Python I/O 之前被拒', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  const result = await runTool(setup, { caseDir: `${WORKSPACE}/另一个案例` })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.equal(ctx.commands.length, 0)
})

test('未登记方案在 Python I/O 之前被拒', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes, { planIds: ['plan-其它'] })
  writeInput(ctx, PLAN_DIR)
  const result = await runTool(setup, {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(String(result.error), /方案|plan/)
  assert.equal(ctx.commands.length, 0)
})

test('不安全的方案标识在 Python I/O 之前被拒', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  for (const planId of ['../escape', 'a/b', '']) {
    const result = await runTool(setup, { planId })
    assert.equal(result.ok, false, `planId=${JSON.stringify(planId)} 必须被拒`)
    assert.ok(String(result.error).length > 0, '拒绝必须给出人话原因')
    assert.ok(['input', 'policy'].includes(result.errorKind), `拒绝类别应可解释：${result.errorKind}`)
  }
  assert.equal(ctx.commands.length, 0)
})

test('固定输入里的 projectId / planId 必须与本轮 scope 一致', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR, { projectId: '另一个项目' })
  const wrongProject = await runTool(setup, {})
  assert.equal(wrongProject.ok, false)
  assert.equal(wrongProject.errorKind, 'input')

  const ctx2 = makeCtx()
  const setup2 = makeDeps({ ctx: ctx2 })
  openValuation(setup2.scopes)
  writeInput(ctx2, PLAN_DIR, { planId: '另一个方案' })
  const wrongPlan = await runTool(setup2, {})
  assert.equal(wrongPlan.ok, false)
  assert.equal(wrongPlan.errorKind, 'input')
  assert.equal(ctx.commands.length, 0)
  assert.equal(ctx2.commands.length, 0)
})

test('缺 DSH Python 运行时 → capability-gap，且在起进程之前返回', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  // Delete rather than pass `undefined`: a default parameter would re-apply the stub.
  delete setup.deps.python
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  placeOutputs(ctx, PLAN_DIR)
  const result = await runTool(setup, {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(ctx.commands.length, 0)
})

test('成功：只跑一次打包脚本，装载全部依赖，四个产物齐备后回 partial', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  placeOutputs(ctx, PLAN_DIR)
  const result = await runTool(setup, {})

  assert.equal(result.ok, true, result.error)
  assert.equal(result.status, 'partial', '挂牌参考只可能是 partial')
  assert.notEqual(result.status, 'completed', '绝不许回 completed')
  assert.equal(result.caseDir, CASE_DIR)
  assert.equal(result.planId, PLAN_ID)

  const runs = ctx.commands.filter((command) => command.includes(SCRIPT))
  assert.equal(runs.length, 1, '只许跑一次打包脚本')
  const command = runs[0]
  assert.equal(command.includes(RUNTIME_PATH), true, '必须用配置的 DSH Python 运行时')
  assert.match(command, /scripts[\\/]build_listing_reference\.py/, '只跑打包的固定脚本')
  assert.equal(command.includes('--input'), true)
  assert.equal(command.includes('--out-dir'), true)
  assert.equal(command.includes('--case-root'), true)
  assert.equal(command.includes('--command'), false, '不许夹带任意命令参数')

  for (const relative of STAGED_FILES) {
    assert.equal(ctx.files.has(`${CASE_DIR}/${relative}`), true, `必须把 ${relative} 一起落盘`)
  }
  for (const name of OUTPUTS) {
    assert.equal(ctx.files.has(`${PLAN_DIR}/${name}`), true)
  }
})

test('进程退出 0 但四个产物缺失 → 结构化失败，绝不回 partial', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  // Deliberately no outputs: the fake process still exits 0.
  const result = await runTool(setup, {})
  assert.equal(result.ok, false)
  assert.notEqual(result.status, 'partial')
  assert.match(String(result.error), /缺少|missing|不完整|产物/)
  assert.equal(ctx.commands.filter((command) => command.includes(SCRIPT)).length, 1,
    '进程确实成功跑过，只是产物缺失')
})

test('只缺一个产物也必须结构化失败（四个都要核验）', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  for (const name of OUTPUTS) {
    if (name !== '估值报告.html') ctx.files.set(`${PLAN_DIR}/${name}`, `${name}-bytes`)
  }
  const result = await runTool(setup, {})
  assert.equal(result.ok, false, '缺 HTML 也必须失败')
  assert.notEqual(result.status, 'partial')
})

test('revision > 1：用该修订的输入 / 输出，case-root 仍是基础方案目录', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  ctx.directories.add(`${PLAN_DIR}/修订`)
  ctx.directories.add(REVISION_DIR)
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, REVISION_DIR)
  placeOutputs(ctx, REVISION_DIR)
  const result = await runTool(setup, { revision: REVISION })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.status, 'partial')
  const command = ctx.commands.find((item) => item.includes(SCRIPT))
  assert.notEqual(command, undefined)
  assert.equal(argValue(command, '--input'), `${REVISION_DIR}/${INPUT_FILE}`,
    '读的是修订目录里的固定输入')
  assert.equal(argValue(command, '--out-dir'), REVISION_DIR, '写的是修订目录')
  assert.equal(argValue(command, '--case-root'), PLAN_DIR,
    'case-root 必须是基础方案目录，不是修订目录')
  for (const name of OUTPUTS) {
    assert.equal(ctx.files.has(`${REVISION_DIR}/${name}`), true, `修订产物 ${name} 要核验`)
  }
})

// ── Host adapter regressions (red until the follow-up implementation correction) ────────────────

test('runtime check receives the caller valuation-session agent context', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  let observedCheck
  const resolver = {
    cached: () => null,
    check: async (options) => {
      observedCheck = options
      return {
        ok: true, state: 'ok', path: RUNTIME_PATH, versionText: '3.12.4',
        distributions: {}, missingPackages: [], error: '', source: 'stub',
      }
    },
  }
  const setup = makeDeps({ ctx, python: resolver })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  placeOutputs(ctx, PLAN_DIR)
  const result = await runTool(setup, {})
  assert.equal(result.ok, true, result.error)
  assert.equal(observedCheck?.agent?.id, 'valuation-session-1',
    'runtime check 必须带上调用方（本轮估值会话）的 agent 上下文')
})

test('Python stdout reused=true is reported truthfully; the default stays false', async (t) => {
  if (skipIfMissing(t)) return
  const reusedCtx = makeCtx({ pythonStdout: JSON.stringify({ reused: true, outputs: OUTPUTS }) })
  const reusedSetup = makeDeps({ ctx: reusedCtx })
  openValuation(reusedSetup.scopes)
  writeInput(reusedCtx, PLAN_DIR)
  placeOutputs(reusedCtx, PLAN_DIR)
  const reused = await runTool(reusedSetup, {})
  assert.equal(reused.ok, true, reused.error)
  assert.equal(reused.reused, true, 'stdout 自报 reused=true 必须如实回传')

  const freshCtx = makeCtx()
  const freshSetup = makeDeps({ ctx: freshCtx })
  openValuation(freshSetup.scopes)
  writeInput(freshCtx, PLAN_DIR)
  placeOutputs(freshCtx, PLAN_DIR)
  const fresh = await runTool(freshSetup, {})
  assert.equal(fresh.ok, true, fresh.error)
  assert.equal(fresh.reused, false, '默认（stdout reused=false）必须是 false')
})

test('invalid fixed JSON becomes an input error that does not echo the raw marker', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  ctx.files.set(`${PLAN_DIR}/${INPUT_FILE}`, '{"secret": FAKESECRET}')
  const result = await runTool(setup, {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
  assert.equal(String(result.error).includes('FAKESECRET'), false,
    '解析失败的原始输入不得回显到模型可见错误里')
  assert.equal(ctx.commands.length, 0, '坏输入必须在起进程之前被拒')
})

test('nonzero Python exit is a structured failure that does not echo the raw stderr marker', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx({ pythonExitCode: 1, pythonStderr: 'boom FAKESECRET' })
  const setup = makeDeps({ ctx })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  placeOutputs(ctx, PLAN_DIR)
  const result = await runTool(setup, {})
  assert.equal(result.ok, false)
  assert.equal(String(result.error).includes('FAKESECRET'), false,
    '子进程 stderr 原文不得回显到模型可见错误里')
})

test('unusable Python runtime is capability-gap without echoing the resolver marker', async (t) => {
  if (skipIfMissing(t)) return
  const ctx = makeCtx()
  const resolver = {
    cached: () => null,
    check: async () => ({
      ok: false, state: 'failed', path: '', versionText: '',
      distributions: {}, missingPackages: [], error: 'resolver FAKESECRET', source: 'stub',
    }),
  }
  const setup = makeDeps({ ctx, python: resolver })
  openValuation(setup.scopes)
  writeInput(ctx, PLAN_DIR)
  placeOutputs(ctx, PLAN_DIR)
  const result = await runTool(setup, {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.equal(String(result.error).includes('FAKESECRET'), false,
    '运行时错误原文不得回显到模型可见错误里')
})

/**
 * `crwu_valuation_recalculate` 的接线测试（协议 39）。
 *
 * 这一条是"真实计算"里最容易变成自我声明的地方：`重算结论.json` 落在方案目录里、模型写得到。
 * 所以这里钉的是**它不能由模型宣布**：
 *
 * 1. 没有配置表格计算程序 → `unavailable` + `verified: false`（**不会**写一份"算过了"的记录）；
 * 2. 有引擎时才真的跑：引擎调用、回读脚本各自走**命名 Broker 操作**；
 * 3. `verified` 只由**回读值与报告数据逐项一致**决定 —— 不一致就是 false + 逐项差异；
 * 4. 记录由 Host 写（`producedBy: 'host'`），位置随修订版本走。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationRecalculateTools } = await import(new URL('src/host/tools/report-evaluation/recalculate.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { DEFAULT_VALUATION_RECALCULATION } = await import(new URL('src/host/config/config.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261015-170000-cc33'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const PLAN_ID = 'plan-001'
const PLAN_DIR = `${CASE_DIR}/方案/${PLAN_ID}`
const ENGINE = '/opt/spreadsheet/bin/soffice'

const REPORT_DATA = JSON.stringify({
  conclusions: [
    { objectId: 'object-001', unitPrice: '39800', totalValue: '4786000' },
  ],
})

/** 只回答文件读写、mkdir 与两条命名操作的宿主。 */
function makeCtx({ readBack = null, engineFails = false } = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR, `${CASE_DIR}/方案`, PLAN_DIR, `${CASE_DIR}/scripts`])
  const files = new Map(Object.entries({
    [`${PLAN_DIR}/估值报告数据.json`]: REPORT_DATA,
    [`${PLAN_DIR}/估值底稿.xlsx`]: 'PK\u0003\u0004假的工作簿字节',
  }))
  const commands = []
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir ?? WORKSPACE, timeoutMs: 1, stdoutMaxBytes: 65536 }),
    async execute(spec) {
      commands.push(spec.command)
      const probe = probeAnswer(spec.command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(probeKey(path)),
      })
      const answer = probe !== undefined ? probe
        : spec.command.includes('read_workbook_values.py') ? readBack
          : ''
      const exitCode = engineFails && spec.command.includes('/soffice') ? 1 : 0
      // 引擎命令失败时 `applyShellEffect` 自己会跳过（退出码非 0 不动文件系统）。
      applyShellEffect(spec.command, exitCode, {
        addDir: (path) => directories.add(probeKey(path)),
        removeFile: (path) => files.delete(path),
      })
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: answer ?? '', truncated: false },
          stderr: { text: exitCode === 0 ? '' : 'soffice: command failed', truncated: false },
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

/** 回读脚本的输出（形状与 `read_workbook_values.py` 一致）。 */
function readBackPayload(observed, problems = []) {
  return JSON.stringify({ observed, problems })
}

function makeDeps({ ctx = makeCtx(), enginePath = ENGINE } = {}) {
  const scopes = new ValuationScopes()
  const state = {
    localAccess: grantedConsent(), workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区', caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  const config = {
    valuation: {
      browser: { sitesFile: 'x', requiredSiteIds: [], optionalSiteIds: [], assistLoginChallenge: true },
      knowledge: { mirrorRoot: '', wikiPath: 'w', manifestPath: 'm' },
      recalculation: { ...DEFAULT_VALUATION_RECALCULATION, enginePath },
    },
  }
  return {
    ctx, config, scopes,
    deps: {
      ctx, config, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
      world: { platform: async () => 'darwin-arm64', workdir: async () => WORKSPACE },
      python: {
        check: async () => ({ ok: true, state: 'ready', path: '/usr/bin/python3', versionText: '3.11.0', source: 'dsh', error: '' }),
      },
    },
  }
}

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
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'), name: VALUATION_TOOL_NAMES.recalculate,
    arguments: {}, signal: new AbortController().signal, agent: { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

const OBSERVATIONS = [{ objectId: 'object-001', unitPriceCell: '估值结果汇总!J5', totalValueCell: '估值结果汇总!L5' }]

async function run(setup, args) {
  const { deps, scopes } = setup
  const sessionId = scopes.get(VALUATION_ID)?.sessionId ?? openValuation(scopes)
  const tool = valuationRecalculateTools(deps)[0]
  return await tool.execute({ caseDir: CASE_DIR, planId: PLAN_ID, ...args }, execOf(sessionId))
}

test('注册面：重算 Tool 在注册清单里，但**不在**审核必需集', () => {
  assert.equal(VALUATION_TOOL_NAMES.recalculate, 'crwu_valuation_recalculate')
  assert.equal(CRWU_BUSINESS_TOOLS.includes('crwu_valuation_recalculate'), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_valuation_recalculate'), false)
})

test('没有配置表格计算程序 → unavailable + verified:false，并写明只能 partial', async () => {
  const ctx = makeCtx()
  const setup = makeDeps({ ctx, enginePath: '' })
  const result = await run(setup, { observations: OBSERVATIONS })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.state, 'unavailable')
  assert.equal(result.verified, false, '没有引擎就永远不许 verified')
  assert.match(result.reason, /没有配置表格计算程序/)
  assert.match(result.reason, /partial/)
  assert.deepEqual(result.providers, [])
  // 记录仍然写：它是**如实**的"待重算"，而不是"算过了"。
  assert.equal(result.recordPath, `方案/${PLAN_ID}/重算结论.json`)
  const record = JSON.parse(ctx.files.get(`${PLAN_DIR}/重算结论.json`))
  assert.equal(record.state, 'unavailable')
  assert.equal(record.verified, false)
  assert.equal(record.producedBy, 'host')
  assert.equal(ctx.commands.length, 0, '没有引擎时一个命令都不发')
})

test('没给「对象 → 数值位置」时拒绝：Host 不猜格子', async () => {
  const setup = makeDeps({ ctx: makeCtx() })
  const result = await run(setup, { observations: [] })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
  assert.match(result.error, /不猜位置/)
})

test('有引擎时真的跑：引擎与回读各走一条命名操作，回读一致 → verified', async () => {
  const ctx = makeCtx({ readBack: readBackPayload([{ objectId: 'object-001', unitPrice: '39800', totalValue: '4786000' }]) })
  const setup = makeDeps({ ctx })
  const result = await run(setup, { observations: OBSERVATIONS })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.state, 'recalculated')
  assert.equal(result.verified, true, JSON.stringify(result.mismatches))
  assert.equal(result.providerId, 'libreoffice.local')
  assert.deepEqual(result.observed, [{ objectId: 'object-001', unitPrice: '39800', totalValue: '4786000' }])

  // 引擎调用：命令由 Host 拼（引擎路径 + 固定参数 + 两个 Host 推出的绝对路径）。
  const engineCommand = ctx.commands.find((item) => item.includes('/soffice'))
  assert.notEqual(engineCommand, undefined, '必须真的调用配置的引擎')
  assert.match(engineCommand, /--headless/)
  assert.match(engineCommand, /--convert-to/)
  // 回读脚本：落在案例内（python.script.run 只接受案例内脚本），argv 逐个传。
  const readCommand = ctx.commands.find((item) => item.includes('read_workbook_values.py'))
  assert.notEqual(readCommand, undefined, '必须真的回读')
  assert.match(readCommand, /--workbook/)
  assert.equal(readCommand.includes('--cells'), true)

  const record = JSON.parse(ctx.files.get(`${PLAN_DIR}/重算结论.json`))
  assert.equal(record.state, 'recalculated')
  assert.equal(record.verified, true)
  assert.equal(record.producedBy, 'host')
  assert.deepEqual(record.expected, [{ objectId: 'object-001', unitPrice: '39800', totalValue: '4786000' }])
})

test('回读值与报告数据不一致 → verified:false 并把逐项差异写进记录', async () => {
  const ctx = makeCtx({ readBack: readBackPayload([{ objectId: 'object-001', unitPrice: '39000', totalValue: '4786000' }]) })
  const setup = makeDeps({ ctx })
  const result = await run(setup, { observations: OBSERVATIONS })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.state, 'recalculated')
  assert.equal(result.verified, false, '不一致就不许 verified')
  assert.match(result.mismatches.join('；'), /JSON=39800 底稿=39000/)
  const record = JSON.parse(ctx.files.get(`${PLAN_DIR}/重算结论.json`))
  assert.equal(record.verified, false)
  assert.equal(record.mismatches.length, 1)
})

test('回读读不到该对象 → 也算不一致（"读不到"和"对得上"是两件事）', async () => {
  const ctx = makeCtx({ readBack: readBackPayload([{ objectId: 'object-001', unitPrice: null, totalValue: null }]) })
  const setup = makeDeps({ ctx })
  const result = await run(setup, { observations: OBSERVATIONS })
  assert.equal(result.verified, false)
  assert.match(result.mismatches.join('；'), /单价 JSON=39800 底稿=\(空\)/)
})

test('引擎失败 → failed + 记录写明原因，绝不写成"重算过"', async () => {
  const ctx = makeCtx({ engineFails: true })
  const setup = makeDeps({ ctx })
  const result = await run(setup, { observations: OBSERVATIONS })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.state, 'failed')
  assert.equal(result.verified, false)
  assert.match(result.reason, /表格计算程序没有成功重算/)
  const record = JSON.parse(ctx.files.get(`${PLAN_DIR}/重算结论.json`))
  assert.equal(record.state, 'failed')
  assert.equal(record.verified, false)
})

test('修订版本 > 1：重算该版本目录下的底稿，结论也写在该版本下', async () => {
  const ctx = makeCtx({ readBack: readBackPayload([{ objectId: 'object-001', unitPrice: '39800', totalValue: '4786000' }]) })
  ctx.files.set(`${PLAN_DIR}/修订/2/估值底稿.xlsx`, 'PK\u0003\u0004假的工作簿字节')
  ctx.files.set(`${PLAN_DIR}/修订/2/估值报告数据.json`, REPORT_DATA)
  ctx.directories.add(`${PLAN_DIR}/修订`)
  ctx.directories.add(`${PLAN_DIR}/修订/2`)
  const setup = makeDeps({ ctx })
  const result = await run(setup, { observations: OBSERVATIONS, revision: 2 })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.recordPath, `方案/${PLAN_ID}/修订/2/重算结论.json`)
  const readCommand = ctx.commands.find((item) => item.includes('read_workbook_values.py'))
  assert.match(readCommand, /修订\/2/)
})

test('非估值会话被拒，且不落任何文件、不发任何命令', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ ctx })
  const tool = valuationRecalculateTools(deps)[0]
  const result = await tool.execute(
    { caseDir: CASE_DIR, planId: PLAN_ID, observations: OBSERVATIONS }, execOf('随便一条会话'))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.equal(ctx.files.has(`${PLAN_DIR}/重算结论.json`), false)
  assert.equal(ctx.commands.length, 0)
})

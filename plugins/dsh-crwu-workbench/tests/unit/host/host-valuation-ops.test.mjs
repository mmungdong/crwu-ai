/**
 * 估值 Host 操作的**接线**测试（协议 32 · 计划 Task 2 重写）。
 *
 * 这一层验的是"操作表把 handler 接对了没有"，所以断言都落在**可观察的接线事实**上：
 *
 * 1. `valuation-intake` 只做本机的事：**不调 Python 提取、不拉知识、不发一个网络请求**，
 *    而且逐份资料真的按字节复制进了 `材料-源/`（材料目录的命令必须**提权** ——
 *    面板没有会话，非特权命令会被自家沙箱拒掉，2026-10-13 真机实测）；
 * 2. `valuation-start` 从 **Host 预览**读条件（不接受第二套方法 / 基准日 / 补充要求），
 *    只发 `workspaceId` 建会话（没有 `cwd` 兜底），交接成功后落**不含绝对路径**的冻结输入；
 * 3. 双击 / 重放只有一个父会话、一条指令；
 * 4. v1 遗留的完成度操作（状态 / 取消 / 结果 / 打开交付件）在迁移期仍然如实回答 ——
 *    包括"磁盘上的冻结输入被改过"这件事（v2 文件不会被误报成被改过）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyShellEffect, probeAnswer } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent, missingConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createValuationOperations } = await import(new URL('src/host/operations/report-evaluation.ts', ROOT).href)
const { createValuationBrowserRuntime } = await import(
  new URL('src/host/domains/report-evaluation/browser/runtime.ts', ROOT).href)
const { resolveWorkbenchConfig } = await import(new URL('src/host/config/config.ts', ROOT).href)
const { ValuationLifecycles } = await import(new URL('src/host/domains/report-evaluation/lifecycle/index.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)
const { VALUATION_CHILD_TOOLS } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { VALUATION_FIELD_KEYS } = await import(new URL('src/host/operations/report-evaluation.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

/** 本文件造出来的临时目录，跑完统一删。 */
const TEMPS = []
test.after(() => {
  for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMPS.push(dir)
  return dir
}

/** 一个资料目录：`[[文件名, 内容], …]`。 */
function sourceDir(spec) {
  const dir = tempDir('crwu-ops-src-')
  for (const [name, content] of spec) writeFileSync(join(dir, name), content)
  return dir
}

const realDir = (path) => existsSync(path) && statSync(path).isDirectory()
const realFile = (path) => existsSync(path) && statSync(path).isFile()

/**
 * 内存 fs（案例目录里的 JSON 走它）+ **真实文件系统**的 shell 替身。
 *
 * 资料是真实文件：归档复制（`cp -f`）与回读指纹都按真实字节走 —— 用假的字节映射去测
 * "归档副本的指纹"等于把被测对象换掉。
 */
function makeCtx({ workspace } = {}) {
  const files = new Map()
  const shellCalls = []
  const prompts = []
  const controllerRequests = []
  const sessionHeaders = new Map()
  const agents = new Map()
  let minted = 0

  const entity = {
    id: 'w1', path: workspace, title: '工作区', sessionIds: [],
    async attachSession(sessionId) {
      const cwd = sessionHeaders.get(sessionId)?.cwd ?? ''
      if (cwd !== this.path) throw new Error(`cwd ${cwd} != ${this.path}`)
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
    },
  }

  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (files.has(target.targetKey)) {
        return { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' }
      }
      return key === '' ? undefined : (realDir(key) ? { type: 'directory', version: 'v' } : undefined)
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
      shellCalls.push({
        command,
        mode: String(request?.sandboxPolicy?.mode ?? ''),
        hasPolicy: request?.sandboxPolicy !== undefined,
      })
      // 真实复制：`cp -f -- <源> <目标>`（POSIX）。`shellQuote` 对"安全字符"**不加引号**，
      // 所以两侧都要接受"带引号 / 裸参数"两种形态 —— 只认一种的话，纯 ASCII 路径根本不会真的复制，
      // 而测试会在别处报出一个看不懂的 ENOENT。
      const copyMatch = /^cp -f -- (?:'([^']*)'|(\S+)) (?:'([^']*)'|(\S+))$/.exec(command.trim())
      const powershell = /^Copy-Item -LiteralPath '([^']*)' -Destination '([^']*)' -Force$/.exec(command.trim())
      const from = copyMatch === null ? undefined : (copyMatch[1] ?? copyMatch[2])
      const to = copyMatch === null
        ? (powershell === null ? undefined : powershell[1])
        : (copyMatch[3] ?? copyMatch[4])
      if (from !== undefined && to !== undefined) {
        try {
          mkdirSync(join(to, '..'), { recursive: true })
          copyFileSync(from, to)
        } catch (error) {
          return { result: async () => exit(1, `cp: ${error instanceof Error ? error.message : String(error)}`) }
        }
      }
      const probe = probeAnswer(command, { hasDir: realDir, hasFile: realFile })
      applyShellEffect(command, 0, {
        addDir: (path) => mkdirSync(path, { recursive: true }),
        removeFile: (path) => rmSync(path, { force: true }),
      })
      return { result: async () => exit(0, probe ?? '') }
    },
  }

  const ctx = {
    files, shellCalls, prompts, controllerRequests, entity,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellService
      if (name === 'workspaceRegistry') {
        return { get: (id) => (id === 'w1' ? entity : undefined), list: () => [{ id: 'w1', path: workspace, title: '工作区' }] }
      }
      if (name === 'sessions') return { get: (id) => (sessionHeaders.has(id) ? { header: sessionHeaders.get(id) } : undefined) }
      if (name === 'sessionController') {
        return {
          async create(request) {
            controllerRequests.push(request)
            const sessionId = request.sessionId ?? `session-val-${minted += 1}`
            sessionHeaders.set(sessionId, { cwd: workspace })
            agents.set(sessionId, {
              id: sessionId,
              followup(message) { prompts.push({ sessionId, message }) },
            })
            await entity.attachSession(sessionId)
            return { sessionId }
          },
          async rename() {},
        }
      }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'tools') {
        return { get: (toolName) => (VALUATION_CHILD_TOOLS.includes(toolName) ? { name: toolName } : undefined) }
      }
      return undefined
    },
  }
  return ctx
}

function exit(exitCode, text) {
  return {
    exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text, truncated: false }, stderr: { text: exitCode === 0 ? '' : text, truncated: false },
  }
}

function makeDeps({ ctx, consent = undefined } = {}) {
  const workspace = ctx.entity.path
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: workspace, workspaceTitle: '工作区',
    caseRoot: workspace,
  }
  const { access } = consent === 'missing'
    ? makeTestAccess(ctx, { state: { ...state, localAccess: missingConsent('测试：未授权') } })
    : makeTestAccess(ctx, { state })
  const lifecycles = new ValuationLifecycles()
  const scopes = new ValuationScopes()
  const world = {
    platform: async () => 'darwin-arm64',
    home: async () => '/Users/x',
    workdir: async () => workspace,
    cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
  }
  // 与 `apply()` 同一条组合路径：门禁三操作来自浏览器 runtime（不在 `createValuationOperations` 里）。
  // 少 spread 它，这个夹具就会与生产不一致 —— 而"夹具说没有、生产里有"是最容易误导人的一种红。
  const browserRuntime = createValuationBrowserRuntime({
    ctx, config: resolveWorkbenchConfig({}), access, world,
  })
  return {
    ctx, state, lifecycles, scopes, workspace,
    ops: {
      ...createValuationOperations({ ctx, state, access, world, lifecycles, scopes }),
      ...browserRuntime.operations,
    },
  }
}

/** 走一遍新契约的准备流程：返回预览结果。 */
async function prepare(deps, paths, patch = {}) {
  return await deps.ops['valuation-intake']({
    requestId: patch.requestId ?? 'req-1',
    paths,
    // 资产类型（协议 39）：通用入口的第一个选择，未选由 Host 直接拒绝。
    assetType: patch.assetType ?? 'real-estate',
    method: patch.method ?? 'market',
    baseDate: patch.baseDate ?? '',
    purpose: patch.purpose ?? '',
    valueType: patch.valueType ?? '',
    supplementalPrompt: patch.supplementalPrompt ?? '',
  })
}

// ── 资料入口：只做本机的事 ──────────────────────────────────────────────────

test('valuation-files-scan：没有选择时回空清单，不起任何命令', async () => {
  const ctx = makeCtx({ workspace: tempDir('crwu-ops-ws-') })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const result = await ops['valuation-files-scan']({ paths: [] })
  assert.equal(result.ok, true)
  assert.equal(result.fileCount, 0)
  assert.equal(theCtx.shellCalls.length, 0)
})

test('valuation-intake：递归归档 + 对归档副本算指纹；**不提取、不拉知识、不发网络**', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes'], ['说明.txt', 'text-bytes']])

  // 网络被彻底钉死：这一条操作敢发一个请求就会在这里炸。
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('valuation-intake 不许发网络请求') }
  let preview
  try {
    preview = await prepare({ ops, ctx: theCtx }, [dir])
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(preview.ok, true, preview.error)
  assert.match(preview.inputDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(preview.previewId, preview.projectId)
  assert.equal(preview.files.length, 2)
  // 元信息：面板看得到原始绝对路径，创建时间取不到就是 null（不许拿 mtime 冒充）。
  assert.equal(preview.files[0].absolutePath, join(dir, '报告.pdf'))
  assert.equal(preview.files[0].createdAt === null || typeof preview.files[0].createdAt === 'string', true)
  assert.equal(preview.files[0].archiveRelativePath, '材料-源/报告.pdf')
  assert.deepEqual(
    preview.files.map((file) => file.archiveRelativePath).sort(),
    ['材料-源/报告.pdf', '材料-源/说明.txt'],
  )
  // 归档真的落到了磁盘，而且与源文件**逐字节相同**（案例目录在员工选定的工作空间下）。
  for (const file of preview.files) {
    const archived = join(preview.casePath, file.archiveRelativePath)
    assert.equal(realFile(archived), true, file.archiveRelativePath)
    assert.deepEqual(readFileSync(archived), readFileSync(file.absolutePath), file.archiveRelativePath)
  }
  // ① 不提取：一次 Python 提取都没跑。
  assert.equal(theCtx.shellCalls.some((call) => /extract_files\.py|python/.test(call.command)), false)
  // ② 不拉知识、不问站点、不打开浏览器（只看命令动词，不看路径 —— 临时目录名里可能带 crwu）。
  assert.equal(theCtx.shellCalls.some((call) => /^(dws|crwu|ossutil|open)\b/.test(call.command.trim())), false)
  // ③ 只读的路径探测 + mkdir + cp 这几种命令，别的没有。
  const kinds = new Set(theCtx.shellCalls.map((call) => {
    if (call.command.startsWith('cp -f')) return 'copy'
    if (call.command.startsWith('mkdir')) return 'mkdir'
    return 'probe'
  }))
  assert.deepEqual([...kinds].sort(), ['copy', 'mkdir', 'probe'])
})

test('valuation-intake：材料目录与项目目录的命令必须**提权**（面板没有会话）', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir])
  assert.equal(preview.ok, true, preview.error)

  // 路径里带项目 id 的那几条（建目录 / 复制）必须逐次声明提权；
  // 只读探测同样在同一批里（它也要读工作空间之外的路径）。
  const touched = theCtx.shellCalls.filter((call) => call.command.includes(preview.projectId))
  assert.equal(touched.length > 0, true, `没有碰项目目录的命令：${theCtx.shellCalls.map((call) => call.command).join(' | ')}`)
  for (const call of touched) {
    assert.equal(call.mode, 'danger-full-access',
      `项目目录里的命令必须提权：${call.mode || '（无策略）'} · ${call.command}`)
  }
})

test('valuation-intake：31 份整批拒绝（不悄悄截取前 30 份）', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const dir = sourceDir(Array.from({ length: 31 }, (_, index) => [`f${index}.pdf`, `bytes-${index}`]))
  const preview = await prepare({ ops, ctx: theCtx }, [dir])
  assert.equal(preview.ok, false)
  assert.equal(preview.errorKind, 'input-invalid')
  assert.match(preview.error, /31/)
  assert.equal(theCtx.controllerRequests.length, 0)
})

test('valuation-intake：多份资料对同一要素给出不同值时，冲突要**如实列出来**而不是静默取第一个（Task 2：intake 不解析、不合并，冲突归父会话）', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  // 两份资料对同一个要素（建筑面积）给了不同的值：以前 intake 会"首个非空值胜出"。
  const first = sourceDir([['报告.pdf', '建筑面积 120.5']])
  const second = sourceDir([['报告.pdf', '建筑面积 98.0']])
  const preview = await prepare({ ops, ctx: theCtx }, [first, second])
  assert.equal(preview.ok, true, preview.error)

  // ① 两份原样都在（谁都没被丢掉），而且内容确实不同。
  assert.equal(preview.files.length, 2)
  assert.notEqual(preview.files[0].sha256, preview.files[1].sha256)
  assert.deepEqual(
    preview.files.map((file) => file.archiveRelativePath),
    ['材料-源/报告.pdf', '材料-源/报告-2.pdf'],
  )
  // ② **结构上不可能静默选择**：预览里没有任何字段合并结果（v1 的
  //    `extractedFields` / `fieldSources` / `fieldConflicts` / `missingFields` 已删）。
  //    冲突的判定与询问归父会话（Task 6），不在抽屉里替用户做选择。
  for (const gone of ['extractedFields', 'fieldSources', 'fieldConflicts', 'missingFields', 'warnings']) {
    assert.equal(gone in preview, false, `${gone} 不该再出现在归档预览里`)
  }
  // ③ 归档副本里的两份内容都还在（逐字节），复核时能自己看到分歧。
  assert.equal(readFileSync(join(preview.casePath, preview.files[0].archiveRelativePath), 'utf8'), '建筑面积 120.5')
  assert.equal(readFileSync(join(preview.casePath, preview.files[1].archiveRelativePath), 'utf8'), '建筑面积 98.0')
})

test('valuation-intake：多份资料给出**相同**的值时不算冲突（不制造噪音）（Task 2：只记 duplicateOf）', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const first = sourceDir([['a.pdf', '建筑面积 120.5']])
  const second = sourceDir([['b.pdf', '建筑面积 120.5']])
  const preview = await prepare({ ops, ctx: theCtx }, [first, second])
  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.files.length, 2, '内容相同也保留两条（来源关系不能丢）')
  assert.equal(preview.files[1].duplicateOf, preview.files[0].fileId, '只标重复关系，不当成冲突')
  // 不制造噪音：预览里一处"冲突"提示都没有（v1 会在这里产出 fieldConflicts + warnings）。
  assert.equal(JSON.stringify(preview).includes('冲突'), false)
})

// ── 浏览器登录预检（`valuation-browser-preflight`）──────────────────────────
// 这条操作是 "页面可通过默认浏览器登录" 的落点（设计稿 §4.2）。它此前**一次都没被测过**
//（这正是"没人跑过的操作 = 没人知道它坏着"）。

test('valuation-start：方法非法 / 基准日形状不对都在建任何东西之前拒绝（Task 2 后落在 intake 预览）', async () => {
  const ctx = makeCtx({ workspace: tempDir('crwu-ops-ws-') })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const dir = sourceDir([['a.pdf', 'a']])

  // ① 方法非法：预览就拒绝（它不再是"方法由 Client 在 start 时提交"）。
  const badMethod = await prepare({ ops, ctx: theCtx }, [dir], { requestId: 'req-m', method: '瞎猜' })
  assert.equal(badMethod.ok, false)
  assert.match(badMethod.error, /评估方法不合法/)
  // ② 基准日形状 / 存在性不对：同样在预览阶段拒绝（`2026-02-30` 不是"形状对"就算数）。
  const badShape = await prepare({ ops, ctx: theCtx }, [dir], { requestId: 'req-d1', baseDate: '2026/06/30' })
  assert.equal(badShape.ok, false)
  const badDay = await prepare({ ops, ctx: theCtx }, [dir], { requestId: 'req-d2', baseDate: '2026-02-30' })
  assert.equal(badDay.ok, false)
  assert.match(badDay.error, /不存在的日期|不是一个存在的日期/)
  // ③ 缺 requestId 也不许开工。
  const noRequest = await ops['valuation-intake']({
    requestId: '', paths: [dir], assetType: 'real-estate', method: 'market', baseDate: '',
  })
  assert.equal(noRequest.ok, false)
  assert.equal(noRequest.errorKind, 'input-invalid')

  // 三条都被拦在"建任何东西"之前：没有会话、没有轮次、没有 scope。
  assert.equal(theCtx.controllerRequests.length, 0)
  const unknown = await ops['valuation-start']({
    previewId: '估值-不存在', confirmedInputDigest: 'sha256:x', requestId: 'req-x',
  })
  assert.equal(unknown.ok, false)
  assert.equal(theCtx.controllerRequests.length, 0)
})

// ── 交接：从 Host 预览读条件 ────────────────────────────────────────────────

test('valuation-start：缺 confirmedInputDigest / 摘要不一致 —— 拒绝且不建会话', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx, lifecycles, scopes } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir])
  assert.equal(preview.ok, true, preview.error)

  const missing = await ops['valuation-start']({ previewId: preview.previewId, confirmedInputDigest: '', requestId: 'req-1' })
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'input-invalid')

  const changed = await ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: 'sha256:别的', requestId: 'req-1',
  })
  assert.equal(changed.ok, false)
  assert.equal(changed.errorKind, 'conflict')
  assert.equal(theCtx.controllerRequests.length, 0, '不许建会话')
  assert.equal(lifecycles.size, 0)
  assert.equal(scopes.size, 0)
})

test('valuation-start：只发 workspaceId（没有 cwd 兜底）、落 v3 冻结输入、发固定指令并绑 scope', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx, lifecycles, scopes } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir], { supplementalPrompt: '请多考虑地铁因素' })

  const started = await ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1',
  })
  assert.equal(started.ok, true, started.error)
  assert.equal(started.reused, false)
  assert.equal(started.projectId, preview.projectId)

  // ① 会话落点只走统一服务：只发 workspaceId，绝不发 cwd。
  assert.equal(theCtx.controllerRequests.length, 1)
  assert.equal(theCtx.controllerRequests[0].workspaceId, 'w1')
  assert.equal('cwd' in theCtx.controllerRequests[0], false)
  assert.equal(theCtx.entity.sessionIds.includes(started.parentSessionId), true, '会话必须出现在工作区成员清单里')

  // ② 冻结输入（v3）：没有原始绝对路径，摘要与预览一致，资产类型必填。
  const casePath = join(workspace, preview.projectId)
  const frozen = JSON.parse(theCtx.files.get(join(casePath, '估值输入.json')))
  assert.equal(frozen.schemaVersion, 'crwu.valuation.input.v3')
  assert.equal(frozen.assetType, 'real-estate', '资产类型是冻结输入的一部分')
  assert.equal(frozen.inputDigest, preview.inputDigest)
  assert.equal(frozen.baseDate, null, '未指定基准日是 null')
  assert.equal(frozen.purpose, null, '未指定评估目的是 null（不是空串）')
  assert.equal(frozen.valueType, null, '未指定价值类型是 null（不是空串）')
  assert.equal(frozen.supplementalPrompt, '请多考虑地铁因素')
  assert.equal(JSON.stringify(frozen).includes(dir), false, '绝对路径不进模型快照')

  // ③ 交接清单同样不含绝对路径。
  const manifest = JSON.parse(theCtx.files.get(join(casePath, '交接清单.json')))
  assert.equal(manifest.parentSessionId, started.parentSessionId)
  assert.equal(JSON.stringify(manifest).includes(workspace), false)
  // ④ 交接记录也落了盘（状态机的终态）。
  const record = JSON.parse(theCtx.files.get(join(casePath, '交接记录.json')))
  assert.equal(record.state, 'dispatched')
  assert.equal(record.requestId, 'req-1')

  // ⑤ scope：父会话按会话 id 逐字归属本轮案例目录。
  assert.equal(scopes.get(preview.projectId)?.casePath, casePath)
  assert.equal(scopes.parentOf(started.parentSessionId)?.projectId, preview.projectId)

  // ⑥ 固定指令发给父会话，带着案例目录与项目 id。
  assert.equal(theCtx.prompts.length, 1)
  const prompt = String(theCtx.prompts[0].message.content[0].text)
  assert.equal(prompt.includes(preview.projectId), true)
  assert.equal(prompt.includes('本次未指定评估基准日'), true)
  assert.equal(prompt.includes('本次未指定评估目的'), true)
  assert.equal(prompt.includes('本次未指定价值类型'), true)
  assert.equal(prompt.includes('估值底稿.xlsx'), true)
  assert.equal(prompt.includes(dir), false, '固定指令里不许出现员工本机的绝对路径')

  // ⑦ 轮次记录（v1 监控操作与工具回写都读它）。
  assert.equal(lifecycles.get(preview.projectId).sessionId, started.parentSessionId)
  assert.equal(lifecycles.get(preview.projectId).phase, 'running')
})

test('P16：评估目的与价值类型经 valuation-intake 进入冻结输入与固定指令', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir], {
    purpose: '司法拍卖处置参考', valueType: '市场价值',
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.purpose, '司法拍卖处置参考')
  assert.equal(preview.valueType, '市场价值')

  const started = await ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1',
  })
  assert.equal(started.ok, true, started.error)
  const frozen = JSON.parse(theCtx.files.get(join(workspace, preview.projectId, '估值输入.json')))
  assert.equal(frozen.purpose, '司法拍卖处置参考')
  assert.equal(frozen.valueType, '市场价值')
  const prompt = String(theCtx.prompts[0].message.content[0].text)
  assert.equal(prompt.includes('司法拍卖处置参考'), true)
  assert.equal(prompt.includes('市场价值'), true)
})

test('valuation-start：并发双击只建 1 个会话、只发 1 条指令；重放 reused:true', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir])
  const args = { previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1' }

  const [first, second] = await Promise.all([ops['valuation-start'](args), ops['valuation-start'](args)])
  assert.equal(first.ok, true, first.error)
  assert.equal(second.ok, true, second.error)
  assert.equal(theCtx.controllerRequests.length, 1)
  assert.equal(theCtx.prompts.length, 1)
  assert.equal(first.parentSessionId, second.parentSessionId)

  const replay = await ops['valuation-start'](args)
  assert.equal(replay.ok, true)
  assert.equal(replay.reused, true)
  assert.equal(theCtx.controllerRequests.length, 1)
})

test('valuation-start：本轮要用的工具不可见时**在创建会话之前**拒绝，并点名缺哪条', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const visible = new Set(['crwu_valuation_case_bootstrap', 'crwu_run_python_script'])
  ctx.get = ((original) => (name) => (name === 'tools'
    ? { get: (toolName) => (visible.has(toolName) ? { name: toolName } : undefined) }
    : original(name)))(ctx.get)
  const { ops, ctx: theCtx, lifecycles } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir])

  const result = await ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /工具在宿主里不可见/)
  assert.match(result.error, /crwu_valuation_file_extract/, '要点名缺的是哪一条')
  assert.equal(theCtx.controllerRequests.length, 0)
  assert.equal(lifecycles.size, 0)
})

test('valuation-start：工作区不成立时一个会话都不建（仍然如实回报）', async () => {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const { ops, ctx: theCtx, state } = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare({ ops, ctx: theCtx }, [dir])
  // 工作区丢了：交接必须 fail closed（连预览也要拿不到工作区）。
  state.workspaceMissing = true
  const result = await ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.equal(theCtx.controllerRequests.length, 0)
})

// ── v1 遗留的完成度操作（迁移期仍然如实回答） ──────────────────────────────

/** 交接一轮，返回可用的上下文。 */
async function handoffOnce() {
  const workspace = tempDir('crwu-ops-ws-')
  const ctx = makeCtx({ workspace })
  const deps = makeDeps({ ctx })
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await prepare(deps, [dir])
  assert.equal(preview.ok, true, preview.error)
  const started = await deps.ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1',
  })
  assert.equal(started.ok, true, started.error)
  return { ...deps, preview, started, casePath: join(workspace, preview.projectId), sourceDir: dir }
}

test('scope：project / parent / plan 归属逐字可查，没登记过的一律 false（fail closed）', () => {
  const scopes = new ValuationScopes()
  scopes.open({
    valuationId: '估值-1', projectId: '估值-1', parentSessionId: 'session-parent',
    previewId: '估值-1', planIds: [],
    casePath: '/ws/估值-1', sessionId: 'session-parent', workspaceId: 'w1', workspacePath: '/ws',
    snapshot: {
      valuationId: '估值-1', method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:x', files: [], frozenAt: '2026-10-14T00:00:00.000Z',
    },
    openedAt: 1,
  })
  assert.equal(scopes.parentOf('session-parent')?.projectId, '估值-1')
  assert.equal(scopes.parentOf('session-other'), undefined, '别的会话拿不到这一轮')
  assert.equal(scopes.planOf('session-parent', 'plan-1'), false, '没登记过的方案一律 false')
  assert.equal(scopes.addPlan('估值-1', 'plan-1'), true)
  assert.equal(scopes.planOf('session-parent', 'plan-1'), true)
  assert.equal(scopes.planOf('session-other', 'plan-1'), false, '方案归属只认绑定这条会话的那一轮')
  assert.equal(scopes.addPlan('估值-未知', 'plan-1'), false, '没有这一轮就不许登记方案')
  assert.equal(scopes.planOf('session-parent', ''), false)
})

// ── 协议 35：v1 面板完成度契约的**负向**断言 ─────────────────────────────
//
// 上面那一批用例（`valuation-status` / `valuation-result` / `valuation-open-artifact` /
// `valuation-cancel` 与"抽屉要素清单"）测的是**已被删除**的 v1 契约：页面不再轮询估值完成度，
// 完成判定改由显式的 finalize 校验（见 `host-valuation-finalize.test.mjs`），
// 确认抽屉也不再展示业务字段（见 `valuation-field-contract.test.mjs`）。
//
// 删掉那些用例**不能**连带删掉"这四条操作确实不在操作表里"这件事 ——
// 否则它们哪天被顺手加回来，没有任何地方会红。
test('协议 35：v1 的面板完成度四条操作不再注册；门禁三操作已注册', async () => {
  const h = await handoffOnce()
  for (const name of ['valuation-status', 'valuation-result', 'valuation-open-artifact', 'valuation-cancel']) {
    assert.equal(name in h.ops, false, `${name} 必须已随协议 35 删除（页面不追踪估值完成度）`)
  }
  for (const name of ['valuation-browser-preflight', 'valuation-browser-login', 'valuation-browser-login-cancel']) {
    assert.equal(typeof h.ops[name], 'function', `${name} 必须已注册（由浏览器 runtime 提供）`)
  }
})

/**
 * P18：**项目 scope 在注册表重建（进程重启 / 插件重载）后丢失** —— 复现 + resume/rebind。
 *
 * ## 这一层要钉死什么
 *
 * 估值的案例归属是**进程内**注册表（`ValuationScopes` / `ValuationLifecycles`），随插件实例活着。
 * 实例一重建，同一条父会话就再也拿不到自己那一份 `casePath`，案例内 Tool 立刻 fail closed。
 * 拒绝本身是对的（重建后的宿主记录不可信），但此前**没有任何恢复能力**：磁盘上明明有
 * `估值输入.json`、`材料-源/` 与交接记录，却没有任何受支持的入口把它们重新绑回同一条会话。
 *
 * 本文件按顺序验四件事：
 *   ① **复现**：重建后权威校验拒绝（不凭案例目录里的 JSON 授权）；
 *   ② **恢复**：`valuation-project-resume` 逐项核对（授权 / 工作区 / 协议代 / 冻结输入 /
 *      材料字节 / 会话归属）之后，把同一 projectId、同一会话、同一冻结输入绑回来；
 *   ③ **拒绝**：摘要不符、工作区不符、未经授权的 projectId、授权收据失效、协议代不兼容、
 *      会话已不存在 —— 一律 fail closed 并说明原因（会话不存在时给出"重新创建父会话"的动作）；
 *   ④ **不重复派发**：恢复不建第二条会话、不发第二条指令、不新建第二套目录。
 *
 * 全程真实临时目录（本机文件系统）+ 内存会话/工作区替身：不访问网络、不碰真实凭据与生产 profile。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

import { applyShellEffect, probeAnswer } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent, missingConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)
const { VALUATION_INPUT_SCHEMA_VERSION } = await import(new URL('src/shared/contracts/valuation-project.ts', ROOT).href)

const { createValuationOperations } = await import(new URL('src/host/operations/report-evaluation.ts', ROOT).href)
const { ValuationLifecycles } = await import(new URL('src/host/domains/report-evaluation/lifecycle/index.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)
const { requireCaseAccess } = await import(new URL('src/host/domains/report-audit/case-access.ts', ROOT).href)
const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationBootstrapTools } = await import(new URL('src/host/tools/report-evaluation/bootstrap.ts', ROOT).href)
const { VALUATION_TOOL_NAMES, VALUATION_CHILD_TOOLS } = await import(
  new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const {
  PROJECT_RECORD_FILE, PROJECT_RECORD_SCHEMA_VERSION, buildProjectRecord, projectRecordOf,
} = await import(new URL('src/host/domains/report-evaluation/lifecycle/project-record.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)

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
  const dir = tempDir('crwu-resume-src-')
  for (const [name, content] of spec) writeFileSync(join(dir, name), content)
  return dir
}

const realDir = (path) => existsSync(path) && statSync(path).isDirectory()
const realFile = (path) => existsSync(path) && statSync(path).isFile()

/**
 * **真实文件系统**的 `ctx.fs` 替身。
 *
 * 为什么不像其它夹具那样用内存 Map：恢复要核对的恰恰是"**磁盘上的字节**"（`材料-源/` 的
 * sha256 与 `估值输入.json` 的内容）。用内存映射去测"磁盘字节一致"等于把被测对象换掉 ——
 * 篡改归档副本这类断言必须作用在真实文件上。
 */
function nodeFsService() {
  return {
    async resolve(path) {
      const key = resolve(String(path))
      return { targetKey: key, displayPath: key }
    },
    async stat(target) {
      const key = String(target.targetKey)
      try {
        const info = statSync(key)
        return { type: info.isDirectory() ? 'directory' : 'file', size: String(info.size), version: 'v' }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      return readFileSync(String(target.targetKey), 'utf8')
    },
    async writeText(target, content) {
      const key = String(target.targetKey)
      mkdirSync(dirname(key), { recursive: true })
      writeFileSync(key, content)
      return { operation: 'create', version: 'v' }
    },
    contains(parent, child) {
      const p = resolve(String(parent.displayPath)).replace(/[\\/]+$/, '')
      const c = resolve(String(child.displayPath))
      return c === p || c.startsWith(`${p}${sep}`)
    },
  }
}

function exit(exitCode, text) {
  return {
    exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text, truncated: false }, stderr: { text: exitCode === 0 ? '' : text, truncated: false },
  }
}

/**
 * 会话 / 工作区替身 + **真实文件系统**的 shell 替身。
 *
 * `agents` / `sessions` / `workspaceRegistry` / `entity` 代表 **DSH 宿主**（跨插件实例存活）；
 * `ValuationScopes` / `ValuationLifecycles` 代表**插件实例**（重建即清空）—— 两者的区别
 * 正是 P18 的现场。
 */
function makeCtx({ workspace }) {
  const shellCalls = []
  const controllerRequests = []
  const sessionHeaders = new Map()
  const agents = new Map()
  const followups = []
  let minted = 0

  const entity = {
    id: 'w1', path: workspace, title: '工作区', sessionIds: [],
    async attachSession(sessionId) {
      const cwd = sessionHeaders.get(sessionId)?.cwd ?? ''
      if (cwd !== this.path) throw new Error(`cwd ${cwd} != ${this.path}`)
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
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
      // 真实副作用：`cp -f -- 源 目标` 真的复制（指纹要按磁盘字节算）。
      const copyMatch = /^cp -f -- (?:'([^']*)'|(\S+)) (?:'([^']*)'|(\S+))$/.exec(command.trim())
      const powershell = /^Copy-Item -LiteralPath '([^']*)' -Destination '([^']*)' -Force$/.exec(command.trim())
      const from = copyMatch === null ? undefined : (copyMatch[1] ?? copyMatch[2])
      const to = copyMatch === null
        ? (powershell === null ? undefined : powershell[1])
        : (copyMatch[3] ?? copyMatch[4])
      if (from !== undefined && to !== undefined) {
        try {
          mkdirSync(dirname(to), { recursive: true })
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
    shellCalls, controllerRequests, sessionHeaders, agents, followups, entity,
    get(name) {
      if (name === 'fs') return nodeFsService()
      if (name === 'shell') return shellService
      if (name === 'workspaceRegistry') {
        return {
          get: (id) => (id === 'w1' ? entity : undefined),
          list: () => [{ id: 'w1', path: entity.path, title: '工作区' }],
        }
      }
      if (name === 'sessions') return { get: (id) => (sessionHeaders.has(id) ? { header: sessionHeaders.get(id) } : undefined) }
      if (name === 'sessionController') {
        return {
          async create(request) {
            controllerRequests.push(request)
            const sessionId = request.sessionId ?? `session-val-${minted += 1}`
            sessionHeaders.set(sessionId, { cwd: entity.path })
            agents.set(sessionId, { id: sessionId, followup(message) { followups.push({ sessionId, message }) } })
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

/**
 * 一次装配：**插件实例**（注册表 + 操作表）与它依赖的宿主事实。
 *
 * `consent: 'missing'` 用来验"授权收据失效必须拒绝"；真实重启时它是从工作台状态文件重新读出来的。
 */
function makeInstance({ ctx, consent } = {}) {
  const workspace = ctx.entity.path
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: consent === 'missing' ? missingConsent('测试：未授权') : grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: workspace, workspaceTitle: '工作区',
    caseRoot: workspace,
  }
  const { access } = makeTestAccess(ctx, { state })
  const lifecycles = new ValuationLifecycles()
  const scopes = new ValuationScopes()
  const world = {
    platform: async () => 'darwin-arm64',
    home: async () => '/Users/x',
    workdir: async () => workspace,
    cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
  }
  const discussionScopes = createDiscussionScopeRegistry()
  const toolDeps = {
    ctx, config: { ...CONFIG }, state, access, discussionScopes, valuationScopes: scopes, world,
  }
  return {
    ctx, state, access, world, workspace, lifecycles, scopes, discussionScopes, toolDeps,
    ops: createValuationOperations({ ctx, state, access, world, lifecycles, scopes }),
  }
}

/** 一条会话的最小执行上下文（案例门禁只认 `exec.agent.id`）。 */
function execOf(sessionId) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.caseBootstrap,
    arguments: {}, signal: new AbortController().signal,
    agent: { id: sessionId }, deferContext() {}, concludeTurn() {},
  }
}

/** 这条会话现在被案例门禁认成哪一类。 */
function accessKind(instance, sessionId, caseDir) {
  return requireCaseAccess(
    instance.ctx, instance.state, instance.discussionScopes, execOf(sessionId),
    { caseDir }, { valuation: instance.scopes },
  )
}

async function bootstrapOnce(instance, projectId, casePath, sessionId) {
  return await valuationBootstrapTools(instance.toolDeps)[0]
    .execute({ valuationId: projectId, caseDir: casePath }, execOf(sessionId))
}

/** 走一遍真实启动链路：归档预览 → 交接父会话（落盘冻结输入、清单、交接记录、项目记录）。 */
async function startProject(instance, patch = {}) {
  const dir = sourceDir([['报告.pdf', patch.content ?? 'pdf-bytes']])
  const preview = await instance.ops['valuation-intake']({
    requestId: 'req-1', paths: [dir], assetType: 'real-estate', method: 'market', baseDate: '',
    purpose: patch.purpose ?? '转让', valueType: patch.valueType ?? '市场价值',
    supplementalPrompt: '请多考虑地铁因素',
  })
  assert.equal(preview.ok, true, preview.error)
  const started = await instance.ops['valuation-start']({
    previewId: preview.previewId, confirmedInputDigest: preview.inputDigest, requestId: 'req-1',
  })
  assert.equal(started.ok, true, started.error)
  return { dir, preview, started, casePath: join(instance.workspace, preview.projectId) }
}

/** 项目目录里的持久化文件（Host 派生路径，模型提交不了）。 */
function projectFilesOf(casePath) {
  return {
    input: join(casePath, '估值输入.json'),
    handoff: join(casePath, '交接记录.json'),
    record: join(casePath, PROJECT_RECORD_FILE),
  }
}

/** 读项目记录（正文 + 自身指纹）。 */
function readRecord(casePath) {
  return JSON.parse(readFileSync(join(casePath, PROJECT_RECORD_FILE), 'utf8'))
}

/** 用一份**指纹自洽**的记录覆盖磁盘上的那一份（模拟"记录被合法地换了一版"）。 */
function rewriteRecord(casePath, patch) {
  const current = readRecord(casePath)
  const body = { ...current }
  delete body.recordDigest
  const next = buildProjectRecord({ ...body, ...patch })
  writeFileSync(join(casePath, PROJECT_RECORD_FILE), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** 项目目录下的**一级子目录**（用来证"没有新建第二套目录"）。 */
function subdirsOf(path) {
  return readdirSync(path, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort()
}

/** 起一轮真实的项目（启动链路走完），返回宿主与第一个实例。 */
async function firstProject() {
  const ctx = makeCtx({ workspace: tempDir('crwu-resume-ws-') })
  const first = makeInstance({ ctx })
  const project = await startProject(first)
  return { ctx, first, ...project }
}

// ── ① 复现：注册表重建即丢失归属（恢复之前） ────────────────────────────────

test('P18 复现：插件实例重建后项目 scope 丢失 —— 权威校验拒绝（不凭案例目录里的 JSON 授权）', async () => {
  const { ctx, first, preview, started, casePath } = await firstProject()

  // 重建之前：这是本轮估值会话，案例内 Tool 认得它。
  const before = await accessKind(first, started.parentSessionId, casePath)
  assert.equal(before.ok, true, before.error)
  assert.equal(before.kind, 'valuation')
  assert.equal((await bootstrapOnce(first, preview.projectId, casePath, started.parentSessionId)).ok, true)

  // 插件实例重建（注册表随实例清空；DSH 宿主与父会话仍然活着）。
  const second = makeInstance({ ctx })

  const after = await accessKind(second, started.parentSessionId, casePath)
  assert.notEqual(after.kind, 'valuation', '重建后这条会话不再是本轮估值会话')

  const refused = await bootstrapOnce(second, preview.projectId, casePath, started.parentSessionId)
  assert.equal(refused.ok, false)
  assert.equal(refused.errorKind, 'policy')
  assert.match(refused.error, /不是本轮估值会话/)

  assert.equal(second.scopes.parentOf(started.parentSessionId), undefined)
  assert.equal(second.lifecycles.get(preview.projectId), undefined)

  // 磁盘上的事实都在（所以"案例目录里有 JSON"绝不是授权依据）。
  const files = projectFilesOf(casePath)
  assert.equal(realFile(files.input), true)
  assert.equal(realFile(files.handoff), true)
  assert.equal(realFile(files.record), true, '启动时必须留下受保护的项目记录')
  assert.equal(first.scopes.get(preview.projectId)?.casePath, casePath)

  const record = readRecord(casePath)
  assert.equal(record.schemaVersion, PROJECT_RECORD_SCHEMA_VERSION)
  assert.equal(record.protocolVersion, WORKBENCH_PROTOCOL)
  assert.equal(record.sessionId, started.parentSessionId)
  assert.equal(record.inputDigest, preview.inputDigest)
  assert.equal(record.purpose, '转让')
  assert.equal(record.files[0].sha256, preview.files[0].sha256)

  // 受支持的恢复入口存在（P18 的修复点）。
  assert.equal(typeof second.ops['valuation-project-resume'], 'function')
})

// ── ② 恢复：同一项目 / 同一会话 / 同一冻结输入，且不重复派发 ────────────────

test('resume：重启后恢复同一项目、复用同一会话与冻结输入，不新建目录、不重复派发', async () => {
  const { ctx, preview, started, casePath } = await firstProject()
  const dirsBefore = subdirsOf(casePath)
  const sessionsBefore = ctx.controllerRequests.length
  const followupsBefore = ctx.followups.length

  const second = makeInstance({ ctx })
  const resumed = await second.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal(resumed.reused, true)
  assert.equal(resumed.projectId, preview.projectId)
  assert.equal(resumed.casePath, casePath)
  assert.equal(resumed.parentSessionId, started.parentSessionId, '必须复用同一条父会话')
  assert.equal(resumed.inputDigest, preview.inputDigest)
  assert.equal(resumed.method, 'market')
  assert.equal(resumed.purpose, '转让')
  assert.equal(resumed.valueType, '市场价值')
  assert.equal(resumed.fileCount, preview.files.length)
  assert.equal(resumed.phase, 'running')
  assert.equal(resumed.action, '')

  // 案例门禁重新认这条会话（归属按会话 id 逐字绑回），冻结输入也回到进程内注册表。
  const access = await accessKind(second, started.parentSessionId, casePath)
  assert.equal(access.ok, true, access.error)
  assert.equal(access.kind, 'valuation')
  const scope = second.scopes.get(preview.projectId)
  assert.equal(scope?.casePath, casePath)
  assert.equal(scope?.sessionId, started.parentSessionId)
  assert.equal(scope?.snapshot.digest, preview.inputDigest)
  assert.equal(scope?.snapshot.method, 'market')
  assert.equal(scope?.snapshot.baseDate, '')
  assert.equal(scope?.snapshot.purpose, '转让')
  assert.equal(scope?.snapshot.valueType, '市场价值')
  assert.deepEqual(scope?.planIds, [])
  assert.equal(second.scopes.planOf(started.parentSessionId, 'plan-1'), false, '恢复不许凭空登记方案')
  assert.equal(second.lifecycles.get(preview.projectId)?.sessionId, started.parentSessionId)
  assert.equal(second.lifecycles.get(preview.projectId)?.phase, 'running')
  assert.equal(second.lifecycles.get(preview.projectId)?.casePath, casePath)

  // 不重复派发：没有新会话、没有新指令、没有新目录。
  assert.equal(ctx.controllerRequests.length, sessionsBefore, '恢复不许建会话')
  assert.equal(ctx.followups.length, followupsBefore, '恢复不许发任何指令')
  assert.deepEqual(subdirsOf(casePath), dirsBefore, '恢复不许新建第二套目录')
  assert.equal(second.scopes.size, 1)
})

test('resume：同一项目恢复两次是幂等的（复用同一轮、同一会话，不叠第二份登记）', async () => {
  const { ctx, preview, started, casePath } = await firstProject()
  const second = makeInstance({ ctx })
  const once = await second.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(once.ok, true, once.error)
  const twice = await second.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(twice.ok, true, twice.error)
  assert.equal(twice.parentSessionId, started.parentSessionId)
  assert.equal(second.scopes.size, 1)
  assert.equal(second.lifecycles.size, 1)
  assert.equal(second.lifecycles.get(preview.projectId).casePath, casePath)
  assert.equal(ctx.controllerRequests.length, 1, '两轮恢复也只有一个会话（交接时那一条）')
})

// ── ③ 拒绝：任何一项不符都不恢复 ────────────────────────────────────────────

test('resume：归档副本被改过（字节不符）必须拒绝', async () => {
  const { ctx, preview, casePath } = await firstProject()
  const material = join(casePath, preview.files[0].archiveRelativePath)
  writeFileSync(material, 'tampered-bytes-with-different-length')

  const resumed = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'conflict')
  assert.match(resumed.error, /字节与项目记录不一致/)
  assert.equal(resumed.reused, false)
})

test('resume：估值输入.json 的摘要 / 方法 / 评估目的被改过必须拒绝', async () => {
  const { ctx, preview, casePath } = await firstProject()
  const files = projectFilesOf(casePath)
  const original = JSON.parse(readFileSync(files.input, 'utf8'))

  // ① 摘要被改。
  writeFileSync(files.input, `${JSON.stringify({ ...original, inputDigest: 'sha256:别的' }, null, 2)}\n`)
  const digestConflict = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(digestConflict.ok, false)
  assert.equal(digestConflict.errorKind, 'conflict')
  assert.match(digestConflict.error, /输入摘要/)

  // ② 方法被改（摘要没动也一样拒绝：逐字段比对）。
  writeFileSync(files.input, `${JSON.stringify({ ...original, methodRequest: 'income' }, null, 2)}\n`)
  const methodConflict = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(methodConflict.ok, false)
  assert.equal(methodConflict.errorKind, 'conflict')
  assert.match(methodConflict.error, /方法/)

  // ③ 评估目的被改（P16 的结论前提也是判据）。
  writeFileSync(files.input, `${JSON.stringify({ ...original, purpose: '抵押' }, null, 2)}\n`)
  const purposeConflict = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(purposeConflict.ok, false)
  assert.equal(purposeConflict.errorKind, 'conflict')
  assert.match(purposeConflict.error, /评估目的/)
})

test('resume：项目记录本身被改过（自身指纹不符）必须拒绝', async () => {
  const { ctx, preview, casePath } = await firstProject()
  const record = readRecord(casePath)
  writeFileSync(
    join(casePath, PROJECT_RECORD_FILE),
    `${JSON.stringify({ ...record, sessionId: 'session-别人的' }, null, 2)}\n`,
  )
  const resumed = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'conflict')
  assert.match(resumed.error, /指纹不一致/)
})

test('resume：工作区与记录不一致必须拒绝（换过工作区就不许恢复）', async () => {
  const { ctx, preview, casePath } = await firstProject()

  // 记录本身指纹自洽，但选中的工作区换了：Host 从**当前**工作空间派生的目录与记录不符。
  const other = tempDir('crwu-resume-other-')
  cpSync(casePath, join(other, preview.projectId), { recursive: true })
  ctx.entity.path = other
  const instance = makeInstance({ ctx })
  const resumed = await instance.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'policy')
  assert.match(resumed.error, /工作区路径/)
  assert.equal(instance.scopes.size, 0)
})

test('resume：记录属于另一个 workspaceId 时拒绝', async () => {
  const { ctx, preview, casePath } = await firstProject()
  rewriteRecord(casePath, { workspaceId: 'w2' })
  const instance = makeInstance({ ctx })
  const resumed = await instance.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'policy')
  assert.match(resumed.error, /另一个工作区/)
  assert.equal(instance.scopes.size, 0)
})

test('resume：未经授权的 projectId 与不合法 id 一律拒绝', async () => {
  const { ctx, preview, casePath } = await firstProject()
  const instance = makeInstance({ ctx })

  // ① 目录里没有项目记录（另一个项目的 id）→ not-found；绝不因为"工作区下有目录"就恢复。
  const ghost = await instance.ops['valuation-project-resume']({ projectId: '估值-20261015-000000-9999' })
  assert.equal(ghost.ok, false)
  assert.equal(ghost.errorKind, 'not-found')
  assert.equal(instance.scopes.size, 0)

  // ② id 不合法（路径穿越 / 分隔符 / 空）→ input-invalid。
  for (const bad of ['', '..', '../别的', 'a/b', 'a\\b']) {
    const outcome = await instance.ops['valuation-project-resume']({ projectId: bad })
    assert.equal(outcome.ok, false, bad)
    assert.equal(outcome.errorKind, 'input-invalid', bad)
  }

  // ③ 记录在、但交接记录不见了 → not-found（不恢复一条"不知道父会话是谁"的轮次）。
  rmSync(join(casePath, '交接记录.json'), { force: true })
  const noHandoff = await instance.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(noHandoff.ok, false)
  assert.equal(noHandoff.errorKind, 'not-found')
  assert.match(noHandoff.error, /交接记录/)
  assert.equal(instance.scopes.size, 0)
})

test('resume：授权收据失效时拒绝，且连项目目录都不读', async () => {
  const { ctx, preview } = await firstProject()
  const unauthorized = makeInstance({ ctx, consent: 'missing' })
  const resumed = await unauthorized.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'policy')
  assert.match(resumed.error, /授权收据/)
  assert.equal(resumed.casePath, '', '未授权时不派生目录、不读盘')
  assert.equal(unauthorized.scopes.size, 0)
})

test('resume：协议代与冻结输入 Schema 不兼容必须拒绝', async () => {
  const { ctx, preview, casePath } = await firstProject()

  // ① 协议代不同（记录指纹自洽，所以拦它的是兼容性判据，而不是"文件被改过"）。
  rewriteRecord(casePath, { protocolVersion: 999 })
  const staleProtocol = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(staleProtocol.ok, false)
  assert.equal(staleProtocol.errorKind, 'capability-gap')
  assert.match(staleProtocol.error, /协议代/)

  // ② 冻结输入 Schema 不同（把协议代改回来，单独验 Schema 判据）。
  rewriteRecord(casePath, { protocolVersion: WORKBENCH_PROTOCOL, inputSchemaVersion: 'crwu.valuation.input.v99' })
  const staleSchema = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(staleSchema.ok, false)
  assert.equal(staleSchema.errorKind, 'capability-gap')
  assert.match(staleSchema.error, /Schema/)
})

test('resume：父会话已不存在 → 明确动作 recreate-parent-session，且不静默新建', async () => {
  const { ctx, preview, started } = await firstProject()
  // 宿主整个重启之后父会话没了（这是进程重启的真实后果）。
  ctx.agents.delete(started.parentSessionId)
  ctx.sessionHeaders.delete(started.parentSessionId)
  const index = ctx.entity.sessionIds.indexOf(started.parentSessionId)
  if (index >= 0) ctx.entity.sessionIds.splice(index, 1)

  const instance = makeInstance({ ctx })
  const sessionsBefore = ctx.controllerRequests.length
  const resumed = await instance.ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'policy')
  assert.equal(resumed.action, 'recreate-parent-session')
  assert.match(resumed.error, /重新创建父会话/)
  assert.equal(ctx.controllerRequests.length, sessionsBefore, '不许静默新建父会话')
  assert.equal(instance.scopes.size, 0, '会话不在就不授予案例访问权')
})

test('resume：交接没有完成（未派发）的轮次不恢复', async () => {
  const { ctx, preview, casePath } = await firstProject()
  const handoffPath = join(casePath, '交接记录.json')
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'))
  writeFileSync(handoffPath, `${JSON.stringify({ ...handoff, state: 'created' }, null, 2)}\n`)
  const resumed = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'conflict')
  assert.match(resumed.error, /交接没有完成/)
})

test('resume：已结束的轮次不恢复', async () => {
  const { ctx, preview, casePath } = await firstProject()
  rewriteRecord(casePath, { phase: 'completed' })
  const resumed = await makeInstance({ ctx }).ops['valuation-project-resume']({ projectId: preview.projectId })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.errorKind, 'policy')
  assert.match(resumed.error, /已经结束/)
})

// ── 项目记录本身：收窄、指纹与兼容性 ────────────────────────────────────────

test('项目记录：指纹口径稳定，被改一个字段就核不过', () => {
  const payload = {
    schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
    protocolVersion: WORKBENCH_PROTOCOL,
    inputSchemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
    valuationId: '估值-1', projectId: '估值-1', previewId: '估值-1',
    casePath: '/ws/估值-1', workspaceId: 'w1', workspacePath: '/ws',
    sessionId: 'session-1', planIds: ['plan-1'], phase: 'running',
    assetType: 'real-estate',
    methodRequest: 'market', baseDate: null, purpose: null, valueType: null, templateFileId: null,
    supplementalPrompt: '',
    inputDigest: 'sha256:x',
    files: [{
      fileId: 'material-001', fileName: 'a.pdf', archiveRelativePath: '材料-源/a.pdf',
      kind: 'pdf', sizeBytes: 1, sha256: 'sha256:y', duplicateOf: null,
    }],
    createdAt: '2026-10-15T00:00:00.000Z',
  }
  const record = buildProjectRecord(payload)
  assert.match(record.recordDigest, /^sha256:[0-9a-f]{64}$/)

  const round = projectRecordOf(JSON.parse(JSON.stringify(record)))
  assert.equal(round.ok, true, round.error)
  assert.equal(round.record.projectId, '估值-1')
  assert.deepEqual(round.record.planIds, ['plan-1'])

  // 改一个字段（哪怕只是一个字符）就核不过。
  const tampered = projectRecordOf({ ...record, supplementalPrompt: 'x' })
  assert.equal(tampered.ok, false)
  assert.match(tampered.error, /指纹不一致/)

  // 缺字段 / 坏形状一律拒绝，而不是补默认值。
  assert.equal(projectRecordOf({ ...record, files: [] }).ok, false)
  assert.equal(projectRecordOf({ ...record, phase: '瞎写的' }).ok, false)
  assert.equal(projectRecordOf({ ...record, schemaVersion: '别的' }).ok, false)
  assert.equal(projectRecordOf(null).ok, false)
})

// ── ④ 结构边界：恢复不是第二条派发通道 ─────────────────────────────────────

test('恢复层不做任何派发（结构边界：不建会话、不发指令、不建目录、不写盘）', async () => {
  const { readFile } = await import('node:fs/promises')
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const path of [
    'src/host/domains/report-evaluation/lifecycle/resume.ts',
    'src/host/domains/report-evaluation/lifecycle/project-record.ts',
  ]) {
    const code = stripComments(await readFile(new URL(path, ROOT), 'utf8'))
    for (const needle of [
      'createSession', 'followup', 'ensureDirectory', 'ensureCaseDirectory',
      'writePanelCaseFile', 'writeCaseText', 'node:child_process', 'fetch(',
    ]) {
      assert.equal(code.includes(needle), false, `${path} 不许出现「${needle}」`)
    }
  }
})

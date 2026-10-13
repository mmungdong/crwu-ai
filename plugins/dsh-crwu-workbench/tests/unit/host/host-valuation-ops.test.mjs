/**
 * 估值 Host 操作（协议 32）的接线测试。
 *
 * 挑的是**错了会静默放行**的几条：
 *
 * 1. `valuation-start` 必须核对**确认指纹**：用户确认之后资料被改过（或被换了一批）时，
 *    绝不能按旧确认启动一轮估值 —— 结果是"确认的是 A、算的是 B"，而两边都看不出来；
 * 2. 基准日**空就是空**：Host 不许从资料里识别到的日期补一个（那会让"未指定基准日"这件事
 *    在结果里消失，而所有依赖基准日的口径都跟着漂）；
 * 3. 会话落点只走统一服务（`workspaceId`）：没有 `cwd` 兜底，工作区不成立就不建会话；
 * 4. 未知轮次的 `status` / `cancel` / `open-artifact` 都要如实回答，而不是假装成功。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent, missingConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createValuationOperations } = await import(new URL('src/host/operations/report-evaluation.ts', ROOT).href)
const { ValuationLifecycles } = await import(new URL('src/host/domains/report-evaluation/lifecycle/index.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)
const { VALUATION_CHILD_TOOLS } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { VALUATION_FIELD_KEYS } = await import(new URL('src/host/operations/report-evaluation.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-200000-dd44'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

/** 内存 fs + 记录命令的 shell + 会话控制器 + Agent（followup 记录指令）。 */
function makeCtx({ manifest = null, extractPayload = undefined } = {}) {
  const files = new Map()
  const directories = new Set([WORKSPACE, CASE_DIR])
  const commands = []
  const shellCalls = []
  const prompts = []
  const controllerRequests = []
  const sessionHeaders = new Map()
  const agents = new Map()
  let minted = 0
  if (manifest !== null) files.set(`${CASE_DIR}/资料清单.json`, JSON.stringify(manifest))

  const entity = {
    id: 'w1', path: WORKSPACE, title: '工作区', sessionIds: [],
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
      // **面板没有会话**：非特权命令拿不到沙箱策略 → 落回部署默认 → 案例目录里的写会被系统拦下。
      // 所以"这条命令有没有提权"必须可观察（2026-10-13 真实缺陷：材料-源 mkdir 被拒）。
      // 提权的形态是 `danger-full-access`（由操作表的 `privileged: true` 决定，**不依赖会话**）；
      // 非特权命令带的是会话算出来的 `workspace-write`，没有会话时**一条策略都没有** → 沙箱拒绝。
      shellCalls.push({
        command,
        mode: String(request?.sandboxPolicy?.mode ?? ''),
        hasPolicy: request?.sandboxPolicy !== undefined,
      })
      // 估值 intake 的复制走的是操作系统复制命令（`cp -f <源> <目标>` / `Copy-Item`）。
      // 夹具必须**真的把字节搬进内存 fs**：实现会在命令之后回读目标文件，
      // 不搬的话每一步都会停在"复制命令成功了，但案例目录里没有这份资料"。
      // 真实命令形态：`cp -f -- '<源>' '<目标>'`（POSIX）/ `Copy-Item -LiteralPath '<源>' -Destination '<目标>' -Force`。
      const copyMatch = /^cp -f -- '([^']+)' '([^']+)'$/.exec(command.trim())
        ?? /^Copy-Item -LiteralPath '([^']+)' -Destination '([^']+)' -Force$/.exec(command.trim())
      if (copyMatch !== null) {
        const [, from, to] = copyMatch
        try {
          files.set(to, readFileSync(from).toString('latin1'))
        } catch (error) {
          return {
            result: async () => ({
              exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: '', truncated: false },
              stderr: { text: `cp: ${error instanceof Error ? error.message : String(error)}`, truncated: false },
            }),
          }
        }
      }
      // 估值 intake 会真的跑一次提取脚本（`extract_files.py <源文件> <输出文件>`）。
      // 脚本的输出**不读 stdout**（表格可能被截断），而是写到案例目录里的一个 JSON —— 所以这里
      // 按同一个契约把结果写进内存 fs：这就是"提取成功"在单测里的最小再现。
      const extractMatch = /extract_files\.py['"]?\s+(\S+)\s+(\S+)/.exec(command)
      if (extractMatch !== null && extractPayload !== undefined) {
        const outPath = extractMatch[2].replace(/^["']|["']$/g, '')
        files.set(outPath, JSON.stringify(extractPayload(String(extractMatch[1]).replace(/^["']|["']$/g, ''))))
        return {
          result: async () => ({
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
          }),
        }
      }
      // `mkdir` 必须真的作用到内存 fs 上（实现的回读后置条件会检查它是否真的存在）；
      // 只读探测用共享的 `probeAnswer`（实现按 stdout 上的一个词判结论，而不是退出码）。
      const probe = probeAnswer(command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(path),
      })
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
    },
  }

  const ctx = {
    files, directories, commands, shellCalls, prompts, controllerRequests, entity,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') return shellService
      if (name === 'workspaceRegistry') {
        return { get: (id) => (id === 'w1' ? entity : undefined), list: () => [{ id: 'w1', path: WORKSPACE, title: '工作区' }] }
      }
      if (name === 'sessions') return { get: (id) => (sessionHeaders.has(id) ? { header: sessionHeaders.get(id) } : undefined) }
      if (name === 'sessionController') {
        return {
          async create(request) {
            controllerRequests.push(request)
            const sessionId = request.sessionId ?? `session-val-${minted += 1}`
            sessionHeaders.set(sessionId, { cwd: WORKSPACE })
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
      // 工具注册表：`valuation-start` 会拿 `VALUATION_CHILD_TOOLS` 去问"宿主真的注册了吗"，
      // 缺任何一条就拒绝启动。这里按真实部署给一份**只认那 8 个名字**的替身。
      if (name === 'tools') {
        return {
          get: (toolName) => (VALUATION_CHILD_TOOLS.includes(toolName) ? { name: toolName } : undefined),
        }
      }
      return undefined
    },
  }
  return ctx
}

function makeDeps({ ctx = makeCtx(), python = undefined, transport = nullTransport, consent = undefined } = {}) {
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
  // `consent: 'missing'` → 未授权的 Broker（用来跑"没授权时不许打开浏览器"）。
  // ⚠️ 必须**换掉 state 里的收据**：直接把 `state` 递进去的话，里面那份 `grantedConsent()`
  // 会覆盖掉夹具的未授权默认值，于是"未授权"用例实际上跑在已授权状态下（第一次就是这么写错的）。
  const { access } = consent === 'missing'
    ? makeTestAccess(ctx, { state: { ...state, localAccess: missingConsent('测试：未授权') } })
    : makeTestAccess(ctx, { state })
  const lifecycles = new ValuationLifecycles()
  const scopes = new ValuationScopes()
  const world = {
    platform: async () => 'darwin-arm64',
    home: async () => '/Users/x',
    workdir: async () => WORKSPACE,
    cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
  }
  return {
    ctx, state, lifecycles, scopes,
    // `python` 缺省不给：于是"本机没有可用的 Python 提取能力"是一条**真实存在**的路径，
    // 值得单独测（文件照样归档，但状态不许写成 parsed）。
    // 抓取通道注入内存替身：否则每次 intake 都要等三家站点的真实网络超时
    //（那既慢又不确定，而且"没人跑过的操作"正是这样被漏掉的）。
    ops: createValuationOperations({
      ctx, state, access, world, lifecycles, scopes, transport,
      ...(python === undefined ? {} : { python }),
    }),
  }
}

/**
 * 内存抓取通道：默认一律失败。
 *
 * 与"本机离线"一致：三家站点的登录状态都会落成 `unknown`（不假设已登录、也不假设未登录），
 * 这正是要在断言里区分开的三种状态之一。
 */
async function nullTransport(url) {
  return { ok: false, error: `测试替身不联网：${url}`, status: 0, body: '', contentType: '', url, loginRequired: false, captcha: false }
}

/** 一份与 `DIGEST` 一致的输入清单。 */
function manifestOf(digest = DIGEST, files = [{ fileName: '估值报告.pdf', relativePath: '材料-源/估值报告.pdf', kind: 'pdf', sizeBytes: 10, sha256: 'sha256:a' }]) {
  return { generatedAt: '2026-10-12T00:00:00.000Z', digest, files }
}

const START_ARGS = {
  valuationId: VALUATION_ID,
  method: 'market',
  baseDate: '',
  supplementalPrompt: '请多考虑地铁因素',
  confirmedSnapshotDigest: DIGEST,
}

test('valuation-start：指纹对不上就拒绝启动（不许"确认的是 A、算的是 B"）', async () => {
  const ctx = makeCtx({ manifest: manifestOf('sha256:别的指纹') })
  const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })
  const result = await ops['valuation-start'](START_ARGS)

  assert.equal(result.ok, false)
  assert.match(result.error, /输入快照已经变了/)
  assert.equal(lifecycles.size, 0, '不许开出一轮估值')
  assert.equal(theCtx.controllerRequests.length, 0, '也不许建会话')
})

test('valuation-start：基准日为空就写空串（绝不从资料里补一个日期）', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const result = await ops['valuation-start']({ ...START_ARGS, supplementalPrompt: '' })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.digest, DIGEST)
  const frozen = JSON.parse(theCtx.files.get(`${CASE_DIR}/估值输入.json`))
  assert.equal(frozen.baseDate, '', '基准日没选就是空串')
  assert.equal(frozen.method, 'market')
  assert.equal(frozen.digest, DIGEST)
  assert.equal(frozen.files.length, 1)
})

test('valuation-start：会话只发 workspaceId（没有 cwd 兜底），并回读到成员关系', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, ctx: theCtx, scopes } = makeDeps({ ctx })
  const result = await ops['valuation-start'](START_ARGS)

  assert.equal(result.ok, true, result.error)
  assert.equal(theCtx.controllerRequests.length, 1)
  const request = theCtx.controllerRequests[0]
  assert.equal(request.workspaceId, 'w1')
  assert.equal('cwd' in request, false)
  assert.equal(theCtx.entity.sessionIds.includes(result.sessionId), true, '会话必须出现在工作区成员清单里')
  // 案例 scope 也要开出来（子会话据此拿到自己的案例目录）。
  assert.equal(scopes.get(VALUATION_ID)?.casePath, CASE_DIR)

  // 固定指令发给估值会话。
  assert.equal(theCtx.prompts.length, 1)
  const prompt = String(theCtx.prompts[0].message.content[0].text)
  assert.equal(prompt.includes(VALUATION_ID), true)
  assert.equal(prompt.includes('本次未指定评估基准日'), true)
  assert.equal(prompt.includes('估值底稿.xlsx'), true)
})

test('valuation-start：同一 ID 重复启动是幂等的（不建第二条会话）', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const first = await ops['valuation-start'](START_ARGS)
  const second = await ops['valuation-start'](START_ARGS)
  assert.equal(first.ok, true, first.error)
  assert.equal(second.ok, true, second.error)
  assert.equal(second.reused, true)
  assert.equal(theCtx.controllerRequests.length, 1, '重复点确认不该起两条会话')
})

test('valuation-start：方法非法 / 基准日形状不对都在建任何东西之前拒绝', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, lifecycles } = makeDeps({ ctx })
  const badMethod = await ops['valuation-start']({ ...START_ARGS, method: '瞎猜' })
  assert.equal(badMethod.ok, false)
  assert.match(badMethod.error, /评估方法不合法/)
  const badDate = await ops['valuation-start']({ ...START_ARGS, baseDate: '2026/06/30' })
  assert.equal(badDate.ok, false)
  assert.match(badDate.error, /YYYY-MM-DD/)
  assert.equal(lifecycles.size, 0)
})

test('valuation-start：估值 ID 不合法（带分隔符 / ..）时拒绝', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops } = makeDeps({ ctx })
  for (const bad of ['../逃出去', 'a/b', '..']) {
    const result = await ops['valuation-start']({ ...START_ARGS, valuationId: bad })
    assert.equal(result.ok, false, bad)
    assert.match(result.error, /估值 ID 不合法/)
  }
})

test('valuation-status：宿主没有这一轮时如实回 known:false（不假装在跑）', async () => {
  const { ops } = makeDeps()
  const result = await ops['valuation-status']({ valuationId: '估值-不存在的' })
  assert.equal(result.ok, true)
  assert.equal(result.known, false)
  assert.equal(result.phase, 'draft')
  assert.equal(result.sessionId, '')
})

test('valuation-status：启动后能读到阶段 / 方法 / 基准日 / 交付件存在性', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  const status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.known, true)
  assert.equal(status.phase, 'running')
  assert.equal(status.method, 'market')
  assert.equal(status.baseDate, '')
  assert.equal(status.casePath, CASE_DIR)
  assert.deepEqual(status.artifacts, { html: false, xlsx: false, json: false })
})

test('valuation-cancel：取消后是终态，重复取消如实报错；未知轮次也报错', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  const first = await ops['valuation-cancel']({ valuationId: VALUATION_ID })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.phase, 'cancelled')
  const again = await ops['valuation-cancel']({ valuationId: VALUATION_ID })
  assert.equal(again.ok, false)
  const unknown = await ops['valuation-cancel']({ valuationId: '估值-不存在的' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /没有这一轮估值/)
})

test('valuation-open-artifact：只允许打开本轮的交付件', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  const foreign = await ops['valuation-open-artifact']({ valuationId: VALUATION_ID, name: '../../秘密.txt' })
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /只允许打开本轮的交付件/)
  const missing = await ops['valuation-open-artifact']({ valuationId: VALUATION_ID, name: '估值报告.html' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /还不存在/)
})

test('valuation-result：交付件不在时如实回三件套都为 false，结果为空', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  const result = await ops['valuation-result']({ valuationId: VALUATION_ID })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.artifacts, { html: false, xlsx: false, json: false })
  assert.equal(result.result, null)
})

test('valuation-files-scan：没有选择时回空清单，不起任何命令', async () => {
  const ctx = makeCtx()
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const result = await ops['valuation-files-scan']({ paths: [] })
  assert.equal(result.ok, true)
  assert.equal(result.fileCount, 0)
  assert.equal(theCtx.commands.length, 0)
})

test('valuation-start：本轮要用的工具不可见时**在创建会话之前**拒绝，并点名缺哪条', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  // 只有一半工具可见：注册表收窄 / 打包漏文件都会长这样。
  const visible = new Set(['crwu_valuation_case_bootstrap', 'crwu_run_python_script'])
  ctx.get = ((original) => (name) => (name === 'tools'
    ? { get: (toolName) => (visible.has(toolName) ? { name: toolName } : undefined) }
    : original(name)))(ctx.get)
  const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })

  const result = await ops['valuation-start'](START_ARGS)
  assert.equal(result.ok, false)
  assert.match(result.error, /工具在宿主里不可见/)
  assert.match(result.error, /crwu_valuation_file_extract/, '要点名缺的是哪一条')
  assert.equal(theCtx.controllerRequests.length, 0, '不许建会话')
  assert.equal(lifecycles.size, 0, '也不许开出一轮估值')
})

test('输入快照被改过时可见：valuation-result 报出来，并说明以宿主记录为准', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })
  const started = await ops['valuation-start']({ ...START_ARGS, supplementalPrompt: '请多考虑地铁因素' })
  assert.equal(started.ok, true, started.error)
  assert.equal(lifecycles.get(VALUATION_ID).supplementalPrompt, '请多考虑地铁因素', '当时那一份要留在宿主内存里')

  // 干净时：不报，也不多记缺口。
  const clean = await ops['valuation-result']({ valuationId: VALUATION_ID })
  assert.equal(clean.snapshotTampered, false)
  assert.equal(lifecycles.get(VALUATION_ID).capabilityGaps.length, 0)

  // 把基准日与补充要求都改掉（估值会话对案例目录有写权限，这就是真实威胁）。
  const frozen = JSON.parse(theCtx.files.get(`${CASE_DIR}/估值输入.json`))
  frozen.baseDate = '2026-01-01'
  frozen.supplementalPrompt = '改成按我的想法算'
  theCtx.files.set(`${CASE_DIR}/估值输入.json`, JSON.stringify(frozen))

  const tampered = await ops['valuation-result']({ valuationId: VALUATION_ID })
  assert.equal(tampered.ok, false, '被改过就不算干净的结果')
  assert.equal(tampered.snapshotTampered, true)
  assert.match(tampered.error, /输入快照被改过/)
  assert.match(tampered.error, /基准日/)
  assert.match(tampered.error, /以宿主记录的那一份为准/)
  // 也要进能力缺口：结果页与交付件复核都读它。
  assert.match(lifecycles.get(VALUATION_ID).capabilityGaps.join('；'), /输入快照被改过/)
})

test('冻结输入文件不见了同样要报（它不是"没问题"）', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  theCtx.files.delete(`${CASE_DIR}/估值输入.json`)

  const result = await ops['valuation-result']({ valuationId: VALUATION_ID })
  assert.equal(result.snapshotTampered, true)
  assert.match(result.error, /不见了/)
})

test('完成由宿主判定：三件交付件齐备且结果读得懂 → completed（否则留在 running）', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  const resultFile = `${CASE_DIR}/估值结果.json`

  // 只有两件：还没完成，也不该报错（本轮还没做完）。
  theCtx.files.set(`${CASE_DIR}/估值底稿.xlsx`, 'xlsx')
  theCtx.files.set(`${CASE_DIR}/估值报告.html`, '<html></html>')
  let status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running')
  assert.deepEqual(status.artifacts, { html: true, xlsx: true, json: false })

  // 三件齐了但结果读不懂（子会话刚写了一半）：**仍然不算完成** —— 结果页要拿它渲染结论。
  theCtx.files.set(resultFile, '{ 这不是 JSON')
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '读不懂的结果不能算完成')

  // 结果可解析、但**没有列出采用的知识库规范**：仍然不算完成（§9「采用规则可追溯」）。
  theCtx.files.set(resultFile, JSON.stringify({
    method: 'market', baseDate: '', unitPrice: 42000, totalValue: 5_061_000, pricingArea: 120.5, priceUnit: '元/㎡',
  }))
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '没有列出采用规则的结论不能算完成')
  assert.match(status.progress.detail, /没有列出采用的知识库规范/)

  // 采用案例没有页面证据：一样不算完成（§9「必要截图齐备」的宿主侧判据）。
  theCtx.files.set(resultFile, JSON.stringify({
    method: 'market', baseDate: '', unitPrice: 42000, totalValue: 5_061_000, pricingArea: 120.5, priceUnit: '元/㎡',
    knowledge_sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
    cases: [{ url: 'https://x/1', used_as_comparable: true, evidence: '', evidence_missing: true }],
  }))
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '没有页面证据的采用案例不能作为结论的依据')
  assert.match(status.progress.detail, /没有页面证据/)

  // 市场法只有 1 条采用案例：规范要求不少于 3 条 —— 有单价也不许算完成（没有依据的正式结论）。
  theCtx.files.set(resultFile, JSON.stringify({
    method: 'market', baseDate: '', unitPrice: 42000, totalValue: 5_061_000, pricingArea: 120.5, priceUnit: '元/㎡',
    knowledge_sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
    cases: [{ url: 'https://x/1', used_as_comparable: true, evidence: '来源证据/fang-1.html', evidence_missing: false }],
  }))
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '案例数量不足时不能给出正式单价')
  assert.match(status.progress.detail, /规范要求不少于 3 条/)

  // 单价 × 计价面积与总价对不上：一样不算完成（金额口径不一致）。
  theCtx.files.set(resultFile, JSON.stringify({
    method: 'market', baseDate: '', unitPrice: 42000, totalValue: 1, pricingArea: 120.5, priceUnit: '元/㎡',
    knowledge_sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
    cases: [{ url: 'https://x/1', used_as_comparable: true, evidence: '来源证据/fang-1.html', evidence_missing: false }],
  }))
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '金额口径对不上不算完成')
  assert.match(status.progress.detail, /对不上/)

  // 交付校验还没跑过 → 仍然不算完成（§9：`completed` 不能靠"文件在不在"）。
  assert.match(status.progress.detail, /还没有跑过交付校验/)

  // 三件齐 + 结果可解析 + 采用规则可追溯 + 采用案例都有证据 + 案例数量够 + 金额勾稽一致
  // + **交付校验通过** → 完成。
  lifecycles.setValidation(VALUATION_ID, true, [])
  const threeCases = [1, 2, 3].map((index) => ({
    url: `https://x/${String(index)}`, used_as_comparable: true,
    evidence: `来源证据/fang-${String(index)}.html`, evidence_missing: false,
  }))
  theCtx.files.set(resultFile, JSON.stringify({
    // 42000 × 120.5 = 5,061,000（整数，勾稽一致）。
    method: 'market', baseDate: '', unitPrice: 42000, totalValue: 5_061_000, pricingArea: 120.5, priceUnit: '元/㎡',
    knowledge_sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
    cases: threeCases,
  }))
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'completed')
  assert.equal(status.artifacts.json, true)
  assert.equal(status.progress.completed, status.progress.total, '完成时进度要走满')
  assert.equal(lifecycles.get(VALUATION_ID).phase, 'completed')
  // 重算能力本部署没有 → 完成时**必须**把这条能力缺口写进这一轮（不包装成"已自动核对"）。
  assert.match(lifecycles.get(VALUATION_ID).capabilityGaps.join('\n'), /没有底稿重算能力/)

  // 终态不许被推回去：删掉一件之后再轮询，仍然是 completed（已交付过的东西不撤回）。
  theCtx.files.delete(`${CASE_DIR}/估值报告.html`)
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'completed')
})

// ── 确认抽屉的数据（`valuation-intake`）─────────────────────────────────────
// 这几条补的是一个**此前完全没有测试**的操作：抽屉的全部内容都来自它，
// 而"抽屉显示 12 项全缺、每份文件都写着已解析"这种错，只有跑一次才看得见。

const INTAKE_ARGS = {
  valuationId: VALUATION_ID,
  paths: [`${WORKSPACE}/估值报告.pdf`],
  method: 'market',
  baseDate: '',
  supplementalPrompt: '',
}

test('valuation-intake：抽屉里的已知信息来自**真的提取**，而不是一张空表', async () => {
  // 选择清单的扫描走 node fs（员工选的是本机真实文件），所以这里造一个真实临时文件。
  const sourceDir = mkdtempSync(join(tmpdir(), 'crwu-intake-'))
  const sourcePath = join(sourceDir, '估值报告.pdf')
  writeFileSync(sourcePath, 'pdf-bytes')
  try {
  const ctx = makeCtx({
    manifest: manifestOf(),
    extractPayload: (source) => ({
      ok: true, error: '', fileName: source.split('/').pop(), fileType: 'pdf',
      text: '坐落：示例路 1 号；建筑面积：120.5 平方米',
      tables: [], images: [],
      extractedFields: { 坐落: '示例路 1 号', 建筑面积: '120.5', 用途: '住宅' },
      warnings: [], capabilityGaps: [],
    }),
  })
  const { ops, ctx: theCtx } = makeDeps({
    ctx,
    // DSH Python 的解析器替身：返回一个**存在的路径**（脚本本身由提取器先落到案例目录里，
    // 命令由下面的 shell 替身接住，所以这个路径不需要真的可执行）。
    python: { async check() { return { ok: true, error: '', path: '/fake/bin/python3' } }, cached: () => null },
  })
  const result = await ops['valuation-intake']({ ...INTAKE_ARGS, paths: [sourcePath] })

  assert.equal(result.ok, true, result.error)
  // ① 已知信息真的来自提取结果。
  assert.equal(result.extractedFields['坐落'], '示例路 1 号')
  assert.equal(result.extractedFields['用途'], '住宅')
  // ② 缺失清单是**剩下的那些**，而不是永远 12 项全缺。
  assert.equal(result.missingFields.includes('坐落'), false, '提取到的要素不该还算缺失')
  assert.equal(result.missingFields.includes('总楼层'), true)
  assert.ok(result.missingFields.length < 12, `缺失项不该是全部 12 项：${result.missingFields.join('、')}`)
  // ③ 文件状态与提取结果一致：真的读过才叫 parsed，并且带上要素条数。
  const file = result.files.find((item) => item.fileName === '估值报告.pdf')
  assert.equal(file.status, 'parsed')
  assert.equal(file.fieldCount, 3)
  assert.deepEqual(result.unparsed, [])
  // ④ 抽屉看到的那一份要落盘（确认与结果之间要有据可查）。
  assert.equal(theCtx.files.has(`${CASE_DIR}/资料提取预览.json`), true)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

test('valuation-intake：复制成功但**没提取出来**时不许写 parsed', async () => {
  // 没有 python 提取能力：文件照样归档进案例目录，但状态必须说实话。
  const sourceDir = mkdtempSync(join(tmpdir(), 'crwu-intake-nopy-'))
  const sourcePath = join(sourceDir, '估值报告.pdf')
  writeFileSync(sourcePath, 'pdf-bytes')
  try {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops } = makeDeps({ ctx })
  const result = await ops['valuation-intake']({ ...INTAKE_ARGS, paths: [sourcePath] })

  assert.equal(result.ok, true, result.error)
  const file = result.files.find((item) => item.fileName === '估值报告.pdf')
  assert.equal(file.status, 'unparsed', '复制成功 != 解析成功')
  assert.match(file.note, /没有提取出来/)
  assert.deepEqual(result.unparsed, ['估值报告.pdf'])
  assert.deepEqual(result.extractedFields, {})
  assert.deepEqual([...result.missingFields], [...VALUATION_FIELD_KEYS], '没提取到就 12 项全缺（不编造）')
  assert.match(result.capabilityGaps.join('；'), /未解析的资料/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

// ── 浏览器登录预检（`valuation-browser-preflight`）──────────────────────────
// §16 的「页面可通过默认浏览器登录」就是这一条。此前它**一次都没被测过**
//（这正是 round 27 的教训：没人跑过的操作 = 没人知道它坏着）。

test('valuation-browser-preflight：只打开该站点**自己的**登录页，不读 Cookie、不碰凭据', async () => {
  const ctx = makeCtx()
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const before = theCtx.commands.length
  const result = await ops['valuation-browser-preflight']({ openLogin: 'lianjia' })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.opened, true)
  assert.equal(result.openError, '')
  // 打开的是**站点定义里那一条**登录地址（只此一份，不许在别处再抄一个）。
  const opened = theCtx.commands.slice(before).filter((command) => command.startsWith('open '))
  assert.equal(opened.length, 1, `应当只打开一个地址：${opened.join(' | ')}`)
  assert.match(opened[0], /passport\.lianjia\.com/)
  // 三家来源的登录状态都要回给面板（抽屉要显示"已登录 / 未登录 / 无法检查"）。
  assert.deepEqual(result.providers.map((item) => item.id).sort(), ['anjuke', 'fang', 'lianjia'])
  // **凭据绝不进结果**：替身不联网，所以状态是 unknown —— 那也不许顺手回任何令牌类字段。
  const rendered = JSON.stringify(result)
  for (const forbidden of ['cookie', 'Cookie', 'authorization', 'Authorization', 'token', 'sign=']) {
    assert.equal(rendered.includes(forbidden), false, `结果里不该出现 ${forbidden}`)
  }
  assert.equal(result.providers.every((item) => item.state === 'unknown'), true, '连不上就是 unknown（不假设已登录）')
})

test('valuation-browser-preflight：未知来源直接拒绝，且**一个命令都不发**', async () => {
  const ctx = makeCtx()
  const { ops, ctx: theCtx } = makeDeps({ ctx })
  const before = theCtx.commands.length
  const result = await ops['valuation-browser-preflight']({ openLogin: '链家' })

  assert.equal(result.ok, false)
  assert.match(result.error, /未知来源/)
  assert.equal(result.opened, false)
  assert.equal(theCtx.commands.length, before, '未知来源不许触发任何 shell 命令')
})

test('valuation-browser-preflight：没授权时不许打开浏览器（fail closed，如实回 Broker 的原话）', async () => {
  const ctx = makeCtx()
  const { ops } = makeDeps({ ctx, consent: 'missing' })
  const result = await ops['valuation-browser-preflight']({ openLogin: 'fang' })

  // 操作的 `ok` 是"这次预检拿到了状态"；打开失败要如实落在 `opened` / `openError` 上。
  assert.equal(result.opened, false, '未授权不许真的打开浏览器')
  assert.notEqual(result.openError, '', '失败原因必须回给界面，不许静默')
  assert.match(result.openError, /本机访问尚未允许|不允许来自/)
})

test('intake 建案例子目录必须**提权**：面板没有会话，非特权命令会被自家沙箱拦下', async () => {
  // 2026-10-13 用户实测：`mkdir …/材料-源` 报
  // 「Operation not permitted（来源 audit-tool · 解析为 workspace-write · 沙箱拒绝=是）」。
  // 根因：面板没有会话 → `callerSessionPolicy(ctx, undefined)` = undefined → 执行器落回部署默认。
  // 判据：这条命令必须**逐次声明提权**（特权操作由操作表钉死，不依赖会话）。
  const sourceDir = mkdtempSync(join(tmpdir(), 'crwu-intake-escalate-'))
  const sourcePath = join(sourceDir, '估值报告.pdf')
  writeFileSync(sourcePath, 'pdf-bytes')
  try {
    const ctx = makeCtx({ manifest: manifestOf() })
    const { ops } = makeDeps({ ctx })
    await ops['valuation-intake']({ ...INTAKE_ARGS, paths: [sourcePath] })

    const material = ctx.shellCalls.filter((call) => call.command.includes('材料-源'))
    assert.equal(material.length > 0, true, `没有建材料目录的命令：${ctx.commands.join(' | ')}`)
    for (const call of material) {
      assert.equal(call.mode, 'danger-full-access',
        `材料目录的命令必须提权（面板没有会话，workspace-write 会被自家沙箱拒掉）：${call.mode || '（无策略）'} · ${call.command}`)
    }
    // 反向：一条非提权的都不许出现（那正是被拒的形态）。
    const lowered = material.filter((call) => call.mode !== 'danger-full-access')
    assert.deepEqual(lowered.map((call) => call.mode || '（无策略）'), [], '材料目录不许用非特权命令创建')
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

test('valuation-intake：多份资料对同一要素给出不同值时，冲突要**如实列出来**而不是静默取第一个', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'crwu-intake-conflict-'))
  const a = join(sourceDir, '报告A.pdf')
  const b = join(sourceDir, '报告B.pdf')
  writeFileSync(a, 'pdf-a')
  writeFileSync(b, 'pdf-b')
  try {
    const ctx = makeCtx({
      manifest: manifestOf(),
      extractPayload: (source) => {
        const name = source.split('/').pop()
        return {
          ok: true, error: '', fileName: name, fileType: 'pdf',
          text: '', tables: [], images: [],
          // 两份对"建筑面积"给了不同的值；"用途"两份一致（不算冲突）。
          extractedFields: name === '报告A.pdf'
            ? { 建筑面积: '120.5', 用途: '住宅' }
            : { 建筑面积: '98.0', 用途: '住宅' },
          warnings: [], capabilityGaps: [],
        }
      },
    })
    const { ops } = makeDeps({
      ctx,
      python: { async check() { return { ok: true, error: '', path: '/fake/bin/python3' } }, cached: () => null },
    })
    const result = await ops['valuation-intake']({ ...INTAKE_ARGS, paths: [a, b] })

    assert.equal(result.ok, true, result.error)
    // 冲突逐条列出，且**双方的值都在**（用户要能自己判断，而不是看一张干净的表）。
    assert.deepEqual(result.fieldConflicts.map((item) => item.label), ['建筑面积'])
    const conflict = result.fieldConflicts[0]
    assert.deepEqual(conflict.values.map((item) => item.value).sort(), ['120.5', '98.0'])
    assert.deepEqual(conflict.values.map((item) => item.file).sort(), ['报告A.pdf', '报告B.pdf'])
    // 值一致的要素不算冲突。
    assert.equal(result.fieldConflicts.some((item) => item.label === '用途'), false)
    // 当前采用哪一份要写出来（首个非空值 + 来源），并在 warnings 里说明。
    assert.equal(result.fieldSources['建筑面积'], '报告A.pdf')
    assert.match(result.warnings.join('\n'), /资料冲突：建筑面积/)
    assert.match(result.warnings.join('\n'), /当前采用「报告A.pdf」那一份/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

test('valuation-intake：多份资料给出**相同**的值时不算冲突（不制造噪音）', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'crwu-intake-same-'))
  const a = join(sourceDir, '报告A.pdf')
  const b = join(sourceDir, '报告B.pdf')
  writeFileSync(a, 'pdf-a')
  writeFileSync(b, 'pdf-b')
  try {
    const ctx = makeCtx({
      manifest: manifestOf(),
      extractPayload: (source) => ({
        ok: true, error: '', fileName: source.split('/').pop(), fileType: 'pdf',
        text: '', tables: [], images: [],
        extractedFields: { 建筑面积: '120.5' },
        warnings: [], capabilityGaps: [],
      }),
    })
    const { ops } = makeDeps({
      ctx,
      python: { async check() { return { ok: true, error: '', path: '/fake/bin/python3' } }, cached: () => null },
    })
    const result = await ops['valuation-intake']({ ...INTAKE_ARGS, paths: [a, b] })
    assert.deepEqual(result.fieldConflicts, [], '两份说的一样就不是冲突')
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

test('完成门槛：采用案例带着没通过的规则判定时不许算完成（规范允许的组内比值例外）', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })
  await ops['valuation-start'](START_ARGS)
  theCtx.files.set(`${CASE_DIR}/估值底稿.xlsx`, 'xlsx')
  theCtx.files.set(`${CASE_DIR}/估值报告.html`, '<html></html>')

  // 交付校验通过（组内比值那条例外要看的是规则判定，不是校验门槛）。
  lifecycles.setValidation(VALUATION_ID, true, [])
  const template = {
    method: 'market', baseDate: '', unitPrice: 42000, totalValue: 5_061_000,
    pricingArea: 120.5, priceUnit: '元/㎡',
    knowledge_sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
  }
  const cases = [1, 2, 3].map((index) => ({
    url: `https://x/${String(index)}`, used_as_comparable: true,
    unit_price: 42000, evidence: `来源证据/fang-${String(index)}.html`, evidence_missing: false,
    rule_checks: [
      { rule_id: 'R-SINGLE-20', actual: 0.08, threshold: 0.2, verdict: 'pass', reason: '楼层 +8%' },
      { rule_id: 'R-GROUP-1.2', actual: 1.0, threshold: 1.2, verdict: 'pass', reason: '组内比值 1.0' },
    ],
  }))
  const write = (payload) => { theCtx.files.set(`${CASE_DIR}/估值结果.json`, JSON.stringify(payload)) }

  // ① 采用案例带着 R-SINGLE-20 fail → 不算完成。
  const bad = JSON.parse(JSON.stringify({ ...template, cases }))
  bad.cases[1].rule_checks[0].verdict = 'fail'
  bad.cases[1].rule_checks[0].reason = '装修 +30% 超过 20%'
  write(bad)
  let status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '采用案例不能带着没通过的规则')
  assert.match(status.progress.detail, /带着没通过的规则判定/)

  // ② 组内一致性 fail 是**规范允许**的（说明处置方式后保留）→ 可以完成。
  const allowed = JSON.parse(JSON.stringify({ ...template, cases }))
  for (const item of allowed.cases) {
    item.rule_checks[1].actual = 1.5
    item.rule_checks[1].verdict = 'fail'
    item.rule_checks[1].reason = '组内比值 1.5 超过 1.2：已说明处置方式并保留'
  }
  // 比值超过 1.2 时必须有说明（这里补上，模拟真实处置）。
  write({ ...allowed, manual_confirmation_items: ['组内比值 1.5 超过 1.2：已说明处置方式并保留，需复核'] })
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'completed', '组内一致性是允许说明后保留的例外')
})

test('完成门槛：用户指定的方法被换掉时必须写出方法冲突（不许静默切换）', async () => {
  const ctx = makeCtx({ manifest: manifestOf() })
  const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })
  // 用户在确认时指定了**收益法**。
  await ops['valuation-start']({ ...START_ARGS, method: 'income', baseDate: '' })
  theCtx.files.set(`${CASE_DIR}/估值底稿.xlsx`, 'xlsx')
  theCtx.files.set(`${CASE_DIR}/估值报告.html`, '<html></html>')
  lifecycles.setValidation(VALUATION_ID, true, [])

  const base = {
    method: 'market', methodReason: '', baseDate: '', unitPrice: 42000, totalValue: 5_061_000,
    pricingArea: 120.5, priceUnit: '元/㎡',
    knowledge_sources: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
    cases: [1, 2, 3].map((index) => ({
      url: `https://x/${String(index)}`, used_as_comparable: true, unit_price: 42000,
      evidence: `来源证据/fang-${String(index)}.html`, evidence_missing: false,
      rule_checks: [{ rule_id: 'R-SINGLE-20', actual: 0.05, threshold: 0.2, verdict: 'pass', reason: '楼层 +5%' }],
    })),
  }

  // ① 用户指定收益法、结论用市场法，却没有冲突记录 → 不算完成。
  theCtx.files.set(`${CASE_DIR}/估值结果.json`, JSON.stringify({ ...base, methodConflict: null }))
  let status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'running', '静默切换方法不能算完成')
  assert.match(status.progress.detail, /没有方法冲突记录/)

  // ② 写出冲突与原因 → 可以完成。
  theCtx.files.set(`${CASE_DIR}/估值结果.json`, JSON.stringify({
    ...base,
    methodConflict: {
      userMethod: 'income', adoptedMethod: 'market',
      reason: '对象空置、无租赁合同与租金记录：收益法缺净收益序列，按规范改按市场法',
    },
    manual_confirmation_items: ['用户指定收益法，因缺租金数据改按市场法：请复核'],
  }))
  status = await ops['valuation-status']({ valuationId: VALUATION_ID })
  assert.equal(status.phase, 'completed')
})

test('估值链路：intake 之后再点「确认并开始估值」，必须**真的建会话并发出指令**', async () => {
  // 用户 2026-10-13 实测：点「确认并开始估值」无法自动开始。
  // 根因：`valuation-intake` 为了记阶段与支持取消，**在提取开始前**就开了那条轮次记录
  //（phase 停在 confirmation、没有 sessionId）；而 `valuation-start` 的幂等分支只判
  // "记录存在"，于是直接返回 `ok:true, reused:true` —— 界面进了"运行中"，
  // 实际既没建会话、也没落 `估值输入.json`、更没发指令。
  const sourceDir = mkdtempSync(join(tmpdir(), 'crwu-confirm-'))
  const sourcePath = join(sourceDir, '估值报告.pdf')
  writeFileSync(sourcePath, 'pdf-bytes')
  try {
    const ctx = makeCtx({
      manifest: manifestOf(),
      extractPayload: (source) => ({
        ok: true, error: '', fileName: source.split('/').pop(), fileType: 'pdf',
        text: '坐落：示例路 1 号；建筑面积：120.5 平方米', tables: [], images: [],
        extractedFields: { 坐落: '示例路 1 号', 建筑面积: '120.5' },
        warnings: [], capabilityGaps: [],
      }),
    })
    const { ops, lifecycles, ctx: theCtx } = makeDeps({ ctx })

    // ① 先走一次真实 intake（它会开一条 confirmation 阶段的存根记录）。
    const intake = await ops['valuation-intake']({ ...INTAKE_ARGS, paths: [sourcePath] })
    assert.equal(intake.ok, true, intake.error)
    const stub = lifecycles.get(VALUATION_ID)
    assert.equal(stub.phase, 'confirmation')
    assert.equal(stub.sessionId, '', '存根记录还没有会话')

    // ② 再点「确认并开始估值」。
    const started = await ops['valuation-start']({
      ...START_ARGS,
      confirmedSnapshotDigest: '',   // intake 之后的确认不带旧指纹时也不该被幂等分支吞掉
    })
    assert.equal(started.ok, true, started.error)
    assert.equal(started.reused, false, '存根记录不算"已经开过"：这一次是真开')
    assert.notEqual(started.sessionId, '', '必须真的建了会话')

    // ③ 三条副作用都要发生：会话、冻结输入、指令。
    assert.equal(theCtx.controllerRequests.length, 1, '要建一条会话')
    const record = lifecycles.get(VALUATION_ID)
    assert.equal(record.sessionId, started.sessionId, '会话号要补进那条存根记录')
    const input = theCtx.files.get(`${CASE_DIR}/估值输入.json`)
    assert.ok(input !== undefined, '冻结输入必须真的落盘')
    const frozen = JSON.parse(input)
    assert.equal(frozen.valuationId, VALUATION_ID)
    assert.equal(frozen.method, 'market')
    assert.equal(frozen.baseDate, '', '基准日没选就是空串')
    assert.equal(frozen.supplementalPrompt, START_ARGS.supplementalPrompt)
    assert.equal(frozen.files.length, 1, '冻结输入要带上资料清单')
    // 指纹以**磁盘上的清单**重算（intake 的预览不可信），记录与冻结输入必须一致。
    assert.match(record.digest, /^sha256:[0-9a-f]{64}$/, '指纹要补进记录')
    assert.equal(frozen.digest, record.digest, '记录与冻结输入的指纹必须一致')
    // 指令发出去了：内容里带着案例目录与估值 ID（这是子会话唯一拿得到的业务上下文）。
    assert.ok(theCtx.prompts.length >= 1, '必须把业务指令发给子会话')
    const sent = JSON.stringify(theCtx.prompts[theCtx.prompts.length - 1])
    assert.match(sent, /房地产估值/)
    assert.match(sent, new RegExp(VALUATION_ID))

    // ④ 真的重复点一次（会话已在）仍然是幂等的，不会再建第二条。
    const again = await ops['valuation-start'](START_ARGS)
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
    assert.equal(theCtx.controllerRequests.length, 1, '重复点确认不该起第二条会话')
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

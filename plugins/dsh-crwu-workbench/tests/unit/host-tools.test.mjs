/**
 * CRWU 结构化 Tool 的行为测试。
 *
 * 这一层是本次改造的核心约束所在，所以每条断言都对着一条**不可回退**的规则：
 *
 * 1. 工具只经 `ctx.tools.register()` 注册，插件卸载时逐个注销；
 * 2. 工具参数里**没有** command / argv / 二进制路径 / sandbox 模式这类逃生字段
 *    （模型只能提交业务参数）；
 * 3. 业务命令由工具内部用**包内绝对路径**经 `ctx.shell` 执行，且 `exec.signal` 一路透传；
 * 4. 默认操作不带 `danger-full-access`；只有白名单内的本机凭据命令、且已授权、且
 *    工作区已知时才申请提权；
 * 5. 钉钉归档/通知的稳定 ID 全部来自真实返回，写后校验、单案例幂等、不用 sms/call；
 * 6. OSS 上传后真的列举核对对象与字节数。
 *
 * 所有替身都是内存实现：**不碰真实氚云 / 钉钉 / OSS / 凭据 / 用户文件**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../helpers/shell-effects.mjs'
import { grantedConsent, missingConsent } from '../helpers/local-access-fixture.mjs'
import { makeTestAccess } from '../helpers/local-access-broker-fixture.mjs'

const ROOT = new URL('../../', import.meta.url)
const { createDiscussionScopeRegistry } = await import(
  new URL('src/host/audit/discussion-scope.ts', ROOT).href)
const { openDiscussionMaterial } = await import(
  new URL('src/host/audit/discussion-material.ts', ROOT).href)
const { makeSandboxedFs, makeSandboxedShell, makeSessionPolicyService } = await import(
  new URL('tests/helpers/fs-sandbox-stub.mjs', ROOT).href)

const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
const { registerCrwuTools, missingAuditTools } = await import(new URL('src/host/tools/register.ts', ROOT).href)
const { AUDIT_CHILD_DENIED_TOOLS, CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_CHILD_TOOLS, REQUIRED_AUDIT_TOOLS, TOOL_NAMES } = await import(new URL('src/host/tools/consts.ts', ROOT).href)
const { sanitizeOssError } = await import(new URL('src/host/tools/oss.ts', ROOT).href)
const { classifyRun } = await import(new URL('src/host/tools/outcome.ts', ROOT).href)
const { assertDwsCommand, dwsOperationOf, runDws } = await import(new URL('src/host/dws/run.ts', ROOT).href)
const { DWS_ALLOWED_PREFIXES } = await import(new URL('src/host/dws/consts.ts', ROOT).href)
const { buildPublishPlan, parseIsoStamp, safeProjectId, nodeSize } = await import(new URL('src/host/dws/plan.ts', ROOT).href)
const { channelFor, buildPathIndex, resolveRequestedPaths } = await import(new URL('src/host/dws/knowledge-tree.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)
const { capabilityPreflight, auditToolsVisible } = await import(new URL('src/host/audit/preflight.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: 'crwu-workspace', ossPrefix: 'crwu/audit', ossEndpoint: 'oss-cn-beijing.aliyuncs.com',
  ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true,
}

const SEQ = '2026-301705-LX10170-BG8746'
const CASE_DIR = `/cases/space/${SEQ}`

/** `crwu h3yun records get` 的真实形状：`{ data: {...} }`，字段代码原样保留。 */
// 真实形状（对照 `host-crwu-h3yun.test.mjs` 里从 CLI 抄下来的样本）：记录**自带**
// `ObjectId` 与 `SeqNo`。bootstrap 现在会核对这两个字段（身份绑定，2026-09-29 复查的 P1）。
const RECORD_JSON = JSON.stringify({ data: { ObjectId: 'obj-1', SeqNo: SEQ, F0000049: '某项目', F0000020: 'B' } })
/** `crwu h3yun files list` 的真实形状：`{ data: [ { field, fileId, fileName, fileSize, contentType, downloadUrl } ] }`。 */
const FILES_JSON = JSON.stringify({
  data: [{
    field: 'F0000143', fileId: 'f1', fileName: '报告.zip', fileSize: '1024',
    contentType: 'application/zip', downloadUrl: 'https://example.invalid/signed?token=SECRET',
  }],
})

// ── 替身：内存 fs / shell / tools ───────────────────────────────────────────

/** 包内二进制目录（仓库已 `make plugin-bin`）：工具严格要求它们存在，替身也要认。 */
const PKG_BIN_DIR = new URL('bin/darwin-arm64/', ROOT).pathname.replace(/\/$/, '')
const PKG_BIN_WIN_DIR = new URL('bin/win32-x64/', ROOT).pathname.replace(/\/$/, '')
/**
 * 两个平台的包内二进制都让替身「存在」：Windows 用例要走 `requireBundledCommand`
 * （严格解析，找不到就回 capability gap），而 JSON 里 win32 的文件名带 `.exe`。
 */
const PKG_BIN_FILES = [
  ...['crwu', 'dws', 'ossutil'].map((name) => `${PKG_BIN_DIR}/${name}`),
  ...['crwu', 'dws', 'ossutil'].map((name) => `${PKG_BIN_WIN_DIR}/${name}.exe`),
]

function makeFs({ dirs = [], files = {} } = {}) {
  const dirSet = new Set([PKG_BIN_DIR, ...dirs])
  const fileMap = new Map(Object.entries(files))
  for (const path of PKG_BIN_FILES) fileMap.set(path, 'binary')
  const target = (path) => ({ targetKey: path, displayPath: path })
  return {
    files: fileMap,
    dirs: dirSet,
    addFile(path, content) { fileMap.set(path, content) },
    async resolve(path, opts) {
      const base = opts?.cwd ?? ''
      // 绝对 = POSIX 根 / 盘符根 / UNC（裸 `C:` 不算，与实现同一判据）。
      const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
      const full = absolute ? path : `${base.replace(/[\\/]+$/, '')}/${path}`
      return target(full)
    },
    async stat(t) {
      const key = String(t.targetKey).replace(/[\\/]+$/, '')
      if (dirSet.has(key)) return { type: 'directory', version: 'v' }
      if (fileMap.has(t.targetKey)) return { type: 'file', size: String(fileMap.get(t.targetKey)).length, version: 'v' }
      return undefined
    },
    async readText(t) { return fileMap.get(t.targetKey) ?? '' },
    async writeText(t, content) { fileMap.set(t.targetKey, content); return { operation: 'create', version: 'v' } },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`)
              // 两种分隔符都要认：真实 `fs.contains` 是**规范化**比较（Windows 路径不在少数），
              // 夹具只认 `/` 会让 Windows 用例假红、或掩盖真实行为。
              || c.startsWith(`${p}\\`)
    },
  }
}

function shellOk(stdout = '', stderr = '', exitCode = 0) {
  return {
    exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
    stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false },
  }
}

/** 记录每次 resolve 的请求 + 交给 handler 决定输出。handler 返回 null 表示「不该被调用」。 */
function makeShell(handler) {
  const requests = []
  const commands = []
  /**
   * 内存 fs 替身；由 `makeDeps` 注入。
   *
   * 实现会**回读后置条件**（命令成功 !== 目录真的在），所以替身里的 shell 必须把成功的建/删命令
   * 真的作用到 fs 上，否则这条替身就是一台「命令成功但文件系统没变」的假机器。
   */
  let fs = null
  return {
    requests,
    commands,
    attachFs(next) { fs = next },
    service: {
      resolve(request) {
        requests.push(request)
        return {
          ...request,
          workdir: request.workdir ?? '/default',
          timeoutMs: request.timeoutMs ?? 1000,
          stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
          sandboxPolicy: request.sandboxPolicy,
        }
      },
      async execute(spec) {
        commands.push(spec.command)
        // 只读路径探测由替身按内存 fs **忠实**回答（实现用它回读后置条件）；
        // 其余命令照旧交给用例自己的 handler。
        if (fs !== null) {
          const probe = probeAnswer(spec.command, {
            hasDir: (path) => fs.dirs.has(probeKey(path)),
            hasFile: (path) => fs.files.has(probeKey(path)),
          })
          if (probe !== undefined) return { result: async () => shellOk(probe) }
        }
        const result = handler(spec)
        if (result === null) throw new Error(`不允许执行的命令：${spec.command}`)
        if (fs !== null) {
          applyShellEffect(spec.command, result.exitCode, {
            addDir: (path) => fs.dirs.add(path),
            removeFile: (path) => fs.files.delete(path),
          })
        }
        return { result: async () => result }
      },
    },
  }
}

function makeCtx({ fs, shell, tools, sandboxPolicy }) {
  const services = { fs, shell, tools, sandboxPolicy }
  return {
    get(name) { return services[name] },
    on() { return () => {} },
    effect(fn) { fn() },
    logger: { info() {}, warn() {}, error() {} },
  }
}

/** 最小注册表：只在内存里存定义，并按 defineTool 的契约校验参数与输出。 */
function makeRegistry({ hidden = [] } = {}) {
  const definitions = new Map()
  return {
    definitions,
    register(definition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
    get(name, scope) {
      // 隐藏只作用于**有 scope 的视图**：全局视图（scope 省略）照旧看得到，
      // 这样「审核根 Agent 看不到某个工具」才是一个真实的收窄场景。
      if (scope !== undefined && hidden.includes(name)) return undefined
      return definitions.get(name)
    },
    async execute(input) {
      const definition = definitions.get(input.name)
      if (definition === undefined) return { isError: true, error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL', message: input.name } }
      // `defineTool` 交出来的 `parameters` / `output.schema` 已经是**编译后的 JSON Schema**，
      // 所以这里直接用注册表同款的 `validateJsonSchemaValue` 校验 —— 与真实 pipeline 同一判据。
      const argViolations = validateJsonSchemaValue(definition.parameters, input.arguments, '')
      if (argViolations.length > 0) return { isError: true, error: { name: 'ToolArgsError', code: 'TOOL_ARGS', message: argViolations.join('; ') } }
      let value
      try {
        value = await definition.execute(input.arguments, {
          ...input, token: Symbol('t'), rootCallId: input.callId, deferContext() {}, concludeTurn() {},
        })
      } catch (error) {
        return { isError: true, error: { name: 'ToolError', code: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
      }
      const outputViolations = validateJsonSchemaValue(definition.output.schema, value)
      if (outputViolations.length > 0) {
        return { isError: true, error: { name: 'ToolOutputError', code: 'TOOL_OUTPUT', message: outputViolations.join('; ') } }
      }
      return { isError: false, value }
    },
  }
}

function makeState(patch = {}) {
  const state = createWorkbenchState(CONFIG)
  state.manifest.oss.bucket = 'crwu-workspace'
  state.manifest.oss.prefix = 'crwu/audit'
  state.manifest.oss.endpoint = 'oss-cn-beijing.aliyuncs.com'
  // 缺省**已允许**本机访问：绝大多数用例关心的是业务行为；验授权闸门的用例显式传
  // `localAccess: missingConsent()`（见 B-04 那条）。
  return { ...state, localAccess: grantedConsent(), ...patch }
}

/**
 * 表单解析器替身：真实解析器会跑 `crwu h3yun forms search`。
 * 这里只回答「code 是什么」，并记录被问了几次 —— 「模型不提交 schemaCode，由 Host 给」
 * 这条约束就靠它验证（`ensure` 被调用 = Host 自己解析，而不是从参数里读）。
 */
function makeForm({ code = 'FORM-1', name = '报告审核', fails = false } = {}) {
  const calls = []
  return {
    calls,
    resolver: {
      async ensure() {
        calls.push('ensure')
        if (fails) return { ok: false, code: '', name: '', error: '未在氚云定位到表单「报告审核」', escalated: false }
        return { ok: true, code, name, error: '', escalated: false }
      },
    },
  }
}

function makeDeps({ fs, shell, tools, state, form, platform = 'darwin-arm64', discussionScopes } = {}) {
  const theState = state ?? makeState()
  const theFs = fs ?? makeFs({ dirs: [CASE_DIR, `${CASE_DIR}/knowledge`] })
  const theShell = shell ?? makeShell(() => shellOk('{}'))
  if (typeof theShell.attachFs === 'function') theShell.attachFs(theFs)
  const registry = tools ?? makeRegistry()
  const ctx = makeCtx({ fs: theFs, shell: theShell.service, tools: registry })
  const theForm = form ?? makeForm()
  const { access } = makeTestAccess(ctx, { state: theState })
  // 讨论会话的受限材料范围（协议 23）：缺省是空注册表（没有会话被登记过）。
  const scopes = discussionScopes ?? createDiscussionScopeRegistry()
  return {
    ctx, fs: theFs, shell: theShell, registry, state: theState, form: theForm, discussionScopes: scopes,
    deps: {
      ctx,
      config: { ...CONFIG },
      state: theState,
      access,
      form: theForm.resolver,
      discussionScopes: scopes,
      world: {
        platform: async () => platform,
        home: async () => '/Users/x',
        workdir: async () => '/cases/session',
        cached: () => ({ platform, home: '/Users/x' }),
      },
    },
  }
}

/** 审核子会话的 childId（案例内 Tool 必须能由它找到本轮的 Host 记录）。 */
const AUDIT_CHILD = 'child-audit-1'

/**
 * 给状态种一个**正在跑的审核 scope**：`casePath` / `allowedAttachmentIds` 都是 Host 的值。
 *
 * 案例内 Tool 的判据是"与 Host 记录的 casePath 规范解析后**精确相等**"，
 * 所以夹具必须先有这条记录 —— 这也正是被测的那条不变式（模型提交的字符串不是权威）。
 */
function withAuditScope(state, patch = {}) {
  const childId = patch.childId ?? AUDIT_CHILD
  state.audits = {
    ...(state.audits ?? {}),
    S1: {
      key: 'S1', childId, seqNo: SEQ, project: '', objectId: patch.objectId ?? 'obj-1',
      startedAt: '', parentSessionId: 'parent-1', status: 'running', ended: false, stopped: false,
      stopReason: '', endReason: '', casePath: patch.casePath ?? CASE_DIR,
      attemptId: patch.attemptId ?? 'S1-a1-x',
      allowedAttachmentIds: patch.allowedAttachmentIds ?? ['f-1'],
      resultFile: '', htmlFile: '', caseName: '', uploadedAt: '', uploadError: '', ossPrefix: '', attempt: 1,
      // ⚠️ `...patch` 必须放在**最后**：夹具要能表达"已结束 / 被停止"这些状态，
      // 否则反例会被夹具自己悄悄改成合法状态（第一次写这个用例时就是这么假绿的）。
      ...patch,
    },
  }
  state.activeKey = 'S1'
  state.activeChildId = childId
  return childId
}

/** 带 agent 的 exec：模拟**审核子会话**发起调用（`Agent.id` = 该轮的 childId）。 */
function scopedExec(name, args, signal, childId = AUDIT_CHILD) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'), name, arguments: args, signal,
    agent: { id: childId }, deferContext() {}, concludeTurn() {},
  }
}

/** 工具的 execute 需要一个 exec：这里只给信号与 agent（agent 为空 = 全局 scope）。 */
function execOf(signal) {
  return { callId: 'call-1', rootCallId: 'call-1', token: Symbol('t'), name: 'x', arguments: {}, signal, agent: undefined, deferContext() {}, concludeTurn() {} }
}

/** 包里真的随包发布了三个二进制（仓库已 `make plugin-bin`），工具要求它们存在。 */
const PKG_BIN = new URL('bin/darwin-arm64/', ROOT)
const CRWU = new URL('crwu', PKG_BIN).pathname
const DWS = new URL('dws', PKG_BIN).pathname
const OSSUTIL = new URL('ossutil', PKG_BIN).pathname

// ── 1/2：注册、schema、注销 ─────────────────────────────────────────────────

test('registerCrwuTools registers exactly the nine business tools and unregisters them on disposal', () => {
  const { deps, registry } = makeDeps()
  const dispose = registerCrwuTools(deps.ctx, deps)
  // 注册面 = `CRWU_BUSINESS_TOOLS`（含面向面板的两条氚云查询）；
  // `REQUIRED_AUDIT_TOOLS` 是**审核子会话的能力集**，比注册面小（见 consts.ts 的注释）。
  assert.deepEqual([...registry.definitions.keys()].sort(), [...CRWU_BUSINESS_TOOLS].sort())
  dispose()
  assert.deepEqual([...registry.definitions.keys()], [], '插件卸载时必须完整注销')
})

test('registerCrwuTools refuses to run without the tools service instead of silently skipping', () => {
  const { deps } = makeDeps()
  const ctx = { ...deps.ctx, get: () => undefined }
  assert.throws(() => registerCrwuTools(ctx, deps), /tools 服务不可用/)
})

test('no tool exposes a command / argv / binary / sandbox escape hatch', () => {
  const { deps, registry } = makeDeps()
  registerCrwuTools(deps.ctx, deps)
  const banned = [
    'command', 'argv', 'args', 'shell', 'binary', 'bin', 'executable', 'path', 'binDir',
    'sandbox', 'sandboxPolicy', 'sandbox_permissions', 'escalate', 'mode',
    'profile', 'bucket', 'endpoint', 'prefix', 'corpName', 'spaceId', 'workspaceId',
    'folderId', 'nodeId', 'conversationId', 'messageId', 'openDingId', 'openDingTalkId', 'userId',
  ]
  for (const definition of registry.definitions.values()) {
    const properties = definition.parameters?.properties ?? {}
    for (const name of Object.keys(properties)) {
      assert.equal(banned.includes(name), false, `${definition.name} 暴露了逃生字段：${name}`)
    }
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20, `${definition.name} 缺少可读描述`)
    assert.equal(typeof definition.output?.schema, 'object', `${definition.name} 必须声明输出 schema`)
  }
})

test('the capability tool reports platforms, tool visibility and policy facts without binary paths', async () => {
  const { deps, registry } = makeDeps()
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({ callId: 'c1', name: TOOL_NAMES.capabilities, arguments: {}, signal: new AbortController().signal })
  assert.equal(result.isError, false, result.isError ? result.error.message : '')
  assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.tools.map((item) => item.name).sort(), [...REQUIRED_AUDIT_TOOLS].sort())
  assert.equal(result.value.policy.pathSearchForAuditCli, false, '自研审核链路不做 PATH 搜索')
  assert.equal(JSON.stringify(result.value).includes('/bin/'), false, '不许返回二进制路径')
})

// ── 3/4/5：命令构造、包内路径、signal 透传 ──────────────────────────────────

test('crwu_h3yun_record_get runs the packaged crwu through ctx.shell and returns the full record', async () => {
  const record = { ObjectId: 'obj-1', F0000049: '某项目', F0000056: '资产经营', SeqNo: SEQ }
  const shell = makeShell((spec) => {
    if (spec.command.includes('records get')) return shellOk(JSON.stringify({ ok: true, data: record }))
    return null
  })
  const { deps, registry } = makeDeps({ shell })
  registerCrwuTools(deps.ctx, deps)
  const signal = new AbortController().signal
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.h3yunRecordGet,
    arguments: { objectId: 'obj-1', caseDir: CASE_DIR }, signal,
  })
  assert.equal(result.isError, false, result.isError ? result.error.message : '')
  assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.record, record, '必须一次取回全部字段')
  assert.equal(result.value.fieldCount, 4)
  // 命令必须用**包内绝对路径**，而不是裸 `crwu`（PATH 里没有它）。
  assert.equal(shell.commands.length, 1)
  assert.ok(shell.commands[0].startsWith(CRWU), `必须用包内绝对路径：${shell.commands[0]}`)
  assert.equal(shell.commands[0].includes(' crwu '), false, '不许出现裸 crwu')
  // exec.signal 必须一路透传到 shell（取消才能真的杀掉命令）。
  assert.equal(shell.requests[0].signal, signal, 'exec.signal 必须透传给 ShellExecRequest')
  // 每条业务命令都要有明确的超时预算：没有 deadline 的 dws/ossutil 会一直挂着，
  // 而模型的整轮调用是有预算的（工具必须能自己收敛）。
  assert.equal(Number.isFinite(shell.requests[0].timeoutMs) && shell.requests[0].timeoutMs > 0, true, '必须给命令设置正的超时')
  assert.equal(shell.requests[0].timeoutMs <= 10 * 60_000, true, '单个命令的超时不超过 10 分钟')
})

test('审核子会话不能查氚云记录：`record_get` / `files_list` 拒绝且零命令', async () => {
  // 这两条 Tool 的 `objectId` 是**模型提交**的，Host 无法把它绑定到本轮审核
  //（本轮那一条已经由 `crwu_audit_case_bootstrap` 取进输入快照）。
  // 所以它们的正确行为是：**调用方是进行中的审核子会话 → 直接拒绝**，而且在任何 fs / shell 之前拒绝。
  // 旧形态只校验"caseDir 落在工作空间之下"，于是子会话可以读**任意** objectId 的记录。
  for (const name of [TOOL_NAMES.h3yunRecordGet, TOOL_NAMES.h3yunFilesList]) {
    const fs = makeFs({ dirs: [CASE_DIR] })
    const shell = makeShell(() => shellOk(RECORD_JSON))
    const { deps, registry } = makeDeps({ fs, shell })
    withAuditScope(deps.state, { casePath: CASE_DIR })
    registerCrwuTools(deps.ctx, deps)
    const result = await registry.execute(scopedExec(name, { objectId: 'obj-OTHER', caseDir: CASE_DIR },
      new AbortController().signal))
    assert.equal(result.value.ok, false, `${name} 必须拒绝审核子会话`)
    assert.equal(result.value.errorKind, 'policy', `${name} 的拒绝类别`)
    assert.match(result.value.error, /审核子会话不能直接查询氚云记录/)
    assert.deepEqual(shell.commands, [], `${name} 拒绝时一个进程都不许起`)
  }

  // **刚结束**的审核子会话同样要拒绝：`ended: true` 之后 scope 不可用，
  // 但那个子会话可能还活着 —— 用"scope 是否可用"当判据会在这一刻放它去读任意 objectId
  //（2026-09-29 自审发现的漏洞，判据已改成"调用者身份"）。
  {
    const fs = makeFs({ dirs: [CASE_DIR] })
    const shell = makeShell(() => shellOk(RECORD_JSON))
    const { deps, registry } = makeDeps({ fs, shell })
    withAuditScope(deps.state, { casePath: CASE_DIR, ended: true })
    registerCrwuTools(deps.ctx, deps)
    const result = await registry.execute(scopedExec(TOOL_NAMES.h3yunRecordGet,
      { objectId: 'obj-OTHER', caseDir: CASE_DIR }, new AbortController().signal))
    assert.equal(result.value.ok, false, '已结束的审核子会话也不许查记录')
    assert.equal(result.value.errorKind, 'policy')
    assert.deepEqual(shell.commands, [], '拒绝时一个进程都不许起')
  }

  // 面板 / 宿主后台（没有 Agent 身份）照常用它：拒绝的是"审核子会话"，不是这两条 Tool 本身。
  const inside = makeFs({ dirs: [CASE_DIR] })
  const okShell = makeShell(() => shellOk(RECORD_JSON))
  const ok = makeDeps({ fs: inside, shell: okShell })
  registerCrwuTools(ok.deps.ctx, ok.deps)
  const ran = await ok.registry.execute({
    callId: 'c2', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'obj-1', caseDir: CASE_DIR },
    signal: new AbortController().signal,
  })
  assert.equal(ran.value.ok, true, String(ran.value.error))
  assert.equal(okShell.commands.length, 1)
})

test('案例内 Tool 的反例矩阵：工作空间根 / 兄弟案例 / 子目录 / 外来 fileId / 已结束 —— 全部零进程', async () => {
  // 用户复查的 P1 在 Tool 层的完整反例。判据是"**拒绝 + 一个进程都不许起**"：
  // 只断言 ok=false 会让"先起进程再拒绝"这种形态继续存在（那正是越界读写真正发生的地方）。
  const WORKSPACE = '/cases/space'
  const SIBLING = `${WORKSPACE}/S2-other`
  const built = (scopePatch = {}, fsPatch = {}) => {
    const fs = makeFs({
      dirs: [CASE_DIR, SIBLING, WORKSPACE, `${CASE_DIR}/输入快照`],
      files: { [`${CASE_DIR}/审核意见.${SEQ}.html`]: '<html>x</html>' },
      ...fsPatch,
    })
    const shell = dwsRouter([['cp -f', { ok: true }], ['ls ', '']])
    const { deps, registry } = makeDeps({ fs, shell })
    withAuditScope(deps.state, { casePath: CASE_DIR, ...scopePatch })
    registerCrwuTools(deps.ctx, deps)
    return { registry, shell, state: deps.state }
  }

  // ① 三种"不是本案例目录"的写法：oss_publish 一律 policy 拒绝且零进程
  for (const [caseDir, label] of [
    [WORKSPACE, '工作空间根本身'],
    [SIBLING, '兄弟案例'],
    [`${CASE_DIR}/输入快照`, '案例目录的子目录'],
  ]) {
    const { registry, shell } = built()
    const result = await registry.execute(scopedExec(TOOL_NAMES.ossPublish,
      { caseDir, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, new AbortController().signal))
    assert.equal(result.value.ok, false, `${label} 必须被拒绝（${result.value.errorKind}: ${result.value.error}）`)
    assert.equal(result.value.errorKind, 'policy', `${label}：${result.value.error}`)
    assert.deepEqual(shell.commands, [], `${label} 被拒时一个进程都不许起`)
  }

  // ② caseDir 是本案例、但 seqNo 是别人的：拒绝（否则能把本轮产物挂到别的流水号上）
  {
    const { registry, shell } = built()
    const result = await registry.execute(scopedExec(TOOL_NAMES.ossPublish,
      { caseDir: CASE_DIR, seqNo: 'S9-other', files: [`审核意见.${SEQ}.html`] }, new AbortController().signal))
    assert.equal(result.value.ok, false)
    assert.equal(result.value.errorKind, 'input')
    assert.deepEqual(shell.commands, [], '流水号不一致时一个进程都不许起')
  }

  // ③ file_get：不在本轮输入快照里的 fileId 必须在起进程**之前**被拒绝
  {
    const { registry, shell } = built()
    const foreign = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet,
      { fileId: 'f-OTHER', caseDir: CASE_DIR, relativePath: '材料-源/x.pdf' }, new AbortController().signal))
    assert.equal(foreign.value.ok, false)
    assert.equal(foreign.value.errorKind, 'policy')
    assert.match(foreign.value.error, /不在本轮审核的输入快照里/)
    assert.deepEqual(shell.commands, [], '外来 fileId 一个进程都不许起')
  }

  // ④ 已结束 / 未知的 childId：没有 scope，案例内 Tool 一律拒绝
  for (const [scopePatch, childId, label] of [
    [{ ended: true }, AUDIT_CHILD, '已结束的审核'],
    [{}, 'ghost-child', '未知的 childId'],
    [{ casePath: '', attemptId: '' }, AUDIT_CHILD, 'scope 不完整的认领记录'],
  ]) {
    const { registry, shell } = built(scopePatch)
    const result = await registry.execute(scopedExec(TOOL_NAMES.ossPublish,
      { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, new AbortController().signal, childId))
    assert.equal(result.value.ok, false, `${label} 必须被拒绝（${result.value.errorKind}: ${result.value.error}）`)
    assert.equal(result.value.errorKind, 'policy', `${label}：${result.value.errorKind} / ${result.value.error}`)
    assert.deepEqual(shell.commands, [], `${label} 被拒时一个进程都不许起`)
  }

  // ⑤ 正向：scope 成立且 caseDir 正确时照常上传（拒绝的是越界，不是这个调用）
  {
    const { registry, shell } = built()
    const html = '<html>x</html>'
    // 写后列举必须报**真实字节数**（工具的判据就是它），所以这里跟着内容长度走。
    const listing = `2026-09-20 10:35:52 +0800 CST  ${html.length}  Standard  d41d8cd98f00b204e9800998ecf8427e  oss://crwu-workspace/crwu/audit/${SEQ}/审核意见.${SEQ}.html\n`
    const okShell = dwsRouter([['cp -f', { ok: true }], ['ls ', listing]])
    const made = makeDeps({
      fs: makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核意见.${SEQ}.html`]: html } }),
      shell: okShell,
    })
    withAuditScope(made.deps.state, { casePath: CASE_DIR })
    registerCrwuTools(made.deps.ctx, made.deps)
    const ok = await made.registry.execute(scopedExec(TOOL_NAMES.ossPublish,
      { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, new AbortController().signal))
    assert.equal(ok.value.ok, true, String(ok.value.error))
    assert.equal(ok.value.uploaded, 1)
    assert.ok(okShell.commands.length > 0, '正向路径必须真的发命令（否则上面的"零进程"断言没有意义）')
    assert.ok(shell.commands.length === 0, '前一个替身不应被这次调用碰到')
  }
})

test('case_bootstrap 也只认本轮的 `<工作空间>/<流水号>`：工作空间根 / 兄弟案例 —— 零命令', async () => {
  // 它在创建子代理**之前**由 Host 调用，落盘的是本轮输入快照。只判"落在工作空间里"时，
  // 一个传错的 `caseDir` 会把快照写进**别的案例目录**（同一工作空间里到处都是案例）。
  for (const [caseDir, label] of [
    ['/cases/space', '工作空间根本身'],
    ['/cases/space/S2-other', '兄弟案例'],
  ]) {
    const shell = makeShell(() => shellOk(RECORD_JSON))
    const fs = makeFs({ dirs: [caseDir, '/cases/space', CASE_DIR] })
    const { deps, registry } = makeDeps({ shell, fs, state: makeState({ workspacePath: '/cases/space' }) })
    registerCrwuTools(deps.ctx, deps)
    const result = await registry.execute({
      callId: 'c1', name: TOOL_NAMES.auditCaseBootstrap,
      arguments: { objectId: 'obj-1', seqNo: SEQ, caseDir, attemptId: 'S1-a1-x', refresh: true },
      signal: new AbortController().signal,
    })
    assert.equal(result.value.ok, false, `${label} 必须被拒绝`)
    assert.equal(result.value.errorKind, 'policy', `${label}：${result.value.errorKind} / ${result.value.error}`)
    assert.match(result.value.error, /必须是本轮的/)
    assert.deepEqual(shell.commands, [], `${label} 被拒时一个命令都不许发`)
  }
})

test('case_bootstrap 也只给 Host 用：审核子会话用它取别人的记录 —— 拒绝且零命令', async () => {
  // 交接点是 Host 在**创建子代理之前**用的；子代理手里已经有快照。
  // 它的 `caseDir` 被钉在本轮案例目录，但 `objectId` 是提交进来的 ——
  // 不拦的话子代理能拿**别的** objectId 把别人的记录取进自己的案例目录。
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(RECORD_JSON) : shellOk(FILES_JSON)))
  const { deps, registry } = makeDeps({
    shell, fs: makeFs({ dirs: [CASE_DIR] }), state: makeState({ workspacePath: '/cases/space' }),
  })
  withAuditScope(deps.state, { casePath: CASE_DIR })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute(scopedExec(TOOL_NAMES.auditCaseBootstrap, {
    objectId: 'obj-OTHER', seqNo: SEQ, caseDir: CASE_DIR, attemptId: 'S1-a1-x', refresh: true,
  }, new AbortController().signal))
  assert.equal(result.value.ok, false)
  assert.equal(result.value.errorKind, 'policy')
  assert.match(result.value.error, /不要再取数/)
  assert.deepEqual(shell.commands, [], '拒绝时一个命令都不许发')
})

test('bootstrap 核对返回记录的身份：别的 objectId / 流水号不符 / 缺字段 —— 都在**落盘前**终止', async () => {
  // 用户复查 P1：`records get --id B` 之"取回一条记录"不等于"取回的是 B"。
  // 不核对的话，公开 RPC 可以用 `seqNo=A, objectId=B` 把 B 的记录与附件写进 A 的案例目录，
  // 而且这套错配还会被登记成权威 scope。
  const bootstrapArgs = { seqNo: SEQ, caseDir: CASE_DIR, attemptId: 'S1-a1-x', refresh: true }
  // 夹具里预置了包内二进制，所以"没落盘"只能按**案例目录**断言。
  const caseFiles = (fs) => [...fs.files.keys()].filter((path) => String(path).startsWith(CASE_DIR))
  const run = async (recordJson, objectId) => {
    const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(recordJson) : shellOk(FILES_JSON)))
    const fs = makeFs({ dirs: [CASE_DIR] })
    const { deps, registry } = makeDeps({ shell, fs, state: makeState({ workspacePath: '/cases/space' }) })
    registerCrwuTools(deps.ctx, deps)
    const result = await registry.execute({
      callId: 'c1', name: TOOL_NAMES.auditCaseBootstrap,
      arguments: { ...bootstrapArgs, objectId }, signal: new AbortController().signal,
    })
    return { result, fs, shell }
  }

  // ① 返回的是**别的**记录（ObjectId 不一致）
  const foreign = await run(JSON.stringify({ data: { ObjectId: 'obj-OTHER', SeqNo: SEQ } }), 'obj-1')
  assert.equal(foreign.result.value.ok, false)
  assert.equal(foreign.result.value.errorKind, 'input')
  assert.match(foreign.result.value.error, /不是请求的那一条/)
  assert.equal(foreign.shell.commands.some((c) => c.includes('files list')), false, '身份不对就不许再去取附件')
  assert.deepEqual(caseFiles(foreign.fs), [], '案例目录下一个字节都不许落盘')

  // ② 流水号不一致（同一个 objectId，但记录属于另一个流水号）
  const wrongSeq = await run(JSON.stringify({ data: { ObjectId: 'obj-1', SeqNo: 'S9-other' } }), 'obj-1')
  assert.equal(wrongSeq.result.value.ok, false)
  assert.equal(wrongSeq.result.value.errorKind, 'input')
  assert.match(wrongSeq.result.value.error, /流水号与请求的不一致/)
  assert.deepEqual(caseFiles(wrongSeq.fs), [], '案例目录下一个字节都不许落盘')

  // ③ 记录**缺**身份字段 → fail closed（不许拿调用方提交的值兜底）
  for (const missing of [
    { data: { F0000049: '某项目' } },
    { data: { SeqNo: SEQ, F0000049: '某项目' } },
    { data: { ObjectId: 'obj-1', F0000049: '某项目' } },
  ]) {
    const gap = await run(JSON.stringify(missing), 'obj-1')
    assert.equal(gap.result.value.ok, false, JSON.stringify(missing))
    assert.equal(gap.result.value.errorKind, 'cli')
    assert.match(gap.result.value.error, /缺少 ObjectId \/ SeqNo/)
    assert.deepEqual(caseFiles(gap.fs), [], '缺字段时案例目录下一个字节都不许落盘')
  }
})

test('工具集不变量：子会话必需集与 deny 集**不相交**（否则真实 toolFilter 会误杀正常子会话）', () => {
  // 用户第三轮复查的 P1：`crwu_audit_case_bootstrap` 曾是"根必需 + 子会话 deny"，
  // 而子会话复查用的是根必需集 —— 真实过滤生效后每条正常子会话都会被判成缺工具并停掉。
  const overlap = REQUIRED_AUDIT_CHILD_TOOLS.filter((name) => AUDIT_CHILD_DENIED_TOOLS.includes(name))
  assert.deepEqual(overlap, [], '子会话必需集里不许出现被 deny 的工具')
  // 根必需集**可以**与 deny 集相交（bootstrap 就是 Host 专用），这正是两个集合必须分开的原因。
  assert.equal(REQUIRED_AUDIT_TOOLS.includes('crwu_audit_case_bootstrap'), true, 'bootstrap 仍是根必需')
  assert.equal(REQUIRED_AUDIT_CHILD_TOOLS.includes('crwu_audit_case_bootstrap'), false, '但它不是子会话必需')
  assert.deepEqual(REQUIRED_AUDIT_CHILD_TOOLS, REQUIRED_AUDIT_TOOLS.filter((n) => !AUDIT_CHILD_DENIED_TOOLS.includes(n)))
})

test('真实 toolFilter 生效时（denied 工具对子会话不可见）子会话仍然齐备；根必需集则会误报', () => {
  // 用户要求的最小夹具：`tools.get(name, agent)` 对三条 denied 工具返回 undefined，其余可见。
  const childAgent = { id: 'child-1' }
  const visible = (name, agent) => {
    if (agent !== childAgent) return { name }
    return AUDIT_CHILD_DENIED_TOOLS.includes(name) ? undefined : { name }
  }
  const ctx = { get: (n) => (n === 'tools' ? { get: visible } : undefined) }

  assert.deepEqual(missingAuditTools(ctx, childAgent, REQUIRED_AUDIT_CHILD_TOOLS), [],
    '真实过滤生效后，子会话必需集必须齐备（否则正常子会话刚创建就被停掉）')
  // 反向：拿根必需集去查子会话 → bootstrap 会被算成缺失（这正是被修掉的 bug 形态）。
  assert.deepEqual(missingAuditTools(ctx, childAgent, REQUIRED_AUDIT_TOOLS), ['crwu_audit_case_bootstrap'])
  // 根会话不受影响：三条 denied 对根都可见。
  assert.deepEqual(missingAuditTools(ctx, { id: 'root-1' }, REQUIRED_AUDIT_TOOLS), [])
})

test('crwu_h3yun_files_list returns metadata only and never a download URL', async () => {
  const shell = makeShell((spec) => spec.command.includes('files list')
    ? shellOk(JSON.stringify({ ok: true, data: [
        { field: 'F1', fileId: 'f-1', fileName: '估值报告.pdf', fileSize: '123', contentType: 'pdf', downloadUrl: 'https://www.h3yun.com/Form/Download/?AttachmentID=f-1' },
      ] }))
    : null)
  const { deps, registry } = makeDeps({ shell })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunFilesList, arguments: { objectId: 'obj-1' }, signal: new AbortController().signal })
  assert.equal(result.value.ok, true)
  assert.equal(result.value.count, 1)
  assert.deepEqual(Object.keys(result.value.files[0]).sort(), ['contentType', 'field', 'fileId', 'fileName', 'fileSize'])
  assert.equal(JSON.stringify(result.value).includes('h3yun.com'), false, '不许把带会话鉴权的下载 URL 带回模型')
})

test('crwu_h3yun_file_get downloads one attachment inside the case directory and rejects escapes', async () => {
  const shell = makeShell((spec) => {
    const out = /--out '?([^'\s]+)'?/.exec(spec.command)
    if (spec.command.includes('file get') && out !== null) {
      shellFs.addFile(out[1], 'PDF')
      return shellOk(JSON.stringify({ ok: true, data: { file: out[1] } }))
    }
    return null
  })
  const shellFs = makeFs({ dirs: [CASE_DIR, `${CASE_DIR}/材料-源`] })
  const { deps, registry } = makeDeps({ fs: shellFs, shell })
  withAuditScope(deps.state, { casePath: CASE_DIR, allowedAttachmentIds: ['f-1'] })
  registerCrwuTools(deps.ctx, deps)

  const ok = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet,
    { fileId: 'f-1', caseDir: CASE_DIR, relativePath: '材料-源/估值报告.pdf' },
    new AbortController().signal))
  assert.equal(ok.value.ok, true)
  assert.equal(ok.value.path, `${CASE_DIR}/材料-源/估值报告.pdf`)
  assert.equal(ok.value.sizeBytes, 3)
  assert.ok(shell.commands[0].startsWith(CRWU))

  const escape = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet,
    { fileId: 'f-1', caseDir: CASE_DIR, relativePath: '../outside.pdf' },
    new AbortController().signal))
  assert.equal(escape.value.ok, false)
  assert.equal(escape.value.errorKind, 'input', '越界路径必须在执行前被拒绝')
  assert.equal(shell.commands.length, 1, '被拒绝的请求不许发出任何命令')
})

test('两个同名附件不许互相覆盖：目标名必须带上这件附件自己的 fileId 标识', async () => {
  // 真实现场：一份报告里挂着两个 `广兴建筑v3.zip`（fileId 不同）。按文件名落盘时第二件会
  // **静默覆盖**第一件，审核只看到一份材料 —— 既可能漏检，也答不了"重复上传还是两个版本"。
  const FIRST = 'c8ef13b8-1111-2222-3333-444455556666'
  const SECOND = 'e17ec3db-aaaa-bbbb-cccc-ddddeeeeffff'
  const shell = makeShell((spec) => {
    const out = /--out '?([^'\s]+)'?/.exec(spec.command)
    if (spec.command.includes('file get') && out !== null) {
      shellFs.addFile(out[1], 'ZIP')
      return shellOk(JSON.stringify({ ok: true, data: { file: out[1] } }))
    }
    return null
  })
  const shellFs = makeFs({ dirs: [CASE_DIR, `${CASE_DIR}/材料-源`] })
  const { deps, registry } = makeDeps({ fs: shellFs, shell })
  withAuditScope(deps.state, { casePath: CASE_DIR, allowedAttachmentIds: [FIRST, SECOND] })
  registerCrwuTools(deps.ctx, deps)

  // ① 不带标识 → 在任何进程之前拒绝，并给出正确的名字。
  const bare = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet,
    { fileId: FIRST, caseDir: CASE_DIR, relativePath: '材料-源/广兴建筑v3.zip' },
    new AbortController().signal))
  assert.equal(bare.value.ok, false)
  assert.equal(bare.value.errorKind, 'policy')
  assert.match(String(bare.value.error), /__c8ef13b8/)
  assert.deepEqual(shell.commands, [], '被拒绝的请求不许发出任何命令')

  // ② 各带各的标识 → 两件都落盘，谁也不覆盖谁。
  for (const [fileId, name] of [[FIRST, '广兴建筑v3__c8ef13b8.zip'], [SECOND, '广兴建筑v3__e17ec3db.zip']]) {
    const done = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet,
      { fileId, caseDir: CASE_DIR, relativePath: `材料-源/${name}` },
      new AbortController().signal))
    assert.equal(done.value.ok, true, String(done.value.error))
    assert.equal(done.value.path, `${CASE_DIR}/材料-源/${name}`)
  }
  assert.equal(shellFs.files.has(`${CASE_DIR}/材料-源/广兴建筑v3__c8ef13b8.zip`), true)
  assert.equal(shellFs.files.has(`${CASE_DIR}/材料-源/广兴建筑v3__e17ec3db.zip`), true,
    '第二件必须落在自己的名字上，而不是覆盖第一件')
})

// ── 讨论会话的受限材料范围（协议 23） ───────────────────────────────────────

/**
 * 登记一条**报告讨论会话**的材料范围（同 `discussion-material-open` 的效果）。
 *
 * 讨论不是审核：它没有审核记录，`objectId` 由 Host 在登记时自己取一次数，
 * 白名单就是那一刻远端有的那批 `fileId`。
 */
function withDiscussionScope(scopes, patch = {}) {
  return scopes.register({
    sessionId: patch.sessionId ?? DISCUSSION_SESSION,
    seqNo: SEQ,
    objectId: 'obj-1',
    caseDir: CASE_DIR,
    allowedAttachmentIds: patch.allowedAttachmentIds ?? ['f-1'],
    ...patch,
  })
}

const DISCUSSION_SESSION = 'session-discussion-1'

test('已登记的讨论会话可以下载白名单附件（这是"讨论会话取不到材料"的修复）', async () => {
  const NAME = '广兴建筑v3__c8ef13b8.zip'
  const FILE_ID = 'c8ef13b8-1111-2222-3333-444455556666'
  const shell = makeShell((spec) => {
    const out = /--out '?([^'\s]+)'?/.exec(spec.command)
    if (spec.command.includes('file get') && out !== null) {
      shellFs.addFile(out[1], 'ZIP')
      return shellOk(JSON.stringify({ ok: true, data: { file: out[1] } }))
    }
    return null
  })
  const shellFs = makeFs({ dirs: [CASE_DIR, `${CASE_DIR}/材料-源`] })
  const scopes = createDiscussionScopeRegistry()
  const { deps, registry } = makeDeps({ fs: shellFs, shell, discussionScopes: scopes })
  withDiscussionScope(scopes, { allowedAttachmentIds: [FILE_ID] })
  registerCrwuTools(deps.ctx, deps)

  const done = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet,
    { fileId: FILE_ID, caseDir: CASE_DIR, relativePath: `材料-源/${NAME}` },
    new AbortController().signal, DISCUSSION_SESSION))
  assert.equal(done.value.ok, true, String(done.value.error))
  assert.equal(done.value.path, `${CASE_DIR}/材料-源/${NAME}`)
  assert.equal(shellFs.files.has(`${CASE_DIR}/材料-源/${NAME}`), true)
})

test('讨论会话：清单外的 fileId、别人的案例目录、未登记的会话一律拒绝且零命令', async () => {
  const shell = makeShell(() => shellOk(JSON.stringify({ ok: true })))
  const shellFs = makeFs({ dirs: [CASE_DIR] })
  const scopes = createDiscussionScopeRegistry()
  const { deps, registry } = makeDeps({ fs: shellFs, shell, discussionScopes: scopes })
  withDiscussionScope(scopes, { allowedAttachmentIds: ['f-1'] })
  registerCrwuTools(deps.ctx, deps)

  const cases = [
    ['清单外的 fileId', { fileId: 'f-2', caseDir: CASE_DIR, relativePath: '材料-源/a.pdf' }, DISCUSSION_SESSION, 'policy'],
    ['别人的案例目录', { fileId: 'f-1', caseDir: `${CASE_DIR}/别的`, relativePath: '材料-源/a.pdf' }, DISCUSSION_SESSION, 'policy'],
    ['工作空间根当案例目录', { fileId: 'f-1', caseDir: '/cases/space', relativePath: '材料-源/a.pdf' }, DISCUSSION_SESSION, 'policy'],
    ['没登记过的会话', { fileId: 'f-1', caseDir: CASE_DIR, relativePath: '材料-源/a.pdf' }, 'session-plain-1', 'policy'],
  ]
  for (const [label, args, sessionId, kind] of cases) {
    const result = await registry.execute(scopedExec(TOOL_NAMES.h3yunFileGet, args, new AbortController().signal, sessionId))
    assert.equal(result.value.ok, false, label)
    assert.equal(result.value.errorKind, kind, label)
  }
  assert.deepEqual(shell.commands, [], '被拒绝的请求一个进程都不许起')
})

test('讨论会话不能查记录、也不能列举附件（它不是氚云查询入口）', async () => {
  const shell = makeShell(() => shellOk(JSON.stringify({ ok: true, data: [] })))
  const scopes = createDiscussionScopeRegistry()
  const { deps, registry } = makeDeps({ shell, discussionScopes: scopes })
  withDiscussionScope(scopes)
  registerCrwuTools(deps.ctx, deps)

  for (const name of [TOOL_NAMES.h3yunRecordGet, TOOL_NAMES.h3yunFilesList]) {
    const result = await registry.execute(scopedExec(name, { objectId: 'obj-1', caseDir: CASE_DIR },
      new AbortController().signal, DISCUSSION_SESSION))
    assert.equal(result.value.ok, false, name)
    assert.equal(result.value.errorKind, 'policy', name)
    assert.match(String(result.value.error), /报告讨论会话/, name)
  }
  assert.deepEqual(shell.commands, [], '拒绝要在任何 fs / shell 之前发生')
})

// ── 讨论会话材料登记（`discussion-material-open`，协议 23） ──────────────────

/**
 * 给 ctx 补一个 `sessions` 替身（登记要判"这条会话是不是子代理"）。
 *
 * `makeCtx` 的 `get` 只认识 fs / shell / tools，所以这里就地包一层 ——
 * 与真实装配一致：`sessions.get(id)?.header` 是那条判据的唯一来源。
 */
function withSessions(ctx, headers) {
  const inner = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'sessions') return { get: (id) => (headers[id] === undefined ? undefined : { header: headers[id] }) }
    return inner(name)
  }
  return ctx
}

test('discussion-material-open：Host 自己取一次数，只把这一批 fileId 写进白名单', async () => {
  const shell = makeShell((spec) => {
    if (spec.command.includes('records get')) return shellOk(RECORD_JSON)
    if (spec.command.includes('files list')) return shellOk(FILES_JSON)
    return shellOk('{}')
  })
  const fs = makeFs({ dirs: ['/cases/space', CASE_DIR] })
  const scopes = createDiscussionScopeRegistry()
  const { deps } = makeDeps({ shell, fs, form: makeForm({ code: 'FORM-1' }), state: makeState({ workspacePath: '/cases/space' }), discussionScopes: scopes })
  withSessions(deps.ctx, { 'sess-1': { origin: '', delegationDepth: 0 } })

  const view = await openDiscussionMaterial({ ...deps, scopes, world: deps.world }, {
    sessionId: 'sess-1', seqNo: SEQ, objectId: 'obj-1',
  })
  assert.equal(view.ok, true, view.error)
  assert.equal(view.caseDir, CASE_DIR, '案例目录由 Host 算，不由调用方提交')
  assert.equal(view.attachmentCount, 1)
  assert.equal(view.attachments[0].fileId, 'f1')
  assert.equal(view.attachments[0].localName, '报告.zip')
  assert.equal(view.expiresAt > Date.now(), true)
  // 白名单真的落进了注册表（Tool 那一侧读的就是它）。
  assert.deepEqual([...scopes.use('sess-1').allowedAttachmentIds], ['f1'])
  assert.equal(scopes.use('sess-1').caseDir, CASE_DIR)
  // 同一 attempt 只取一次数：records get 与 files list 各一条。
  assert.equal(shell.commands.filter((command) => command.includes('records get')).length, 1)
  assert.equal(shell.commands.filter((command) => command.includes('files list')).length, 1)
})

test('discussion-material-open：子代理会话被拒绝（讨论是顶层会话），零命令', async () => {
  const shell = makeShell(() => shellOk('{}'))
  const fs = makeFs({ dirs: ['/cases/space', CASE_DIR] })
  const scopes = createDiscussionScopeRegistry()
  const { deps } = makeDeps({ shell, fs, state: makeState({ workspacePath: '/cases/space' }), discussionScopes: scopes })
  withSessions(deps.ctx, { 'sess-1': { origin: 'subagent', delegationDepth: 1 } })

  const view = await openDiscussionMaterial({ ...deps, scopes, world: deps.world }, {
    sessionId: 'sess-1', seqNo: SEQ, objectId: 'obj-1',
  })
  assert.equal(view.ok, false)
  assert.equal(view.errorKind, 'policy')
  assert.match(view.error, /子代理/)
  assert.deepEqual(shell.commands, [], '身份不对就不许起任何进程')
  assert.equal(scopes.size(), 0)
})

test('discussion-material-open：对象与流水号对不上就拒绝，而且**不再去取附件**', async () => {
  const otherRecord = JSON.stringify({ data: { ObjectId: 'obj-1', SeqNo: '另一个流水号' } })
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(otherRecord) : shellOk(FILES_JSON)))
  const fs = makeFs({ dirs: ['/cases/space', CASE_DIR] })
  const scopes = createDiscussionScopeRegistry()
  const { deps } = makeDeps({ shell, fs, form: makeForm({ code: 'FORM-1' }), state: makeState({ workspacePath: '/cases/space' }), discussionScopes: scopes })
  withSessions(deps.ctx, { 'sess-1': { origin: '', delegationDepth: 0 } })

  const view = await openDiscussionMaterial({ ...deps, scopes, world: deps.world }, {
    sessionId: 'sess-1', seqNo: SEQ, objectId: 'obj-1',
  })
  assert.equal(view.ok, false)
  assert.equal(view.errorKind, 'input')
  assert.match(view.error, /流水号/)
  assert.equal(shell.commands.filter((command) => command.includes('files list')).length, 0,
    '身份没核对通过就不该去取附件（否则会把别人的清单登记成这条报告的）')
  assert.equal(scopes.size(), 0, '失败不登记')
})

test('discussion-material-open：没有工作空间 / 参数不合法时拒绝，且不登记', async () => {
  const shell = makeShell(() => shellOk('{}'))
  const scopes = createDiscussionScopeRegistry()
  const { deps } = makeDeps({ shell, fs: makeFs({ dirs: [CASE_DIR] }), state: makeState({ workspacePath: '' }), discussionScopes: scopes })
  withSessions(deps.ctx, { 'sess-1': { origin: '', delegationDepth: 0 } })

  for (const [label, args] of [
    ['没有工作空间', { sessionId: 'sess-1', seqNo: SEQ, objectId: 'obj-1' }],
    ['缺 sessionId', { seqNo: SEQ, objectId: 'obj-1' }],
    ['流水号形状不合法', { sessionId: 'sess-1', seqNo: '../../etc', objectId: 'obj-1' }],
    ['缺 objectId', { sessionId: 'sess-1', seqNo: SEQ }],
  ]) {
    const view = await openDiscussionMaterial({ ...deps, scopes, world: deps.world }, args)
    assert.equal(view.ok, false, label)
    assert.equal(view.errorKind, 'input', label)
  }
  assert.equal(scopes.size(), 0)
})

test('氚云三条 Tool 的授权矩阵（协议 23）：三种调用者 × 三个工具，逐格钉住', async () => {
  // 这张矩阵是**刻意**的，不是现状的副产品：
  // - `file_get` 是"取材料"的入口 → 只有**审核子会话**与**已登记的讨论会话**能进来；
  //   普通顶层会话一律拒绝（这正是"普通 DeepSeek 对话不是材料入口"的落点）。
  // - `record_get` / `files_list` 是**按 objectId 的查询能力**，`crwu-h3yun-query` 技能
  //   （自动触发的那种"查一下这个报告"）依赖它在**普通会话**里可用，所以那里**保持既有规则**
  //   （不变宽、也不变窄）；但**已登记的讨论会话**不许用它们 —— 讨论拿到的是"登记那一刻的
  //   那批附件"，让它顺手查记录就把一次受限授权变成了通用读能力。
  const record = JSON.stringify({ data: { ObjectId: 'obj-1', SeqNo: SEQ, F1: 'x' } })
  const files = JSON.stringify({ data: [{ field: 'F1', fileId: 'f-1', fileName: 'a.pdf', fileSize: '3', contentType: 'application/pdf' }] })
  const shell = makeShell((spec) => {
    if (spec.command.includes('records get')) return shellOk(record)
    if (spec.command.includes('files list')) return shellOk(files)
    const out = /--out '?([^'\s]+)'?/.exec(spec.command)
    if (spec.command.includes('file get') && out !== null) {
      shellFs.addFile(out[1], 'PDF')
      return shellOk(JSON.stringify({ ok: true }))
    }
    return null
  })
  const shellFs = makeFs({ dirs: [CASE_DIR, `${CASE_DIR}/材料-源`] })
  const scopes = createDiscussionScopeRegistry()
  const { deps, registry } = makeDeps({ fs: shellFs, shell, discussionScopes: scopes })
  // ① 审核子会话：记录里的白名单 ['f-1']
  withAuditScope(deps.state, { childId: AUDIT_CHILD, casePath: CASE_DIR, allowedAttachmentIds: ['f-1'] })
  // ② 已登记的讨论会话
  withDiscussionScope(scopes, { sessionId: DISCUSSION_SESSION, allowedAttachmentIds: ['f-1'] })
  registerCrwuTools(deps.ctx, deps)

  const PLAIN = 'session-plain-1'
  const call = (name, args, sessionId) => registry.execute(scopedExec(name, args, new AbortController().signal, sessionId))
  const FILE_IN = { fileId: 'f-1', caseDir: CASE_DIR, relativePath: '材料-源/a.pdf' }
  const FILE_OUT = { fileId: 'f-9', caseDir: CASE_DIR, relativePath: '材料-源/a.pdf' }
  const QUERY = { objectId: 'obj-1', caseDir: CASE_DIR }

  // 允许的三格（命令真的跑起来了）。
  for (const [label, name, args, sessionId] of [
    ['审核子会话 · file_get（白名单内）', TOOL_NAMES.h3yunFileGet, FILE_IN, AUDIT_CHILD],
    ['讨论会话 · file_get（白名单内）', TOOL_NAMES.h3yunFileGet, FILE_IN, DISCUSSION_SESSION],
    ['普通会话 · record_get（既有规则：可用）', TOOL_NAMES.h3yunRecordGet, QUERY, PLAIN],
    ['普通会话 · files_list（既有规则：可用）', TOOL_NAMES.h3yunFilesList, QUERY, PLAIN],
  ]) {
    const before = shell.commands.length
    const result = await call(name, args, sessionId)
    assert.equal(result.value.ok, true, `${label}：${String(result.value.error)}`)
    assert.equal(shell.commands.length > before, true, `${label} 应当真的执行`)
  }

  // 拒绝的七格（一个进程都不许起）。
  for (const [label, name, args, sessionId] of [
    ['审核子会话 · file_get（清单外）', TOOL_NAMES.h3yunFileGet, FILE_OUT, AUDIT_CHILD],
    ['审核子会话 · record_get', TOOL_NAMES.h3yunRecordGet, QUERY, AUDIT_CHILD],
    ['审核子会话 · files_list', TOOL_NAMES.h3yunFilesList, QUERY, AUDIT_CHILD],
    ['讨论会话 · file_get（清单外）', TOOL_NAMES.h3yunFileGet, FILE_OUT, DISCUSSION_SESSION],
    ['讨论会话 · record_get', TOOL_NAMES.h3yunRecordGet, QUERY, DISCUSSION_SESSION],
    ['讨论会话 · files_list', TOOL_NAMES.h3yunFilesList, QUERY, DISCUSSION_SESSION],
    ['普通会话 · file_get（不是材料入口）', TOOL_NAMES.h3yunFileGet, FILE_IN, PLAIN],
  ]) {
    const before = shell.commands.length
    const result = await call(name, args, sessionId)
    assert.equal(result.value.ok, false, label)
    assert.equal(result.value.errorKind, 'policy', label)
    assert.equal(shell.commands.length, before, `${label}：拒绝时必须零命令`)
  }
})

// ── 案例内非特权命令的**会话作用域**（2026-09-30 真机回归） ──────────────────

test('回归：输入快照目录必须带**调用方会话的策略**（真机 Operation not permitted）', async () => {
  // 真机原文（连挂两次）：`创建快照目录失败：mkdir: <案例目录>/输入快照: Operation not permitted`
  //（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write ·
  //  沙箱拒绝=是）—— 而案例目录恰恰就是审核根会话的 cwd。
  // 根因：DSH 的执行器**不持有会话**，请求不带 `sandboxPolicy` 就用部署默认（进程 cwd）。
  // 所以这条用例的替身会**真的按策略拦人**（缺策略 → 部署默认 → 拒）。
  const DEFAULT_ROOT = '/work/plugin-default'
  const fs = makeFs({ dirs: [CASE_DIR] })
  // ⚠️ fs 也要用"会按策略拦写"的替身：真实现是
  // `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()` —— 不传策略就落到部署默认，
  // 于是三个快照 JSON 写不进去（`FS_SANDBOX_DENIED`），审核停在「未创建子代理」。
  // 用"永远成功"的 fs 替身时，这一类缺陷在单测里**完全看不见**（2026-09-30 就是这么漏过去的）。
  const sandboxedFs = makeSandboxedFs({ fs, defaultRoot: DEFAULT_ROOT })
  const shell = makeSandboxedShell({
    fs, defaultRoot: DEFAULT_ROOT,
    routes: [['records get', RECORD_JSON], ['files list', FILES_JSON]],
  })
  const policy = makeSessionPolicyService({ defaultRoot: DEFAULT_ROOT, roots: () => CASE_DIR })
  const registry = makeRegistry()
  const ctx = makeCtx({ fs: sandboxedFs.service, shell: shell.service, tools: registry, sandboxPolicy: policy.service })
  const state = makeState({ workspacePath: '/cases/space' })
  const scopes = createDiscussionScopeRegistry()
  const { access } = makeTestAccess(ctx, { state })
  const deps = {
    ctx,
    config: { ...CONFIG },
    state,
    access,
    form: makeForm({ code: 'FORM-1' }).resolver,
    discussionScopes: scopes,
    world: {
      platform: async () => 'darwin-arm64',
      home: async () => '/Users/x',
      workdir: async () => '/cases/session',
      cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
    },
  }
  registerCrwuTools(ctx, deps)
  const args = { objectId: 'obj-1', seqNo: SEQ, caseDir: CASE_DIR, refresh: true }

  // ③ **不带**会话（= 真机那两次的形态）→ 复现真机那句话。
  //    先跑这一支：目录还不存在，"命令失败但目标已经是目录"的幂等退路救不了它。
  const orphan = await registry.execute({
    callId: 'c-orphan', name: TOOL_NAMES.auditCaseBootstrap,
    arguments: { ...args, attemptId: 'S1-a1-orphan' }, signal: new AbortController().signal,
    agent: { id: 'parent-1' },
  })
  assert.equal(orphan.value.ok, false)
  assert.match(String(orphan.value.error), /创建快照目录失败/)
  assert.match(String(orphan.value.error), /system\.case-file\.write/)
  assert.match(String(orphan.value.error), /沙箱拒绝=是/)
  assert.match(String(orphan.value.error), /插件 pkg-/, '失败文案要带上插件版本（真机排障第一件事）')
  assert.equal(fs.dirs.has(`${CASE_DIR}/输入快照`), false, '这一支一个目录都不该建出来')
  assert.equal(shell.deniedCommands.length, 1, '这一支必须真的被沙箱拦下（否则用例是假的）')

  // ④ **带**会话（生产形态：Host 用审核根 Agent 调它）→ 快照三个 JSON 落盘。
  const rootSession = { id: 'session-audit-root' }
  const scoped = await registry.execute({
    callId: 'c-scope', name: TOOL_NAMES.auditCaseBootstrap,
    arguments: { ...args, attemptId: 'S1-a1-scope' }, signal: new AbortController().signal,
    agent: { id: 'parent-1', session: rootSession },
  })
  assert.equal(scoped.value.ok, true, String(scoped.value.error))
  assert.equal(fs.dirs.has(`${CASE_DIR}/输入快照`), true, '快照目录真的建出来了')
  assert.equal(fs.files.has(`${CASE_DIR}/输入快照/附件清单.json`), true)
  assert.equal(fs.files.has(`${CASE_DIR}/输入快照/报告记录.json`), true)
  assert.equal(fs.files.has(`${CASE_DIR}/输入快照/快照元数据.json`), true)
  assert.deepEqual(sandboxedFs.deniedWrites, [], '带会话这一支不许有任何写入被沙箱拒')
  const write = sandboxedFs.writes.find((item) => item.target.endsWith('附件清单.json'))
  assert.equal(write.policy.workspaceRoot, CASE_DIR, '写入必须带上调用方会话解析出来的边界')
  assert.equal(shell.deniedCommands.length, 1, '带会话这一支不许再被拦')
  // 请求里必须**逐次声明**调用方会话的边界；提权命令（氚云取数）仍然是 danger-full-access。
  const mkdir = shell.requests.filter((request) => String(request.command).startsWith('mkdir')).at(-1)
  assert.equal(mkdir.sandboxPolicy.workspaceRoot, CASE_DIR, '非特权命令的边界 = 调用方会话解析出的案例目录')
  assert.equal(mkdir.sandboxPolicy.mode, 'workspace-write', '非特权命令不提权')
  const fetch = shell.requests.filter((request) => String(request.command).includes('records get')).at(-1)
  assert.equal(fetch.sandboxPolicy.mode, 'danger-full-access', '氚云取数是特权操作，逐次声明提权')
})

// ── 4：默认沙箱与提权白名单 ─────────────────────────────────────────────────

test('B-04 未授权：审核 Tool 连命令都不发（不是"发了但没提权"）', async () => {
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(JSON.stringify({ ok: true, data: { ObjectId: 'o' } })) : null))
  const { deps, registry } = makeDeps({ shell, state: makeState({ localAccess: missingConsent() }) })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'o', caseDir: CASE_DIR }, signal: new AbortController().signal })
  // 旧形态是"发一条不提权的命令、然后拿到假的未登录"；协议 18 起是**一个进程都不起**。
  assert.deepEqual(shell.requests, [], '未授权时不许发任何命令')
  assert.equal(result.value.ok, false)
  assert.match(String(result.value.error), /允许工作台访问本机账号和配置/)
})

test('a whitelisted credential command escalates only when authorized and the workspace is known', async () => {
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(JSON.stringify({ ok: true, data: { ObjectId: 'o' } })) : null))
  const trusted = makeDeps({ shell, state: makeState({ localAccess: grantedConsent() }) })
  registerCrwuTools(trusted.deps.ctx, trusted.deps)
  await trusted.registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'o', caseDir: CASE_DIR }, signal: new AbortController().signal })
  assert.deepEqual(shell.requests[0].sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: CASE_DIR }, '白名单 + 已授权 + 工作区已知 → 提权')

  // 工作区未知（caseDir 省略、会话根也取不到）时 **fail closed**：不提权、也不发命令。
  // 旧口径是"退回沙箱执行"，但那正是最坏的一种：受限沙箱下读钥匙串会回一个**假的**
  // 「未登录 / secret not found」，员工照着去重新扫码，而真正的问题是拿不到工作目录。
  const noWorkspace = makeDeps({ shell: makeShell((spec) => (spec.command.includes('records get') ? shellOk('{"ok":true,"data":{}}') : null)), state: makeState({ localAccess: grantedConsent() }) })
  noWorkspace.deps.world.workdir = async () => ''
  registerCrwuTools(noWorkspace.deps.ctx, noWorkspace.deps)
  const result = await noWorkspace.registry.execute({ callId: 'c2', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'o' }, signal: new AbortController().signal })
  assert.deepEqual(noWorkspace.shell.requests, [], '拿不到工作区就不发命令')
  assert.match(String(result.value.error), /工作目录/)
})

test('B-08：dws 命令白名单拒绝表外子命令，且每条都要映射到本机访问操作', () => {
  for (const argv of [
    ['wiki', '+node-list'],
    ['doc', '+export'],
    ['drive', '+upload'],
    ['contact', 'user', 'get-self'],
    ['ding', 'message', 'send-by-message'],
    ['wiki', 'space', 'list'],
  ]) {
    assert.equal(assertDwsCommand(argv).ok, true, `应当放行：${argv.join(' ')}`)
  }
  for (const argv of [
    ['api', 'call'],
    ['doc', '+update'],
    ['drive', '+delete'],
    ['wiki', '+node-create'],
    ['ding', 'message', 'send'],
    ['chat', '+messages-send-sms'],
    [],
  ]) {
    assert.equal(assertDwsCommand(argv).ok, false, `必须拒绝：${argv.join(' ')}`)
  }
  // 协议 18：提权不再由 `escalationAllowed` 决定，而是由「命令 → 操作」的固定映射决定。
  // 白名单外 → 映射不出来 → 拒绝；白名单里但还没登记操作的 → 同样拒约（默认拒绝）。
  assert.equal(dwsOperationOf(['api', 'call']), null, '白名单外的命令没有操作身份')
  assert.equal(dwsOperationOf(['chat', '+messages-send']), 'dws.message.write')
  assert.equal(dwsOperationOf(['drive', '+upload']), 'dws.drive.write')
  assert.equal(dwsOperationOf(['drive', '+list']), 'dws.drive.read')
  assert.equal(dwsOperationOf(['wiki', '+node-list']), 'dws.knowledge.read')
  assert.equal(dwsOperationOf(['auth', 'login']), 'dws.auth.login')
  // 白名单与操作表必须**逐条对齐**：白名单里有、操作表里没有的，一个都不许留。
  for (const prefix of DWS_ALLOWED_PREFIXES) {
    assert.notEqual(dwsOperationOf([...prefix]), null, `白名单前缀没有登记操作：${prefix.join(' ')}`)
  }
})

test('runDws never falls back to a bare command name on a supported platform', async () => {
  const fs = makeFs({ dirs: [CASE_DIR] })
  const shell = makeShell(() => shellOk('{}'))
  const { deps } = makeDeps({ fs, shell })
  const aborted = new AbortController().signal
  // 平台不受支持（例如 linux-x64）→ capability gap，而不是回退裸 `dws`。
  const unsupported = await runDws(deps.ctx, 'linux-x64', ['wiki', '+space-list'], {
    workdir: CASE_DIR, trusted: true, credentialOperation: true, signal: aborted,
  })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.errorKind, 'capability-gap')
  assert.equal(shell.commands.length, 0, '定位不到包内二进制时一条命令都不许发')
})

// ── 5：能力门禁 ─────────────────────────────────────────────────────────────

test('missingAuditTools reports every tool the agent scope cannot see', () => {
  const { deps } = makeDeps({ tools: makeRegistry({ hidden: ['crwu_audit_oss_publish'] }) })
  registerCrwuTools(deps.ctx, deps)
  assert.deepEqual(missingAuditTools(deps.ctx, { id: 'agent-1' }), ['crwu_audit_oss_publish'])
  assert.deepEqual(missingAuditTools(deps.ctx, undefined), [], '全局视图下八个工具都在')
})

test('capabilityPreflight fails closed when a tool is invisible, and when the tool reports a gap', async () => {
  const missing = makeDeps({ tools: makeRegistry({ hidden: ['crwu_audit_dingtalk_archive'] }) })
  registerCrwuTools(missing.deps.ctx, missing.deps)
  const invisible = await capabilityPreflight(missing.deps.ctx, { id: 'agent-1' })
  assert.equal(invisible.ok, false)
  assert.match(invisible.error, /crwu_audit_dingtalk_archive/)

  // 工具自己报 capability gap（例如包内二进制缺失）时，预检也必须失败。
  const gapped = makeRegistry()
  const gapDeps = makeDeps({ tools: gapped })
  registerCrwuTools(gapDeps.deps.ctx, gapDeps.deps)
  const definition = gapped.definitions.get(TOOL_NAMES.capabilities)
  gapped.definitions.set(TOOL_NAMES.capabilities, {
    ...definition,
    execute: async () => ({
      ok: false, errorKind: 'capability-gap', error: '包内缺少二进制：dws',
      pluginVersion: '0.0.7', platform: 'darwin-arm64', binPlatform: 'darwin-arm64',
      supportedPlatforms: [], binaries: [], tools: [],
      policy: { credentialsTrusted: false, workspaceKnown: true, pathSearchForAuditCli: false, sandboxEscalation: '' },
      dwsCommands: [],
    }),
  })
  const preflight = await capabilityPreflight(gapDeps.deps.ctx, { id: 'agent-1' })
  assert.equal(preflight.ok, false)
  assert.match(preflight.error, /capability gap/)
})

test('auditToolsVisible is empty only when the registry resolves every required tool', () => {
  const { deps, registry } = makeDeps()
  registerCrwuTools(deps.ctx, deps)
  assert.deepEqual(auditToolsVisible(deps.ctx, undefined), [])
  // 注册面 = 全部业务 Tool；`auditToolsVisible` 判的是**审核子会话的能力集**（更小）。
  assert.equal(registry.definitions.size, CRWU_BUSINESS_TOOLS.length)
})

// ── 5.5：报告定位交接（crwu_audit_case_bootstrap + schemaCode 归 Host） ─────

test('记录类 Tool 的公开 schema 里没有 schemaCode（它由 Host 解析，不由模型提交）', () => {
  const { deps, registry } = makeDeps()
  registerCrwuTools(deps.ctx, deps)
  for (const name of [TOOL_NAMES.h3yunRecordGet, TOOL_NAMES.h3yunFilesList, TOOL_NAMES.auditCaseBootstrap]) {
    const definition = registry.definitions.get(name)
    assert.ok(definition, `${name} 必须注册`)
    const properties = Object.keys(definition.parameters?.properties ?? {})
    assert.equal(properties.includes('schemaCode'), false, `${name} 不得接受 schemaCode`)
    assert.equal(JSON.stringify(definition.parameters).includes('schemaCode'), false, `${name} 的参数描述里也不许出现 schemaCode`)
  }
})

test('record_get 用 Host 解析出的 schemaCode 拼命令，命令里不出现模型输入的表单名', async () => {
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(RECORD_JSON) : shellOk('{}')))
  const form = makeForm({ code: 'FORM-HOST' })
  const { deps, registry } = makeDeps({ shell, form })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'obj-1', caseDir: CASE_DIR }, signal: new AbortController().signal })
  assert.equal(result.isError, false, result.isError ? result.error.message : '')
  assert.equal(result.value.ok, true)
  assert.equal(shell.commands.length, 1)
  assert.match(shell.commands[0], /--schema FORM-HOST --id obj-1/)
  assert.deepEqual(form.calls, ['ensure'], 'schemaCode 只能来自 Host 解析器')
  // 输出里也不回显 schemaCode（它是 Host 的基础设施标识，模型不需要）
  assert.equal(JSON.stringify(result.value).includes('FORM-HOST'), false)
})

test('定位表单失败时记录类 Tool 报得出原因，而不是拿空 schemaCode 去调 CLI', async () => {
  const shell = makeShell(() => shellOk('{}'))
  const { deps, registry } = makeDeps({ shell, form: makeForm({ fails: true }) })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunFilesList, arguments: { objectId: 'obj-1' }, signal: new AbortController().signal })
  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.errorKind, 'not-found')
  assert.match(result.value.error, /未在氚云定位到表单/)
  assert.deepEqual(shell.commands, [], '定位失败不得再去调氚云')
})

test('bootstrap 每个 attempt 只取一次数：records get / files list 各一次，且禁止 records list', async () => {
  const shell = makeShell((spec) => {
    if (spec.command.includes('records get')) return shellOk(RECORD_JSON)
    if (spec.command.includes('files list')) return shellOk(FILES_JSON)
    return shellOk('{}')
  })
  // 权威案例目录 = `<工作空间>/<流水号>`：夹具的工作空间必须就是它的父级，
  // 否则工具会（正确地）拒绝 —— 它现在要求精确等于 Host 约定算出来的那一个。
  const { deps, registry } = makeDeps({ shell, fs: makeFs({ dirs: [CASE_DIR] }), state: makeState({ workspacePath: '/cases/space' }) })
  registerCrwuTools(deps.ctx, deps)
  const args = { objectId: 'obj-1', seqNo: SEQ, caseDir: CASE_DIR, attemptId: 'S1-a1-x', refresh: true }
  const first = await registry.execute({ callId: 'c1', name: TOOL_NAMES.auditCaseBootstrap, arguments: args, signal: new AbortController().signal })
  assert.equal(first.isError, false, first.isError ? first.error.message : '')
  assert.equal(first.value.ok, true)
  assert.equal(shell.commands.filter((command) => command.includes('records get')).length, 1)
  assert.equal(shell.commands.filter((command) => command.includes('files list')).length, 1)
  assert.equal(shell.commands.some((command) => command.includes('records list')), false, 'bootstrap 不许列记录')
  assert.equal(shell.commands.some((command) => /forms\s+search|\bfind\b|\bwhich\b|command -v/.test(command)), false, 'bootstrap 不许搜表单 / 扫目录 / 找路径')
  // 紧凑摘要：不给完整记录，只给路径 + 指纹 + 计数 + 路由事实
  assert.equal(first.value.snapshotPath, `${CASE_DIR}/输入快照/报告记录.json`)
  assert.equal(first.value.attachmentsPath, `${CASE_DIR}/输入快照/附件清单.json`)
  assert.match(String(first.value.digest), /^sha256:[0-9a-f]{64}$/)
  // 跟夹具走，不写死：记录现在自带 `ObjectId` / `SeqNo`（身份绑定要用的两个字段）。
  assert.equal(first.value.fieldCount, Object.keys(JSON.parse(RECORD_JSON).data).length)
  assert.equal(first.value.attachmentCount, 1)
  assert.equal(first.value.reused, false)
  assert.equal('record' in first.value, false, '完整记录不进模型上下文')
  assert.equal(JSON.stringify(first.value).includes('downloadUrl'), false, '带鉴权的下载 URL 不进上下文')

  // 同一个 attemptId 再调一次：不重新取数（幂等）
  const again = await registry.execute({ callId: 'c2', name: TOOL_NAMES.auditCaseBootstrap, arguments: { ...args, refresh: false }, signal: new AbortController().signal })
  assert.equal(again.value.ok, true)
  assert.equal(again.value.reused, true)
  assert.equal(shell.commands.filter((command) => command.includes('records get')).length, 1, '同一 attempt 不得重复取数')

  // 新的 attemptId（重审）：**重新取数**，不复用上一轮
  const retry = await registry.execute({ callId: 'c3', name: TOOL_NAMES.auditCaseBootstrap, arguments: { ...args, attemptId: 'S1-a2-y', refresh: true }, signal: new AbortController().signal })
  assert.equal(retry.value.ok, true)
  assert.equal(retry.value.reused, false)
  assert.equal(shell.commands.filter((command) => command.includes('records get')).length, 2, '重审必须重新取数')
})

test('bootstrap 把快照写进案例目录：记录、附件清单与元数据（元数据里只有 schemaCode 指纹）', async () => {
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(RECORD_JSON) : shellOk(FILES_JSON)))
  const fs = makeFs({ dirs: [CASE_DIR] })
  const { deps, registry } = makeDeps({ shell, fs, form: makeForm({ code: 'FORM-SECRET' }), state: makeState({ workspacePath: '/cases/space' }) })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.auditCaseBootstrap,
    arguments: { objectId: 'obj-1', seqNo: SEQ, caseDir: CASE_DIR, attemptId: 'S1-a1-x', refresh: true },
    signal: new AbortController().signal,
  })
  assert.equal(result.value.ok, true)
  const dir = `${CASE_DIR}/输入快照`
  assert.equal(fs.files.has(`${dir}/报告记录.json`), true)
  assert.equal(fs.files.has(`${dir}/附件清单.json`), true)
  assert.equal(fs.files.has(`${dir}/快照元数据.json`), true)
  const metadata = String(fs.files.get(`${dir}/快照元数据.json`))
  assert.match(metadata, /"schemaCodeDigest": "sha256:[0-9a-f]{16}"/)
  assert.equal(metadata.includes('FORM-SECRET'), false, 'schemaCode 原文不落盘')
  const attached = JSON.parse(String(fs.files.get(`${dir}/附件清单.json`)))
  assert.equal(attached.count, 1)
  assert.equal(attached.files[0].fileId, 'f1')
  assert.equal(JSON.stringify(attached).includes('downloadUrl'), false, '下载 URL 不落盘')
})

test('bootstrap 给每件附件算好落盘名与同名序号（同名 ZIP 不会互相覆盖）', async () => {
  const FIRST = 'c8ef13b8-1111-2222-3333-444455556666'
  const SECOND = 'e17ec3db-aaaa-bbbb-cccc-ddddeeeeffff'
  const files = JSON.stringify({
    data: [
      { field: 'F1', fileId: FIRST, fileName: '广兴建筑v3.zip', fileSize: '20342311', contentType: 'application/zip', downloadUrl: 'https://example.invalid/signed?token=SECRET' },
      { field: 'F2', fileId: SECOND, fileName: '广兴建筑v3.zip', fileSize: '20342312', contentType: 'application/zip', downloadUrl: 'https://example.invalid/signed?token=SECRET' },
      { field: 'F3', fileId: 'a1b2c3d4-0000-0000-0000-000000000000', fileName: '清单.xlsx', fileSize: '10', contentType: 'application/vnd.ms-excel', downloadUrl: 'https://example.invalid/signed?token=SECRET' },
    ],
  })
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(RECORD_JSON) : shellOk(files)))
  const fs = makeFs({ dirs: [CASE_DIR] })
  const { deps, registry } = makeDeps({ shell, fs, form: makeForm({ code: 'FORM-1' }), state: makeState({ workspacePath: '/cases/space' }) })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.auditCaseBootstrap,
    arguments: { objectId: 'obj-1', seqNo: SEQ, caseDir: CASE_DIR, attemptId: 'S1-a1-x', refresh: true },
    signal: new AbortController().signal,
  })
  assert.equal(result.value.ok, true, String(result.value.error))
  const attached = JSON.parse(String(fs.files.get(`${CASE_DIR}/输入快照/附件清单.json`)))
  const rows = attached.files
  assert.deepEqual(rows.map((row) => row.localName), [
    '广兴建筑v3__c8ef13b8.zip', '广兴建筑v3__e17ec3db.zip', '清单__a1b2c3d4.xlsx',
  ])
  assert.deepEqual(rows.map((row) => [row.nameIndex, row.nameTotal]), [[1, 2], [2, 2], [1, 1]],
    '同名附件要能一眼看出"这是两件"')
  // 落盘名两两不同 = "不会互相覆盖"的可判定形式。
  assert.equal(new Set(rows.map((row) => row.localName)).size, rows.length)
})

// ── 6：钉钉与 OSS ───────────────────────────────────────────────────────────

/**
 * 按命令片段路由 `dws` / `ossutil` 的替身。
 *
 * 字符串载荷 = **原始 stdout**（`ossutil ls` 是文本，再 JSON 包一层就解析不出来了）；
 * 对象/函数 = JSON 应答。
 */
function dwsRouter(routes) {
  return makeShell((spec) => {
    for (const [needle, payload] of routes) {
      if (spec.command.includes(needle)) {
        const value = typeof payload === 'function' ? payload(spec) : payload
        if (value === null) return null
        return typeof value === 'string' ? shellOk(value) : shellOk(JSON.stringify(value))
      }
    }
    return null
  })
}

test('crwu_audit_oss_publish uploads, lists the object back and reports the verified size', async () => {
  const html = `<html>审核意见</html>`
  const json = JSON.stringify({ auditTask: { auditTime: '2026-09-20T10:35:52+08:00', projectId: 'P1' }, fileTrace: { generatedAt: '2026-09-20T10:35:52+08:00' } })
  const fs = makeFs({
    dirs: [CASE_DIR],
    files: { [`${CASE_DIR}/审核意见.${SEQ}.html`]: html, [`${CASE_DIR}/审核结果.${SEQ}.json`]: json },
  })
  const shell = dwsRouter([
    ['cp -f', { ok: true }],
    ['ls ', `2026-09-20 10:35:52 +0800 CST  ${html.length}  Standard  d41d8cd98f00b204e9800998ecf8427e  oss://crwu-workspace/crwu/audit/${SEQ}/审核意见.${SEQ}.html\n`],
  ])
  const { deps, registry } = makeDeps({ fs, shell })
  withAuditScope(deps.state, { casePath: CASE_DIR })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute(scopedExec(TOOL_NAMES.ossPublish, { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, new AbortController().signal))
  assert.equal(result.isError, false, result.isError ? result.error.message : '')
  assert.equal(result.value.ok, true, result.value.error)
  assert.equal(result.value.uploaded, 1)
  assert.equal(result.value.results[0].sizeBytes, html.length, '必须回报写后列举到的真实字节数')
  assert.equal(result.value.results[0].key, `crwu/audit/${SEQ}/审核意见.${SEQ}.html`)
  assert.ok(shell.commands.some((command) => command.includes(`${OSSUTIL.replace(/'/g, '')}`) || command.includes(OSSUTIL)), '必须用包内 ossutil')
  // **口径已改**（2026-09-29 用户复查 P1）：`ossutil` 的每一次调用都会读
  // `~/.ossutilconfig`（工作区之外的凭据文件），受限沙箱下读不到 —— 上传与写后校验
  // 都必须逐次声明 `danger-full-access`。旧断言写的是"OSS 是非凭据操作，不提权"，
  // 那个前提本身就是错的，于是把"审核子会话里必然失败"这件事固定成了预期。
  // `resolve()` 与 `execute()` 逐条配对（一条命令一次 resolve），按下标配对就能拿回策略。
  const ossIndexes = shell.commands
    .map((command, index) => ({ command, index }))
    .filter((entry) => entry.command.includes('ossutil'))
    .map((entry) => entry.index)
  assert.equal(ossIndexes.length >= 2, true, `至少要有上传与写后校验两条 ossutil 调用：${String(ossIndexes.length)}`)
  for (const index of ossIndexes) {
    assert.equal(
      shell.requests[index]?.sandboxPolicy?.mode, 'danger-full-access',
      `ossutil 必须逐次提权：${shell.commands[index]}`,
    )
  }
})

test('crwu_audit_oss_publish fails when the object is missing or its size differs after upload', async () => {
  const html = 'x'.repeat(10)
  const fs = makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核意见.${SEQ}.html`]: html } })
  const listing = (size) => `2026-09-20 10:35:52 +0800 CST  ${size}  Standard  d41d8cd98f00b204e9800998ecf8427e  oss://crwu-workspace/crwu/audit/${SEQ}/审核意见.${SEQ}.html\n`
  const registryFor = (lsOut) => {
    const shell = dwsRouter([['cp -f', { ok: true }], ['ls ', lsOut]])
    const made = makeDeps({ fs, shell })
    withAuditScope(made.deps.state, { casePath: CASE_DIR })
    registerCrwuTools(made.deps.ctx, made.deps)
    return made.registry
  }
  const mismatch = await registryFor(listing(3)).execute(scopedExec(TOOL_NAMES.ossPublish, { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, new AbortController().signal))
  assert.equal(mismatch.value.ok, false, '字节数不符必须算失败')
  assert.match(mismatch.value.results[0].error, /字节数不符/)

  const missing = await registryFor('').execute(scopedExec(TOOL_NAMES.ossPublish, { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, new AbortController().signal))
  assert.equal(missing.value.ok, false, '写后列举里没有目标对象必须算失败')
  assert.match(missing.value.results[0].error, /没有目标对象/)
})

test('oss errors are sanitized before they can reach the model', () => {
  const raw = 'failed url=https://crwu-workspace.oss-cn-beijing.aliyuncs.com/a.html?OSSAccessKeyId=LTAI5tSecret&Signature=abc%2Fdef&security-token=xyz key=LTAI5tSecret1234567890'
  const clean = sanitizeOssError(raw)
  assert.equal(clean.includes('LTAI5tSecret'), false)
  assert.equal(clean.includes('Signature=abc'), false)
  assert.equal(clean.includes('security-token=xyz'), false)
  assert.match(clean, /<redacted>/)
})

test('crwu_audit_dingtalk_archive resolves every id from real returns and verifies the write', async () => {
  const json = JSON.stringify({ auditTask: { auditTime: '2026-09-20T10:35:52+08:00', projectId: 'PRJ-1' }, fileTrace: { generatedAt: '2026-09-18T14:06:07.123456+08:00' } })
  const fs = makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核结果.${SEQ}.json`]: json } })
  let listedAfterUpload = false
  const shell = makeShell((spec) => {
    if (spec.command.includes('profile list')) {
      return shellOk(JSON.stringify({ profiles: [{ corpName: '中瑞世联资产评估集团有限公司', corpId: 'corp-1', isOrgCurrent: true, profile: 'corp-1:user-1' }] }))
    }
    if (spec.command.includes('space list')) {
      return shellOk(JSON.stringify({ success: true, result: { items: [{ spaceName: '00-【系统专用】AI结果回传区（自动同步·请勿删改）', spaceType: 'orgSpace', spaceId: 'space-1', rootFolderId: 'root-1' }] } }))
    }
    if (spec.command.includes('+list')) {
      const folder = /--folder '?([^'\s]+)'?/.exec(spec.command)?.[1] ?? ''
      if (folder === 'root-1') return shellOk(JSON.stringify({ success: true, data: { files: [{ name: 'AI资产评估审核结果', type: 'FOLDER', nodeId: 'target-1' }], hasMore: false } }))
      if (folder === 'target-1') return shellOk(JSON.stringify({ success: true, data: { files: [{ name: '2026', type: 'FOLDER', nodeId: 'year-1' }], hasMore: false } }))
      if (folder === 'year-1') return shellOk(JSON.stringify({ success: true, data: { files: [{ name: '09', type: 'FOLDER', nodeId: 'month-1' }], hasMore: false } }))
      if (folder === 'month-1') {
        // 上传前后各列一次：第二次必须能看到刚上传的那个文件（写后验证）。
        return shellOk(JSON.stringify({
          success: true,
          data: {
            files: listedAfterUpload
              ? [{ name: '审核结果.PRJ-1.20260918-140607123456.json', type: 'FILE', nodeId: 'node-9', sizeBytes: json.length }]
              : [],
            hasMore: false,
          },
        }))
      }
      return shellOk(JSON.stringify({ success: true, data: { files: [], hasMore: false } }))
    }
    if (spec.command.includes('+upload')) {
      listedAfterUpload = true
      return shellOk(JSON.stringify({ success: true, data: { nodeId: 'node-9' } }))
    }
    return null
  })
  const { deps, registry } = makeDeps({ fs, shell, state: makeState({ localAccess: grantedConsent() }) })
  withAuditScope(deps.state, { casePath: CASE_DIR })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute(scopedExec(TOOL_NAMES.dingtalkArchive, { caseDir: CASE_DIR, seqNo: SEQ }, new AbortController().signal))
  assert.equal(result.isError, false, result.isError ? result.error.message : '')
  assert.equal(result.value.ok, true, result.value.error)
  assert.equal(result.value.remoteName, '审核结果.PRJ-1.20260918-140607123456.json')
  assert.equal(result.value.remotePath, `AI资产评估审核结果/2026/09/${result.value.remoteName}`)
  assert.equal(result.value.nodeId, 'node-9', 'nodeId 必须来自写后列举的真实返回')
  assert.equal(result.value.sizeBytes, json.length)
  assert.equal(listedAfterUpload, true, '上传后必须重新列目录核对')
  const resolved = shell.commands.filter((command) => !command.includes('profile list'))
  assert.ok(resolved.length > 0, '必须真的跑过解析后的命令')
  assert.ok(resolved.every((command) => command.includes('--profile corp-1:user-1')), '解析与执行必须用同一个 profile（除了解析它自己的那一条）')
  assert.equal(shell.commands.some((command) => command.includes('+create-folder')), false, '年/月目录已存在时不许创建')
})

test('crwu_audit_dingtalk_notify_self sends once, is idempotent per case, and never uses sms/call', async () => {
  const html = '<html>审核意见</html>'
  const fs = makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核意见.${SEQ}.html`]: html } })
  const sentMessages = []
  const shell = makeShell((spec) => {
    if (spec.command.includes('profile list')) {
      return shellOk(JSON.stringify({ profiles: [{ corpName: '中瑞世联资产评估集团有限公司', corpId: 'corp-1', isOrgCurrent: true, profile: 'corp-1:user-1' }] }))
    }
    if (spec.command.includes('get-self')) {
      return shellOk(JSON.stringify({ result: [{ orgEmployeeModel: { userId: 'user-9', orgUserName: '张三', openDingTalkId: 'ding-9' } }] }))
    }
    if (spec.command.includes('aisearch')) {
      return shellOk(JSON.stringify({ result: [{ name: '张三', openDingTalkId: 'ding-9' }] }))
    }
    if (spec.command.includes('messages-send')) {
      sentMessages.push(spec.command)
      return shellOk(JSON.stringify({ result: { messageId: 'msg-1' } }))
    }
    if (spec.command.includes('chat-messages')) {
      return shellOk(JSON.stringify({ result: [{ conversationId: 'conv-1', messageId: 'msg-1', resourceRefs: [`审核意见.${SEQ}.html`] }] }))
    }
    if (spec.command.includes('send-by-message')) {
      return shellOk(JSON.stringify({ result: { openDingId: 'open-ding-1' } }))
    }
    return null
  })
  const { deps, registry } = makeDeps({ fs, shell, state: makeState({ localAccess: grantedConsent() }) })
  withAuditScope(deps.state, { casePath: CASE_DIR })
  registerCrwuTools(deps.ctx, deps)

  const first = await registry.execute(scopedExec(TOOL_NAMES.dingtalkNotifySelf, { caseDir: CASE_DIR, seqNo: SEQ }, new AbortController().signal))
  assert.equal(first.isError, false, first.isError ? first.error.message : '')
  assert.equal(first.value.ok, true, first.value.error)
  assert.equal(first.value.alreadySent, false)
  assert.deepEqual(
    [first.value.userId, first.value.openDingTalkId, first.value.conversationId, first.value.messageId, first.value.openDingId],
    ['user-9', 'ding-9', 'conv-1', 'msg-1', 'open-ding-1'],
    '五个稳定 ID 必须来自真实返回',
  )
  assert.equal(sentMessages.length, 1)
  const ding = shell.commands.find((command) => command.includes('send-by-message'))
  assert.match(ding, /--type app/, 'DING 必须是应用内（免费）通道')
  assert.equal(/sms|call/.test(shell.commands.join(' ')), false, '命令里不许出现 sms / call')

  const second = await registry.execute(scopedExec(TOOL_NAMES.dingtalkNotifySelf, { caseDir: CASE_DIR, seqNo: SEQ }, new AbortController().signal))
  assert.equal(second.value.ok, true)
  assert.equal(second.value.alreadySent, true, '同一案例第二次调用必须命中幂等')
  assert.equal(sentMessages.length, 1, '幂等命中时不许再发一条')
})

test('crwu_audit_dingtalk_archive refuses an AuditResult whose timestamps lack a timezone', async () => {
  const json = JSON.stringify({ auditTask: { auditTime: '2026-09-20', projectId: 'P1' }, fileTrace: { generatedAt: '2026-09-18T14:06:07+08:00' } })
  const fs = makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核结果.${SEQ}.json`]: json } })
  const shell = makeShell(() => null)
  const { deps, registry } = makeDeps({ fs, shell })
  withAuditScope(deps.state, { casePath: CASE_DIR })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute(scopedExec(TOOL_NAMES.dingtalkArchive, { caseDir: CASE_DIR, seqNo: SEQ }, new AbortController().signal))
  assert.equal(result.value.ok, false)
  assert.equal(result.value.errorKind, 'input')
  assert.match(result.value.error, /auditTask.auditTime 必须包含时区/)
  assert.equal(shell.commands.length, 0, '输入门禁不通过时一条命令都不许发')
})

// ── 7：纯逻辑（计划 / 解析 / 通道分流）──────────────────────────────────────

test('buildPublishPlan reproduces the upload contract', () => {
  const plan = buildPublishPlan({
    auditTask: { auditTime: '2026-09-20T10:35:52+08:00', projectId: 'PRJ:2026/0001' },
    fileTrace: { generatedAt: '2026-09-18T14:06:07.123456+08:00' },
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.year, '2026')
  assert.equal(plan.plan.month, '09')
  assert.equal(plan.plan.remoteName, '审核结果.PRJ_2026_0001.20260918-140607123456.json', '非法字符替换为 _，时间戳取 generatedAt 的微秒')
  assert.equal(parseIsoStamp('2026-09-20', 'auditTask.auditTime').ok, false)
  assert.match(parseIsoStamp('2026-09-20', 'auditTask.auditTime').error, /必须包含时区/)
  assert.equal(typeof safeProjectId('  项目A  '), 'string')
  assert.equal(nodeSize({ sizeBytes: 12 }), 12)
  assert.equal(nodeSize({ size: 7 }), 7)
  assert.equal(nodeSize({}), null)
})

test('knowledge channel selection follows the node extension only', () => {
  assert.equal(channelFor('adoc').channel, 'export')
  assert.equal(channelFor('md').channel, 'download')
  assert.equal(channelFor('txt').channel, 'download')
  assert.equal(channelFor('pdf').channel, 'skipped')
  assert.equal(channelFor('').channel, 'skipped')
  assert.match(channelFor('').reason, /不可判定/, '缺 extension 不等于 failure，但必须说清原因')
})

test('knowledge path resolution matches exact file keys, expands directory keys and never guesses', () => {
  const tree = [
    { nodeId: 'f-1', name: '02-资产类型', type: 'folder', extension: '', contentType: '', parentFolderId: '', hasChildren: true, page: { autoPageComplete: true, pagesFetched: 1, itemsInPage: 1 }, children: [
      { nodeId: 'f-2', name: '机器设备', type: 'folder', extension: '', contentType: '', parentFolderId: 'f-1', hasChildren: true, page: { autoPageComplete: true, pagesFetched: 1, itemsInPage: 1 }, children: [
        { nodeId: 'd-1', name: '评估审核条目', type: 'file', extension: 'adoc', contentType: 'ALIDOC', parentFolderId: 'f-2', hasChildren: null, page: { autoPageComplete: true, pagesFetched: 1, itemsInPage: 1 }, children: [] },
      ] },
    ] },
  ]
  const index = buildPathIndex(tree)
  const file = resolveRequestedPaths(index, ['02-资产类型/机器设备/评估审核条目'])
  assert.equal(file.failures.length, 0)
  assert.deepEqual(file.items.map((item) => item.node.nodeId), ['d-1'])

  const dir = resolveRequestedPaths(index, ['02-资产类型/机器设备/'])
  assert.deepEqual(dir.items.map((item) => item.node.nodeId), ['d-1'], '目录键要递归展开')

  const miss = resolveRequestedPaths(index, ['不存在的路径'])
  assert.equal(miss.items.length, 0)
  assert.match(miss.failures[0].error, /在库内不存在/)

  const wrongKind = resolveRequestedPaths(index, ['02-资产类型/机器设备/评估审核条目/'])
  assert.match(wrongKind.failures[0].error, /声明为目录/)
})

test('the auto-audit chain contains no python or subprocess call for the business CLIs', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`
      if (entry.isDirectory()) await walk(`${path}/`)
      else if (/\.ts$/.test(entry.name)) files.push(path)
    }
  }
  await walk('src/host/')
  for (const file of files) {
    const raw = await readFile(new URL(file, ROOT), 'utf8')
    // 只看**代码行**：注释里完全可能同时提到「python3」与「ossutil」（例如解释为什么这条老路要删掉），
    // 那不是可执行的东西；真正要禁的是代码里出现「用 Python 调业务 CLI」。
    const source = raw
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
      })
      .join('\n')
    assert.equal(/from\s+['"]node:child_process['"]/.test(source), false, `${file} 使用了 node:child_process`)
    assert.equal(/import\(\s*['"]node:child_process['"]\s*\)/.test(source), false, `${file} 动态导入了 node:child_process`)
    assert.equal(/ctx\.subprocess/.test(source), false, `${file} 使用了 ctx.subprocess`)
    assert.equal(/python3?\b.*(crwu|dws|ossutil)/.test(source), false, `${file} 用 Python 调业务 CLI`)
    // `shell: true` / `exec` / `spawn` 是绕开 `ctx.shell` 的另一条路：业务 CLI 只允许经 Shell 服务执行。
    assert.equal(/\bshell\s*:\s*true/.test(source), false, `${file} 用了 shell:true 去拼命令`)
    assert.equal(/\brequire\(['"]child_process['"]\)/.test(source), false, `${file} 加载了 child_process`)
    assert.equal(/\bexecSync\(|\bspawnSync\(/.test(source), false, `${file} 用了同步子进程 API`)
  }
})

test('every command failure is classified into approval / infrastructure / cli', () => {
  // 三类失败必须分得开（这是排查方向问题）：
  // - 审批拒绝 → 让用户去授权；基础设施故障 → 找部署方；CLI 非零退出 → 看 stderr 的业务原因。
  const approval = [
    'the user rejected escalating this operation to "danger-full-access"; it stays denied',
    'approval for escalating to "danger-full-access" was cancelled',
    'sandbox escalation to "danger-full-access" requires approval, but no approval channel is available',
    'tool "crwu_audit_oss_publish" requires approval (not yet supported)',
  ]
  for (const error of approval) {
    assert.equal(classifyRun({ error, exitCode: null }), 'approval', error)
  }
  assert.equal(classifyRun({ error: 'Host shell 服务不可用', exitCode: null }), 'infrastructure')
  assert.equal(classifyRun({ error: 'sandbox-exec: sandbox_apply: Operation not permitted', exitCode: null }), 'infrastructure')
  assert.equal(classifyRun({ error: '', exitCode: 3 }), 'cli')
  assert.equal(classifyRun({ error: '', exitCode: 0, ok: true }), '')
  assert.equal(classifyRun({ error: 'approval cancelled', exitCode: null, aborted: true }), 'cancelled', '取消优先于审批归类')
})

// ── Windows 本地路径：核心审核链路的拼接必须随平台走 ────────────────────────
//
// 2026-09-28 复查：`bootstrap.ts` / `knowledge.ts` / `dingtalk.ts` / `audit/state.ts` /
// `WorkbenchPanel.tsx` / `workspace-view.ts` 仍在用 `/` 拼 Windows 本地路径 ——
// 结果就是 `C:\case/输入快照` 这种混用分隔符的路径进提示词、进 Tool 返回值、进 shell。

test('bootstrap 在 Windows 案例目录下用 `\\` 拼快照路径（含落盘目标）', async () => {
  const winCase = `C:\\Cases\\${SEQ}`
  // Windows 上每个 token 都是单引号字面量（`& 'crwu.exe' 'h3yun' 'records' 'get'`），
  // 所以不能只按 `records get` 这个连续子串匹配。
  const has = (command, verb) => command.includes(`records ${verb}`) || command.includes(`'records' '${verb}'`)
  const shell = makeShell((spec) => (has(spec.command, 'get') ? shellOk(RECORD_JSON) : shellOk(FILES_JSON)))
  const fs = makeFs({ dirs: [winCase] })
  // 信任域也要与案例目录同平台：案例目录必须落在它之下（真实流程里案例目录就是
  // `<工作空间>\<流水号>`；这套夹具此前是 POSIX 的 `/cases` + Windows 的 `C:\Cases\…`，自相矛盾）。
  const winState = makeState({ caseRoot: 'C:\\Cases', workspacePath: 'C:\\Cases' })
  const { deps, registry } = makeDeps({ shell, fs, platform: 'win32-x64', state: winState })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.auditCaseBootstrap,
    arguments: { objectId: 'obj-1', seqNo: SEQ, caseDir: winCase, attemptId: 'S1-a1-x', refresh: true },
    signal: new AbortController().signal,
  })
  assert.equal(result.value.ok, true, result.value.ok ? '' : String(result.value.error))
  const dir = `${winCase}\\输入快照`
  assert.equal(result.value.snapshotDir, dir)
  assert.equal(result.value.snapshotPath, `${dir}\\报告记录.json`)
  assert.equal(result.value.attachmentsPath, `${dir}\\附件清单.json`)
  assert.equal(result.value.metadataPath, `${dir}\\快照元数据.json`)
  // 三条路径里都不许出现混用的 `/`（`C:\\Cases/...` 这种形态）。
  for (const value of [result.value.snapshotDir, result.value.snapshotPath, result.value.attachmentsPath, result.value.metadataPath]) {
    assert.equal(String(value).includes('/'), false, `混用了分隔符：${String(value)}`)
  }
  // 真的落到 fs 上的三个文件也必须是同一个目录。
  assert.equal(fs.files.has(`${dir}\\报告记录.json`), true)
  assert.equal(fs.files.has(`${dir}\\附件清单.json`), true)
  assert.equal(fs.files.has(`${dir}\\快照元数据.json`), true)
})

test('knowledge 在 Windows 案例目录下用 `\\` 拼 knowledge 目录', async () => {
  const winCase = `C:\\Cases\\${SEQ}`
  // `wiki +space-list` 回空表：定位不到知识库 → 工具提前返回，但 caseDir / knowledgeDir
  // 已经在返回值里，正好用来断言拼接方式（不需要把整条下载链路都替身出来）。
  const shell = makeShell((spec) => (spec.command.includes('+space-list') ? shellOk('{"spaces":[]}') : shellOk('{}')))
  const fs = makeFs({ dirs: [winCase] })
  // 信任域也要与案例目录同平台：案例目录必须落在它之下（真实流程里案例目录就是
  // `<工作空间>\<流水号>`；这套夹具此前是 POSIX 的 `/cases` + Windows 的 `C:\Cases\…`，自相矛盾）。
  const winState = makeState({ caseRoot: 'C:\\Cases', workspacePath: 'C:\\Cases' })
  const { deps, registry } = makeDeps({ shell, fs, platform: 'win32-x64', state: winState })
  withAuditScope(deps.state, { casePath: winCase })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute(scopedExec(TOOL_NAMES.knowledgeMaterialize, { caseDir: winCase, paths: ['02-资产类型/机器设备/评估审核条目'] }, new AbortController().signal))
  assert.equal(result.value.caseDir, winCase)
  assert.equal(result.value.knowledgeDir, `${winCase}\\knowledge`)
  assert.equal(String(result.value.knowledgeDir).includes('/'), false)
})

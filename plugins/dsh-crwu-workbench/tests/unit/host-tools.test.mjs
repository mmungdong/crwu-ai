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

import { applyShellEffect } from '../helpers/shell-effects.mjs'

const ROOT = new URL('../../', import.meta.url)

const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
const { registerCrwuTools, missingAuditTools } = await import(new URL('src/host/tools/register.ts', ROOT).href)
const { REQUIRED_AUDIT_TOOLS, TOOL_NAMES } = await import(new URL('src/host/tools/consts.ts', ROOT).href)
const { sanitizeOssError } = await import(new URL('src/host/tools/oss.ts', ROOT).href)
const { classifyRun } = await import(new URL('src/host/tools/outcome.ts', ROOT).href)
const { assertDwsCommand, dwsEscalationAllowed, runDws } = await import(new URL('src/host/dws/run.ts', ROOT).href)
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
const RECORD_JSON = JSON.stringify({ data: { F0000049: '某项目', F0000020: 'B' } })
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

function makeCtx({ fs, shell, tools }) {
  const services = { fs, shell, tools }
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
  return { ...state, trustCredentials: false, ...patch }
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

function makeDeps({ fs, shell, tools, state, form, platform = 'darwin-arm64' } = {}) {
  const theState = state ?? makeState()
  const theFs = fs ?? makeFs({ dirs: [CASE_DIR, `${CASE_DIR}/knowledge`] })
  const theShell = shell ?? makeShell(() => shellOk('{}'))
  if (typeof theShell.attachFs === 'function') theShell.attachFs(theFs)
  const registry = tools ?? makeRegistry()
  const ctx = makeCtx({ fs: theFs, shell: theShell.service, tools: registry })
  const theForm = form ?? makeForm()
  return {
    ctx, fs: theFs, shell: theShell, registry, state: theState, form: theForm,
    deps: {
      ctx,
      config: { ...CONFIG },
      state: theState,
      form: theForm.resolver,
      world: {
        platform: async () => platform,
        home: async () => '/Users/x',
        workdir: async () => '/cases/session',
        cached: () => ({ platform, home: '/Users/x' }),
      },
    },
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
  assert.deepEqual([...registry.definitions.keys()].sort(), [...REQUIRED_AUDIT_TOOLS].sort())
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
  registerCrwuTools(deps.ctx, deps)

  const ok = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.h3yunFileGet,
    arguments: { fileId: 'f-1', caseDir: CASE_DIR, relativePath: '材料-源/估值报告.pdf' },
    signal: new AbortController().signal,
  })
  assert.equal(ok.value.ok, true)
  assert.equal(ok.value.path, `${CASE_DIR}/材料-源/估值报告.pdf`)
  assert.equal(ok.value.sizeBytes, 3)
  assert.ok(shell.commands[0].startsWith(CRWU))

  const escape = await registry.execute({
    callId: 'c2', name: TOOL_NAMES.h3yunFileGet,
    arguments: { fileId: 'f-1', caseDir: CASE_DIR, relativePath: '../outside.pdf' },
    signal: new AbortController().signal,
  })
  assert.equal(escape.value.ok, false)
  assert.equal(escape.value.errorKind, 'input', '越界路径必须在执行前被拒绝')
  assert.equal(shell.commands.length, 1, '被拒绝的请求不许发出任何命令')
})

// ── 4：默认沙箱与提权白名单 ─────────────────────────────────────────────────

test('default operations carry no danger-full-access sandbox policy', async () => {
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(JSON.stringify({ ok: true, data: { ObjectId: 'o' } })) : null))
  const { deps, registry } = makeDeps({ shell, state: makeState({ trustCredentials: false }) })
  registerCrwuTools(deps.ctx, deps)
  await registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'o', caseDir: CASE_DIR }, signal: new AbortController().signal })
  assert.equal(shell.requests[0].sandboxPolicy, undefined, '未授权时不得申请无沙箱执行')
})

test('a whitelisted credential command escalates only when authorized and the workspace is known', async () => {
  const shell = makeShell((spec) => (spec.command.includes('records get') ? shellOk(JSON.stringify({ ok: true, data: { ObjectId: 'o' } })) : null))
  const trusted = makeDeps({ shell, state: makeState({ trustCredentials: true }) })
  registerCrwuTools(trusted.deps.ctx, trusted.deps)
  await trusted.registry.execute({ callId: 'c1', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'o', caseDir: CASE_DIR }, signal: new AbortController().signal })
  assert.deepEqual(shell.requests[0].sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: CASE_DIR }, '白名单 + 已授权 + 工作区已知 → 提权')

  // 工作区未知（caseDir 省略、会话根也取不到）时**退回沙箱**，而不是报基础设施错误。
  const noWorkspace = makeDeps({ shell: makeShell((spec) => (spec.command.includes('records get') ? shellOk('{"ok":true,"data":{}}') : null)), state: makeState({ trustCredentials: true }) })
  noWorkspace.deps.world.workdir = async () => ''
  registerCrwuTools(noWorkspace.deps.ctx, noWorkspace.deps)
  await noWorkspace.registry.execute({ callId: 'c2', name: TOOL_NAMES.h3yunRecordGet, arguments: { objectId: 'o' }, signal: new AbortController().signal })
  assert.equal(noWorkspace.shell.requests[0].sandboxPolicy, undefined, '拿不到工作区就不提权')
})

test('the dws command allowlist rejects anything outside the registered shapes', () => {
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
  assert.equal(dwsEscalationAllowed(['api', 'call']), false, '白名单外的命令不许提权')
  assert.equal(dwsEscalationAllowed(['chat', '+messages-send']), true)
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
  assert.equal(registry.definitions.size, REQUIRED_AUDIT_TOOLS.length)
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
  const { deps, registry } = makeDeps({ shell, fs: makeFs({ dirs: [CASE_DIR] }) })
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
  assert.equal(first.value.fieldCount, 2)
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
  const { deps, registry } = makeDeps({ shell, fs, form: makeForm({ code: 'FORM-SECRET' }) })
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
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.ossPublish,
    arguments: { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, result.isError ? result.error.message : '')
  assert.equal(result.value.ok, true, result.value.error)
  assert.equal(result.value.uploaded, 1)
  assert.equal(result.value.results[0].sizeBytes, html.length, '必须回报写后列举到的真实字节数')
  assert.equal(result.value.results[0].key, `crwu/audit/${SEQ}/审核意见.${SEQ}.html`)
  assert.ok(shell.commands.some((command) => command.includes(`${OSSUTIL.replace(/'/g, '')}`) || command.includes(OSSUTIL)), '必须用包内 ossutil')
  assert.equal(shell.requests.every((request) => request.sandboxPolicy === undefined), true, 'OSS 是非凭据操作，不提权')
})

test('crwu_audit_oss_publish fails when the object is missing or its size differs after upload', async () => {
  const html = 'x'.repeat(10)
  const fs = makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核意见.${SEQ}.html`]: html } })
  const listing = (size) => `2026-09-20 10:35:52 +0800 CST  ${size}  Standard  d41d8cd98f00b204e9800998ecf8427e  oss://crwu-workspace/crwu/audit/${SEQ}/审核意见.${SEQ}.html\n`
  const registryFor = (lsOut) => {
    const shell = dwsRouter([['cp -f', { ok: true }], ['ls ', lsOut]])
    const made = makeDeps({ fs, shell })
    registerCrwuTools(made.deps.ctx, made.deps)
    return made.registry
  }
  const mismatch = await registryFor(listing(3)).execute({
    callId: 'c1', name: TOOL_NAMES.ossPublish, arguments: { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, signal: new AbortController().signal,
  })
  assert.equal(mismatch.value.ok, false, '字节数不符必须算失败')
  assert.match(mismatch.value.results[0].error, /字节数不符/)

  const missing = await registryFor('').execute({
    callId: 'c2', name: TOOL_NAMES.ossPublish, arguments: { caseDir: CASE_DIR, seqNo: SEQ, files: [`审核意见.${SEQ}.html`] }, signal: new AbortController().signal,
  })
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
  const { deps, registry } = makeDeps({ fs, shell, state: makeState({ trustCredentials: true }) })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.dingtalkArchive,
    arguments: { caseDir: CASE_DIR, seqNo: SEQ }, signal: new AbortController().signal,
  })
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
  const { deps, registry } = makeDeps({ fs, shell, state: makeState({ trustCredentials: true }) })
  registerCrwuTools(deps.ctx, deps)

  const first = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.dingtalkNotifySelf,
    arguments: { caseDir: CASE_DIR, seqNo: SEQ }, signal: new AbortController().signal,
  })
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

  const second = await registry.execute({
    callId: 'c2', name: TOOL_NAMES.dingtalkNotifySelf,
    arguments: { caseDir: CASE_DIR, seqNo: SEQ }, signal: new AbortController().signal,
  })
  assert.equal(second.value.ok, true)
  assert.equal(second.value.alreadySent, true, '同一案例第二次调用必须命中幂等')
  assert.equal(sentMessages.length, 1, '幂等命中时不许再发一条')
})

test('crwu_audit_dingtalk_archive refuses an AuditResult whose timestamps lack a timezone', async () => {
  const json = JSON.stringify({ auditTask: { auditTime: '2026-09-20', projectId: 'P1' }, fileTrace: { generatedAt: '2026-09-18T14:06:07+08:00' } })
  const fs = makeFs({ dirs: [CASE_DIR], files: { [`${CASE_DIR}/审核结果.${SEQ}.json`]: json } })
  const shell = makeShell(() => null)
  const { deps, registry } = makeDeps({ fs, shell })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.dingtalkArchive,
    arguments: { caseDir: CASE_DIR, seqNo: SEQ }, signal: new AbortController().signal,
  })
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
  const { deps, registry } = makeDeps({ shell, fs, platform: 'win32-x64' })
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
  const { deps, registry } = makeDeps({ shell, fs, platform: 'win32-x64' })
  registerCrwuTools(deps.ctx, deps)
  const result = await registry.execute({
    callId: 'c1', name: TOOL_NAMES.knowledgeMaterialize,
    arguments: { caseDir: winCase, paths: ['02-资产类型/机器设备/评估审核条目'] },
    signal: new AbortController().signal,
  })
  assert.equal(result.value.caseDir, winCase)
  assert.equal(result.value.knowledgeDir, `${winCase}\\knowledge`)
  assert.equal(String(result.value.knowledgeDir).includes('/'), false)
})

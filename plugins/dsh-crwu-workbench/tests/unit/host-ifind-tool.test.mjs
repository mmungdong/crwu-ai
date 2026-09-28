/**
 * `crwu_audit_ifind_query` 与 iFinD 凭据链路的行为测试（OPT-006 · F-003）。
 *
 * iFinD 取数在 DSH 里**必须**走结构化 Tool，不登记"模型直接跑第三方 call.py"的例外。
 * 所以每条断言都对着一条不可回退的规则：
 *
 * 1. 只经 `ctx.tools.register()` 注册，插件卸载时注销；进入审核 Agent 必需 Tool 集；
 * 2. schema 只有业务字段（operation / serverType / toolName / params），
 *    **没有** command / argv / binary / path / url / token / auth / sandbox / profile；
 * 3. 凭据由**插件 Host 自己**保管（插件状态目录、0600），模型不能提交、读取或看到；
 *    未授权（trustCredentials=false）→ `policy`，缺凭据 → `capability-gap`（不阻断其它检查）；
 * 4. 服务地址与 serverType 映射是 Host 内部**固定表**，模型不能提交 URL；正常 TLS 校验；
 * 5. `query` / `describe_tool` 前先用**本次** `tools/list` 的真实返回校验 toolName；
 * 6. 取消 / 超时 / HTTP 错误 / 协议错误 / JSON-RPC 错误分别返回结构化 errorKind；
 * 7. 输出不含令牌、Authorization、请求头、内部配置路径；长结果明确截断；
 * 8. MCP 协议版本跟随官方 1.4.0 客户端（2025-03-26），**不静默假设** 2024-11-05 永远有效。
 *
 * 全部替身都是内存实现：**不访问真实网络、不读真实凭据、不执行第三方脚本**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
const { ifindTool, IFIND_SERVER_TYPES, IFIND_SERVER_PATHS, IFIND_SERVICE_BASE, IFIND_OPERATIONS,
        validateIfindParams, makeIfindRedactor } = await import(new URL('src/host/tools/ifind.ts', ROOT).href)
const { TOOL_NAMES, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/consts.ts', ROOT).href)
const { missingAuditTools, registerCrwuTools } = await import(new URL('src/host/tools/register.ts', ROOT).href)
const { IFIND_PROTOCOL_VERSION, IFIND_SUPPORTED_PROTOCOL_VERSIONS, negotiateProtocol, trimIfindSchema,
        pickProbeTool, readToolsCallResult } =
  await import(new URL('src/host/ifind/mcp.ts', ROOT).href)
const { ifindEnvCheck, createIfindProbeCache, credentialFingerprint } =
  await import(new URL('src/host/ifind/env.ts', ROOT).href)
const { ifindProbe, ifindCredentialSave, ifindCredentialClear, ifindStatus } =
  await import(new URL('src/host/tools/ifind-ops.ts', ROOT).href)
const {
  IFIND_TEST_TOKEN, IFIND_TEST_HOME, credentialPathOf, makeIfindFs, makeIfindTransport,
  makeIfindShell, makeIfindOpsDeps, makeIfindToolDeps,
} = await import(new URL('tests/helpers/ifind-fixture.mjs', ROOT).href)

const TOKEN = IFIND_TEST_TOKEN
const HOME = IFIND_TEST_HOME

/** 直接调 Tool 的 `execute`（与真实注册表同一条路径，只是不过 arguments 校验那层）。 */
async function call(deps, args, exec = {}) {
  const definition = ifindTool(deps)
  return await definition.execute(args, {
    callId: 'c1',
    name: TOOL_NAMES.ifindQuery,
    signal: exec.signal ?? new AbortController().signal,
    agent: exec.agent,
  })
}

// ── 1. 注册 / 注销 / 可见性 ─────────────────────────────────────────────────

test('iFinD Tool 经 ctx.tools.register 注册，随插件卸载注销', () => {
  const registry = { definitions: new Map(), register(definition) { this.definitions.set(definition.name, definition); return () => this.definitions.delete(definition.name) } }
  const ctx = { get: (name) => (name === 'tools' ? registry : undefined), effect: () => {}, logger: { warn() {} } }
  const dispose = registerCrwuTools(ctx, makeIfindToolDeps())
  assert.ok(registry.definitions.has(TOOL_NAMES.ifindQuery))
  dispose()
  assert.deepEqual([...registry.definitions.keys()], [], '卸载时必须完整注销')
})

test('iFinD Tool 属于审核 Agent 必需 Tool 集', () => {
  assert.ok(REQUIRED_AUDIT_TOOLS.includes(TOOL_NAMES.ifindQuery))
  const registry = { get: (name) => (name === TOOL_NAMES.ifindQuery ? undefined : {}) }
  const ctx = { get: (name) => (name === 'tools' ? registry : undefined) }
  assert.deepEqual(missingAuditTools(ctx, undefined), [TOOL_NAMES.ifindQuery],
    '可见性判据走 registry scope resolver，缺失时必须报出来')
})

// ── 2. schema：只有业务字段 ────────────────────────────────────────────────

test('schema 只含业务字段，且 serverType 是固定八元枚举', () => {
  const definition = ifindTool(makeIfindToolDeps())
  const schema = definition.parameters
  assert.deepEqual(Object.keys(schema.properties).sort(),
    ['operation', 'params', 'serverType', 'toolName'].sort())
  assert.deepEqual([...schema.properties.serverType.enum], [...IFIND_SERVER_TYPES])
  assert.deepEqual([...schema.properties.operation.enum], [...IFIND_OPERATIONS])
  assert.deepEqual([...schema.required].sort(), ['operation', 'serverType'])
  const lower = JSON.stringify(schema).toLowerCase()
  for (const banned of ['command', 'argv', 'binary', 'executable', 'url', 'token', 'auth',
                        'sandbox', 'profile', 'path', 'endpoint', 'secret']) {
    assert.ok(!lower.includes(`"${banned}"`), `schema 不得出现 ${banned}`)
  }
  assert.deepEqual(validateJsonSchemaValue(schema, { operation: 'list_tools', serverType: 'stock' }), [])
  assert.ok(validateJsonSchemaValue(schema, { operation: 'list_tools', serverType: 'crypto' }).length > 0)
})

test('输出的结构化失败形状合法（含 describe_tool）', () => {
  const definition = ifindTool(makeIfindToolDeps())
  for (const value of [
    { ok: true, errorKind: '', error: '', operation: 'list_tools', serverType: 'stock', tools: [] },
    { ok: true, errorKind: '', error: '', operation: 'describe_tool', serverType: 'stock',
      toolName: 't', description: 'x', inputSchema: { type: 'object' }, truncated: false },
    { ok: false, errorKind: 'policy', error: '未授权' },
  ]) {
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value), [], JSON.stringify(value))
  }
})

// ── 3. 凭据边界 ───────────────────────────────────────────────────────────

test('未授权读取本机凭据 → policy，且不发任何请求', async () => {
  const transport = makeIfindTransport()
  const out = await call(makeIfindToolDeps({ trusted: false, transport }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'policy')
  assert.deepEqual(transport.calls, [], '未授权时不得发起取数请求')
})

test('凭据未配置 → capability-gap，不阻断其它检查', async () => {
  const transport = makeIfindTransport()
  const out = await call(makeIfindToolDeps({ fs: makeIfindFs({ missing: true }), transport }),
    { operation: 'list_tools', serverType: 'stock' })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'capability-gap')
  assert.deepEqual(transport.calls, [])
})

test('凭据仍是占位符 → capability-gap', async () => {
  const out = await call(makeIfindToolDeps({ fs: makeIfindFs({ token: 'your ifind-mcp key' }) }),
    { operation: 'list_tools', serverType: 'stock' })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'capability-gap')
})

test('凭据只从**插件状态目录**读取，不再读技能目录里的 mcp_config.json', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('src/host/tools/ifind.ts', ROOT), 'utf8')
  assert.equal(source.includes('mcp_config.json'), false, '不得再引用技能目录里的配置文件')
  assert.equal(source.includes('.agents'), false, '不得搜索技能根')
  const store = readFileSync(new URL('src/host/ifind/store.ts', ROOT), 'utf8')
  assert.match(store, /crwu-workbench/, '凭据必须落在插件状态目录')
  assert.equal(store.includes('ifind-finance-data'), false, '不得把凭据写进/读自技能目录')
  // 行为判据（比源码扫描强）：凭据路径确实解析到插件状态目录，而不是技能目录。
  assert.equal(credentialPathOf().includes('.agents/skills'), false)
  assert.equal(credentialPathOf(), `${HOME}/.dsh/crwu-workbench/ifind-credential.json`)
})

// ── 4. 参数校验 ───────────────────────────────────────────────────────────

test('超出枚举的 serverType / operation 在进入 execute 之前就被注册表拒绝', async () => {
  for (const args of [{ operation: 'list_tools', serverType: 'crypto' },
                      { operation: 'drop_table', serverType: 'stock' },
                      { operation: 'query', serverType: 'stock', toolName: 'x', params: { n: Number.NaN } }]) {
    await assert.rejects(call(makeIfindToolDeps(), args), /invalid arguments/i, JSON.stringify(args))
  }
})

test('schema 合法但语义非法的 toolName / params 返回 input', async () => {
  const cases = [
    { operation: 'query', serverType: 'stock' },
    { operation: 'query', serverType: 'stock', toolName: '   ' },
    { operation: 'describe_tool', serverType: 'stock' },
    { operation: 'query', serverType: 'stock', toolName: 'x', params: { a: { constructor: 1 } } },
    { operation: 'query', serverType: 'stock', toolName: 'x', params: { a: [1, { prototype: 2 }] } },
    { operation: 'query', serverType: 'stock', toolName: 'x',
      params: JSON.parse('{"__proto__":{"a":1}}') },
  ]
  for (const args of cases) {
    const out = await call(makeIfindToolDeps(), args)
    assert.equal(out.ok, false, JSON.stringify(args))
    assert.equal(out.errorKind, 'input', JSON.stringify(args))
  }
})

test('params 校验拒绝原型污染键与非 JSON 值', () => {
  assert.equal(validateIfindParams({ a: 1 }).ok, true)
  for (const bad of [JSON.parse('{"__proto__":1}'), JSON.parse('{"a":{"constructor":1}}'),
                     JSON.parse('{"a":[1,{"prototype":2}]}'), { a: Number.POSITIVE_INFINITY },
                     { a: undefined }, { a: () => 1 }, null, 'x', 3]) {
    assert.equal(validateIfindParams(bad).ok, false, JSON.stringify(bad))
  }
})

// ── 5. 协议：initialize / tools/list / tools/call ──────────────────────────

test('list_tools 走 initialize → initialized → tools/list，且用固定地址与内部映射', async () => {
  const transport = makeIfindTransport({ tools: ['a', 'b'] })
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'list_tools', serverType: 'edb' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const methods = transport.calls.map((c) => JSON.parse(c.body).method)
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list'])
  assert.equal(transport.calls[0].url, `${IFIND_SERVICE_BASE}/${IFIND_SERVER_PATHS.edb}`)
  for (const c of transport.calls) {
    assert.equal(c.headers['Content-Type'], 'application/json')
    assert.equal(c.headers.Authorization, TOKEN)
    assert.equal(c.headers.url, undefined)
  }
  assert.equal(transport.calls[2].headers['Mcp-Session-Id'], 'sess-1', 'initialize 拿到的会话必须带上')
  assert.deepEqual(out.tools.map((t) => t.name), ['a', 'b'])
  assert.equal(out.tools[0].hasSchema, true, '要告诉模型这些工具能取到参数 schema')
})

test('initialize 声明 2025-03-26（跟随官方 1.4.0 客户端），并把协商结果回给模型', async () => {
  const transport = makeIfindTransport()
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'list_tools', serverType: 'stock' })
  const init = JSON.parse(transport.calls[0].body)
  assert.equal(init.params.protocolVersion, IFIND_PROTOCOL_VERSION)
  assert.equal(IFIND_PROTOCOL_VERSION, '2025-03-26', '官方 1.4.0 用的就是这个版本')
  assert.equal(out.ok, true)
  assert.equal(out.protocolVersion, '2025-03-26')
})

test('协议版本协商：服务端回旧版本可降级，回不认识的版本必须失败（不许静默假设）', () => {
  assert.deepEqual(negotiateProtocol(''), { ok: true, version: IFIND_PROTOCOL_VERSION, error: '' })
  assert.deepEqual(negotiateProtocol('2024-11-05'), { ok: true, version: '2024-11-05', error: '' })
  for (const supported of IFIND_SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocol(supported).ok, true, supported)
  }
  const unknown = negotiateProtocol('2099-01-01')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /不受支持/)
})

test('服务端回一个不受支持的协议版本 → infrastructure，且不再继续列工具', async () => {
  const transport = makeIfindTransport({ protocolVersion: '2099-01-01' })
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'infrastructure')
  assert.match(out.error, /协议版本/)
  assert.equal(transport.calls.some((c) => JSON.parse(c.body).method === 'tools/list'), false)
})

test('query 前先用本次 tools/list 真实返回校验 toolName', async () => {
  const transport = makeIfindTransport({ tools: ['get_stock_summary'] })
  const out = await call(makeIfindToolDeps({ transport }),
    { operation: 'query', serverType: 'stock', toolName: 'delete_everything', params: { a: 1 } })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'input')
  assert.ok(!transport.calls.some((c) => JSON.parse(c.body).method === 'tools/call'),
    '不在 tools/list 里的工具名不得发给服务')

  const ok = await call(makeIfindToolDeps({ transport: makeIfindTransport({ tools: ['get_stock_summary'] }) }),
    { operation: 'query', serverType: 'stock', toolName: 'get_stock_summary', params: { code: '600000.SH' } })
  assert.equal(ok.ok, true, JSON.stringify(ok))
})

test('describe_tool 返回脱敏、限深、限长的 schema；不存在的工具名同样被拒', async () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }
  const long = 'x'.repeat(5_000)
  const transport = makeIfindTransport({
    tools: ['t'], toolSchema: { type: 'object', description: long, deep, properties: { code: { type: 'string' } } },
  })
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'describe_tool', serverType: 'stock', toolName: 't' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.toolName, 't')
  const rendered = JSON.stringify(out.inputSchema)
  assert.ok(rendered.length <= 7_000, `schema 必须有长度上限：${rendered.length}`)
  assert.equal(rendered.includes('x'.repeat(500)), false, '超长字符串必须被截断')
  assert.match(rendered, /已截断：层级过深/, '过深层级必须被截断而不是整棵带出来')

  const missing = await call(makeIfindToolDeps({ transport: makeIfindTransport({ tools: ['t'] }) }),
    { operation: 'describe_tool', serverType: 'stock', toolName: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'input')
})

test('trimIfindSchema：净化器接在 schema 出口上（上游把秘密写进 schema 也要抹掉）', () => {
  const { redact } = makeIfindRedactor([TOKEN])
  const out = trimIfindSchema({ description: `token=${TOKEN}`, authorization: 'x' }, redact)
  assert.equal(JSON.stringify(out).includes(TOKEN), false)
  assert.equal('authorization' in out, false)
})

test('tools/call 的 params 原样作为 arguments 传入', async () => {
  const transport = makeIfindTransport({ tools: ['t1'] })
  await call(makeIfindToolDeps({ transport }),
    { operation: 'query', serverType: 'fund', toolName: 't1', params: { code: 'F1', window: '1y' } })
  const callMsg = transport.calls.map((c) => JSON.parse(c.body)).find((m) => m.method === 'tools/call')
  assert.deepEqual(callMsg.params, { name: 't1', arguments: { code: 'F1', window: '1y' } })
  assert.equal(transport.calls[0].url, `${IFIND_SERVICE_BASE}/${IFIND_SERVER_PATHS.fund}`)
})

// ── 6. 失败分类 ───────────────────────────────────────────────────────────

test('HTTP 错误 / 协议错误 / JSON-RPC 错误 / 缺会话分别结构化返回', async () => {
  const cases = [
    ['http', 'infrastructure'],
    ['protocol', 'infrastructure'],
    ['jsonrpc', 'cli'],
    ['no-session', 'infrastructure'],
  ]
  for (const [fail, kind] of cases) {
    const out = await call(makeIfindToolDeps({ transport: makeIfindTransport({ fail }) }),
      { operation: 'list_tools', serverType: 'stock' })
    assert.equal(out.ok, false, fail)
    assert.equal(out.errorKind, kind, `${fail} → ${out.errorKind}`)
    assert.ok(out.error.length > 0)
  }
})

test('exec.signal 取消 → cancelled；自身超时 → infrastructure（消息写明超时）', async () => {
  const controller = new AbortController()
  const pending = call(makeIfindToolDeps({ transport: makeIfindTransport({ hang: true }) }),
    { operation: 'list_tools', serverType: 'stock' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  const cancelled = await pending
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.errorKind, 'cancelled')

  const timedOut = await call(makeIfindToolDeps({ transport: makeIfindTransport({ hang: true }) }),
    { operation: 'list_tools', serverType: 'stock' })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.errorKind, 'infrastructure')
  assert.ok(/超时|timeout/i.test(timedOut.error), timedOut.error)
}, { timeout: 20_000 })

// ── 7. 零泄露与截断 ───────────────────────────────────────────────────────

test('输出不含令牌 / Authorization / 请求头 / 内部配置路径', async () => {
  const out = await call(makeIfindToolDeps(), { operation: 'query', serverType: 'stock', toolName: 'get_stock_summary', params: {} })
  const text = JSON.stringify(out)
  assert.ok(!text.includes(TOKEN), '不得回显令牌')
  assert.ok(!/authorization/i.test(text))
  assert.ok(!text.includes('mcp-session-id'))
  assert.ok(!text.includes('mcp_config.json'), '不得回显内部配置路径')
  assert.ok(!text.includes(HOME))
})

test('长结果明确截断', async () => {
  const huge = 'x'.repeat(50_000)
  const transport = {
    async post(request) {
      const parsed = JSON.parse(request.body)
      if (parsed.method === 'initialize') {
        return { status: 200, headers: { 'mcp-session-id': 's' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }
      }
      if (parsed.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
      if (parsed.method === 'tools/list') {
        return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 't' }] } }) }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: huge }] } }) }
    },
    calls: [],
  }
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'query', serverType: 'stock', toolName: 't', params: {} })
  assert.equal(out.ok, true)
  assert.equal(out.truncated, true, '超长结果必须标注截断')
  assert.ok(JSON.stringify(out).length < 20_000, '截断必须真的生效')
})

// ── 8. 源码边界（不搜索技能根 / 不跑脚本 / 不关 TLS 校验）─────────────────

test('ifind 源码不搜索技能根、不执行第三方脚本、不关闭 TLS 校验', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['src/host/tools/ifind.ts', 'src/host/ifind/mcp.ts', 'src/host/ifind/store.ts']) {
    const source = readFileSync(new URL(file, ROOT), 'utf8')
    for (const banned of ['child_process', 'subprocess', 'execSync', 'spawn(', 'call-node.js', 'call.py',
                          'verify: false', 'verify:false', 'rejectUnauthorized', 'NODE_TLS_REJECT_UNAUTHORIZED',
                          'readdir', 'codebuddy', '.claude', '.dsh/skills']) {
      assert.ok(!source.includes(banned), `${file} 不得出现 ${banned}`)
    }
  }
})

// ── 9. 凭据净化：Host 必须**主动**净化，而不是指望上游不回显 ──────────────────

const MALICIOUS_SESSION = 'sess-SECRET-9f3c'
const SECRET_HEADER = `Bearer ${TOKEN}`

function makeMaliciousTransport(mode) {
  const calls = []
  return {
    calls,
    async post(request) {
      calls.push(request)
      const parsed = JSON.parse(request.body)
      if (parsed.method === 'initialize') {
        return { status: 200, headers: { 'mcp-session-id': MALICIOUS_SESSION },
                 body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }) }
      }
      if (parsed.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
      if (parsed.method === 'tools/list') {
        return { status: 200, headers: {},
                 body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
                   result: { tools: [{ name: 't', description: `见 ${SECRET_HEADER} 与 ${MALICIOUS_SESSION}` }] } }) }
      }
      if (mode === 'error') {
        return { status: 200, headers: {},
                 body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
                   error: { code: -32000, message: `权益不足，token=${TOKEN}，${SECRET_HEADER}` } }) }
      }
      return { status: 200, headers: {},
               body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
                 result: { content: [{ type: 'text', text: '{"value":42}' }],
                           meta: { authorization: SECRET_HEADER, auth_token: TOKEN,
                                   access_token: TOKEN, cookie: 'sid=1', note: `raw ${TOKEN}` },
                           sessionId: MALICIOUS_SESSION, echo: `Authorization: ${SECRET_HEADER}` } }) }
    },
  }
}

test('上游正常 result 主动回显秘密：模型可见输出必须已被净化，业务数据仍可用', async () => {
  const out = await call(makeIfindToolDeps({ transport: makeMaliciousTransport('result') }),
    { operation: 'query', serverType: 'stock', toolName: 't', params: {} })
  const text = JSON.stringify(out)
  assert.ok(!text.includes(TOKEN), `不得回显精确令牌：${text.slice(0, 300)}`)
  assert.ok(!text.includes(MALICIOUS_SESSION), '不得回显会话 id')
  assert.ok(!text.includes('Bearer '), '不得回显 Authorization 值')
  for (const field of ['authorization', 'auth_token', 'access_token', 'cookie']) {
    assert.ok(!text.toLowerCase().includes(field), `不得回显凭据字段 ${field}`)
  }
  assert.equal(out.ok, true)
  assert.ok(text.includes('42'), '正常业务数据必须保留（不得整段丢弃）')
})

test('JSON-RPC error 主动回显令牌：错误输出必须已被净化', async () => {
  const out = await call(makeIfindToolDeps({ transport: makeMaliciousTransport('error') }),
    { operation: 'query', serverType: 'stock', toolName: 't', params: {} })
  const text = JSON.stringify(out)
  assert.equal(out.ok, false)
  assert.ok(!text.includes(TOKEN), `错误里不得回显令牌：${text.slice(0, 300)}`)
  assert.ok(!text.includes('Bearer '), '错误里不得回显 Authorization 值')
})

test('transport 异常消息主动回显令牌：错误输出必须已被净化', async () => {
  const transport = { async post() { throw new Error(`connect failed with ${SECRET_HEADER} and ${TOKEN}`) } }
  const out = await call(makeIfindToolDeps({ transport }),
    { operation: 'query', serverType: 'stock', toolName: 't', params: {} })
  const text = JSON.stringify(out)
  assert.equal(out.ok, false)
  assert.ok(!text.includes(TOKEN), `异常消息里不得回显令牌：${text.slice(0, 300)}`)
  assert.ok(!text.includes('Bearer '), '异常消息里不得回显 Authorization 值')
})

// ── 净化器的 R2 缺陷复现 ───────────────────────────────────────────────────

const SESSION_LEAK = 'sess-LEAK-123'

test('R2·净化器：真实 session id 出现在普通字符串里也必须净化', () => {
  const { redact } = makeIfindRedactor([TOKEN, SESSION_LEAK])
  const out = redact({ note: `session=${SESSION_LEAK}`, echo: `Mcp-Session-Id: ${SESSION_LEAK}` })
  assert.ok(!JSON.stringify(out).includes(SESSION_LEAK), `普通字符串里的 session id 泄露了：${JSON.stringify(out)}`)
})

test('R2·净化器：正常业务字段必须原样保留（禁止按子串误删）', () => {
  const { redact } = makeIfindRedactor([TOKEN])
  const kept = { tradingSession: 'regular', sessionCount: 3, secretariat: 'business-value', marketValue: 42 }
  assert.deepEqual(JSON.parse(JSON.stringify(redact(kept))), kept, '这些是业务字段，不是凭据字段')
})

test('R2·净化器：精确敏感字段（含大小写与 _/- 变体）必须丢弃', () => {
  const { redact } = makeIfindRedactor([TOKEN])
  const banned = ['authorization', 'auth_token', 'access_token', 'refresh_token', 'api_key',
                  'secret', 'password', 'credential', 'cookie', 'set-cookie', 'session', 'session_id',
                  'mcp-session-id', 'Authorization', 'AUTH-TOKEN', 'Set-Cookie', 'API_KEY']
  const input = Object.fromEntries(banned.map((k) => [k, 'x']))
  input.marketValue = 42
  const out = redact(input)
  for (const key of banned) assert.ok(!(key in out), `敏感字段未丢弃：${key}`)
  assert.equal(out.marketValue, 42, '业务字段必须保留')
})

test('R2·净化器：__proto__/prototype/constructor 不得污染原型', () => {
  const { redact } = makeIfindRedactor([TOKEN])
  const payload = JSON.parse('{"__proto__":{"polluted":true},"prototype":{"p":1},"constructor":{"c":1},"ok":1}')
  const out = redact(payload)
  assert.equal({}.polluted, undefined, '不得污染 Object.prototype')
  assert.equal(out.ok, 1)
  assert.equal(Object.getPrototypeOf(out), null, '净化结果应为无原型对象')
})

// ── MCP JSON-RPC 协议校验 ─────────────────────────────────────────────────

function makeProtocolTransport(script) {
  const calls = []
  return {
    calls,
    async post(request) {
      calls.push(request)
      const msg = JSON.parse(request.body)
      const reply = script(msg, calls.length)
      if (reply === undefined) throw new Error(`脚本未覆盖方法 ${msg.method}`)
      return reply
    },
  }
}

const R2_INIT_OK = (msg) => ({ status: 200, headers: { 'mcp-session-id': 'sess-1' },
  body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) })
const R2_TOOLS_OK = (msg) => ({ status: 200, headers: {},
  body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 't' }] } }) })

test('R2·initialized 返回 HTTP 错误 → 立即停止，不再调用列工具', async () => {
  const transport = makeProtocolTransport((msg) => {
    if (msg.method === 'initialize') return R2_INIT_OK(msg)
    if (msg.method === 'notifications/initialized') return { status: 500, headers: {}, body: 'boom' }
    return R2_TOOLS_OK(msg)
  })
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'infrastructure')
  assert.ok(!transport.calls.some((c) => JSON.parse(c.body).method === 'tools/list'),
    'initialized 失败后不得继续列工具')
})

test('R2·tools/call 缺 result → infrastructure；显式 result:null 合法', async () => {
  const missing = makeProtocolTransport((msg) => {
    if (msg.method === 'initialize') return R2_INIT_OK(msg)
    if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
    if (msg.method === 'tools/list') return R2_TOOLS_OK(msg)
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id }) }
  })
  const bad = await call(makeIfindToolDeps({ transport: missing }),
    { operation: 'query', serverType: 'stock', toolName: 't', params: {} })
  assert.equal(bad.ok, false)
  assert.equal(bad.errorKind, 'infrastructure')

  const nulled = makeProtocolTransport((msg) => {
    if (msg.method === 'initialize') return R2_INIT_OK(msg)
    if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
    if (msg.method === 'tools/list') return R2_TOOLS_OK(msg)
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) }
  })
  const ok = await call(makeIfindToolDeps({ transport: nulled }),
    { operation: 'query', serverType: 'stock', toolName: 't', params: {} })
  assert.equal(ok.ok, true, `result:null 是合法响应：${JSON.stringify(ok)}`)
})

test('R2·jsonrpc 版本或响应 id 不一致 → 结构化失败', async () => {
  const badVersion = makeProtocolTransport((msg) => ({ status: 200, headers: { 'mcp-session-id': 's' },
    body: JSON.stringify({ jsonrpc: '1.0', id: msg.id, result: {} }) }))
  const v = await call(makeIfindToolDeps({ transport: badVersion }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(v.ok, false)
  assert.equal(v.errorKind, 'infrastructure')

  const badId = makeProtocolTransport((msg) => {
    if (msg.method === 'initialize') return R2_INIT_OK(msg)
    if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 999, result: { tools: [] } }) }
  })
  const i = await call(makeIfindToolDeps({ transport: badId }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(i.ok, false)
  assert.equal(i.errorKind, 'infrastructure')
})

test('R2·tools/list 缺 result.tools → infrastructure（不得把任意对象当成功）', async () => {
  const transport = makeProtocolTransport((msg) => {
    if (msg.method === 'initialize') return R2_INIT_OK(msg)
    if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { nope: 1 } }) }
  })
  const out = await call(makeIfindToolDeps({ transport }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'infrastructure')
})

test('R2·transport 收到的 timeoutMs 等于本次注入值', async () => {
  const transport = makeIfindTransport({ tools: ['t'] })
  await call(makeIfindToolDeps({ transport, timeoutMs: 1234 }), { operation: 'list_tools', serverType: 'stock' })
  for (const c of transport.calls) assert.equal(c.timeoutMs, 1234, '必须传解析后的 timeoutMs')
})

test('R2·内部超时能取消 transport，且不依赖 AbortSignal.any；外部取消仍是 cancelled', async () => {
  const t1 = await call(makeIfindToolDeps({ transport: makeIfindTransport({ hang: true }), timeoutMs: 40 }),
    { operation: 'list_tools', serverType: 'stock' })
  assert.equal(t1.ok, false)
  assert.equal(t1.errorKind, 'infrastructure', `内部超时必须是 infrastructure：${JSON.stringify(t1)}`)
  assert.ok(/超时/.test(t1.error), t1.error)

  const controller = new AbortController()
  const pending = call(makeIfindToolDeps({ transport: makeIfindTransport({ hang: true }), timeoutMs: 5_000 }),
    { operation: 'list_tools', serverType: 'stock' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  const t2 = await pending
  assert.equal(t2.ok, false)
  assert.equal(t2.errorKind, 'cancelled', `外部取消必须是 cancelled：${JSON.stringify(t2)}`)
}, { timeout: 20_000 })

test('R2·list_tools 有明确上限、truncated=true，且后部工具仍可用于 query', async () => {
  const names = Array.from({ length: 400 }, (_v, i) => `tool_${String(i).padStart(3, '0')}`)
  const transport = makeProtocolTransport((msg) => {
    if (msg.method === 'initialize') return R2_INIT_OK(msg)
    if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
    if (msg.method === 'tools/list') {
      return { status: 200, headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id: msg.id,
          result: { tools: names.map((name) => ({ name, description: 'x'.repeat(2_000) })) } }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: 1 } }) }
  })
  const listed = await call(makeIfindToolDeps({ transport }), { operation: 'list_tools', serverType: 'stock' })
  assert.equal(listed.ok, true)
  assert.equal(listed.truncated, true, '超限必须显式截断')
  const size = JSON.stringify(listed).length
  assert.ok(size <= 20_000, `模型可见体积必须有上限，实际 ${size}`)
  assert.ok(listed.tools.length > 0 && listed.tools[0].name === 'tool_000', '前部合法工具仍可见')

  const queried = await call(makeIfindToolDeps({ transport }),
    { operation: 'query', serverType: 'stock', toolName: names[names.length - 1], params: {} })
  assert.equal(queried.ok, true, `后部真实工具不得因可见清单裁剪而被拒：${JSON.stringify(queried)}`)
})

// ── 10. Host 操作：保存 / 清除 / 探测（**不是**模型可见的 Tool）───────────────

test('ifind-credential-save：保存成功后立刻做一次**真实**探测，认证成功才算通过', async () => {
  const fs = makeIfindFs({ missing: true })
  const transport = makeIfindTransport({ tools: ['a', 'b'] })
  const result = await ifindCredentialSave(makeIfindOpsDeps({ fs, transport }), { secret: 'abcdefghij' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.probe.ok, true)
  assert.equal(result.probe.state, 'authenticated')
  assert.equal(result.probe.toolCount, 2)
  assert.equal(result.view.state, 'authenticated')
  assert.equal(fs.written.length >= 1, true, '必须真的写盘')
  assert.equal(JSON.stringify(result).includes('abcdefghij'), false, '返回值里不得出现明文 SK')
})

test('ifind-credential-save：SK 本身有问题 → input，且一次请求都不发', async () => {
  for (const bad of ['', '   ', 'your ifind-mcp key', ' abcdefghij', 'abcdefghij\n']) {
    const fs = makeIfindFs({ missing: true })
    const transport = makeIfindTransport()
    const result = await ifindCredentialSave(makeIfindOpsDeps({ fs, transport }), { secret: bad })
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.equal(result.errorKind, 'input', JSON.stringify(bad))
    assert.deepEqual(transport.calls, [], `坏值不得发起探测：${JSON.stringify(bad)}`)
  }
})

test('ifind-credential-clear：必须显式确认，确认后真的清除', async () => {
  const fs = makeIfindFs()
  const shell = makeIfindShell()
  const commands = shell.commands
  const deps = makeIfindOpsDeps({ fs, shell })
  const refused = await ifindCredentialClear(deps, {})
  assert.equal(refused.ok, false)
  assert.equal(refused.cleared, false)
  assert.match(refused.error, /确认/)
  assert.deepEqual(commands, [], '没确认就不得动文件')

  const cleared = await ifindCredentialClear(deps, { confirm: true })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.cleared, true)
  assert.equal(commands.some((command) => command.startsWith('rm -f ')), true)
})

test('ifind-probe：认证成功 / 401 / 403 权益 / 超时 / 取消 / 非法 JSON / 协议错误', async () => {
  const ok = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ tools: ['a'] }) }), {})
  assert.equal(ok.state, 'authenticated')
  assert.equal(ok.errorKind, '')
  assert.deepEqual(ok.toolNames, ['a'])

  const unauthorized = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ fail: 'http401' }) }), {})
  assert.equal(unauthorized.state, 'invalid')
  assert.equal(unauthorized.errorKind, 'credential', '401 是凭据问题')

  const forbidden = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ fail: 'http403' }) }), {})
  assert.equal(forbidden.errorKind, 'entitlement', '403 是权益问题，必须与认证失败分开')
  assert.match(forbidden.error, /权益/)

  const protocol = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ fail: 'protocol' }) }), {})
  assert.equal(protocol.errorKind, 'infrastructure', '非法 JSON 是协议/基础设施问题')

  const serverError = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ fail: 'http' }) }), {})
  assert.equal(serverError.errorKind, 'infrastructure')

  const timedOut = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ hang: true }), timeoutMs: 40 }), {})
  assert.equal(timedOut.errorKind, 'infrastructure')
  assert.match(timedOut.error, /超时/)

  const controller = new AbortController()
  const pending = ifindProbe(
    { ...makeIfindOpsDeps({ transport: makeIfindTransport({ hang: true }), timeoutMs: 5_000 }) },
    { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 20)
  const cancelled = await pending
  assert.equal(cancelled.errorKind, 'infrastructure')
  assert.match(cancelled.error, /取消/)
}, { timeout: 20_000 })

test('ifind-probe：未配置 SK → unconfigured，一次网络请求都不发', async () => {
  const transport = makeIfindTransport()
  const result = await ifindProbe(makeIfindOpsDeps({ fs: makeIfindFs({ missing: true }), transport }), {})
  assert.equal(result.state, 'unconfigured')
  assert.equal(result.errorKind, 'unconfigured')
  assert.deepEqual(transport.calls, [])
})

test('ifind-probe：上游回显 token / session / header 时，探测结论里不得带出来', async () => {
  const result = await ifindProbe(makeIfindOpsDeps({ transport: makeIfindTransport({ fail: 'malicious', tools: ['t'] }) }), {})
  const text = JSON.stringify(result)
  assert.equal(text.includes(TOKEN), false, `不得回显令牌：${text.slice(0, 300)}`)
  assert.equal(text.includes('sess-SECRET'), false, '不得回显会话 id')
  assert.equal(text.includes('Bearer '), false, '不得回显 Authorization')
})

test('ifind-status：只读文件时如实回 unverified，不许说已认证', async () => {
  const status = await ifindStatus(makeIfindOpsDeps({}))
  assert.equal(status.state, 'unverified')
  assert.equal(status.ok, true, '文件在就算"已配置"，但认证状态是另一回事')
  assert.equal(status.toolCount, 0)
  assert.equal(status.path, credentialPathOf())
})

// ── 11. 真实取数验证：环境校验必须真的取一次数据（协议 14）────────────────────

test('环境校验 = 真的取一次数据：成功时 dataVerified=true 并留下脱敏证据', async () => {
  const fs = makeIfindFs()
  const transport = makeIfindTransport({ tools: ['get_stock_summary'] })
  const check = await ifindEnvCheck({ get: (name) => fs.get(name) }, HOME, { transport })
  assert.equal(check.ok, true)
  assert.equal(check.state, 'authenticated')
  assert.equal(check.dataVerified, true, '真的取到数据才算验证通过')
  assert.equal(check.dataTool, 'get_stock_summary', '要留下用的哪个工具')
  assert.match(check.dataSample, /42/, '要留下脱敏后的取数摘要')
  assert.equal(JSON.stringify(check).includes(IFIND_TEST_TOKEN), false, '摘要里不得出现 API-Key')
  // 三次往返：initialize → initialized → tools/list → tools/call。
  const methods = transport.calls.map((c) => JSON.parse(c.body).method)
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
})

test('取数结果里回显了 API-Key 也要被净化（dataSample 绝不带出凭据）', async () => {
  const fs = makeIfindFs()
  const transport = makeIfindTransport({ tools: ['t'], callText: '{"v":1}' })
  const check = await ifindEnvCheck({ get: (name) => fs.get(name) }, HOME, { transport })
  assert.equal(check.dataVerified, true)
  assert.equal(check.dataSample.includes(IFIND_TEST_TOKEN), false, `摘要泄露了 API-Key：${check.dataSample}`)
  assert.equal(check.dataSample.includes('Bearer '), false, '摘要不得带 Authorization')
})

test('认证通过但取数失败：ok=true（凭据没问题）且 dataVerified=false，并给出明确原因', async () => {
  const cases = [
    ['isError', 'entitlement', /权益/],
    ['empty', 'infrastructure', /空内容|没有取到/],
    ['http500', 'infrastructure', /HTTP|取数失败|超时/],
    ['protocol', 'infrastructure', /协议|JSON/],
  ]
  for (const [call, kind, pattern] of cases) {
    const fs = makeIfindFs()
    const transport = makeIfindTransport({ tools: ['t'], call: call === 'http500' ? 'http' : call })
    const check = await ifindEnvCheck({ get: (name) => fs.get(name) }, HOME, { transport })
    assert.equal(check.dataVerified, false, call)
    // **凭据确实通过了认证**（会话 + 工具清单都过了）→ `ok:true`；
    // 界面据此说"认证通过，但这次没取到数据"，而不是笼统的"验证失败"。
    assert.equal(check.ok, true, `${call}: 认证是过的，不该报成认证失败`)
    assert.equal(check.state, 'unverified', call)
    assert.equal(check.errorKind, kind, `${call} → ${check.errorKind}（${check.reason}）`)
    assert.match(check.reason, pattern, call)
  }
})

test('取数阶段的 401 / 403 也分开归因（不是笼统的"取数失败"）', async () => {
  for (const [call, kind] of [['http401', 'credential'], ['http403', 'entitlement']]) {
    const fs = makeIfindFs()
    const transport = makeIfindTransport({ tools: ['t'], call })
    const check = await ifindEnvCheck({ get: (name) => fs.get(name) }, HOME, { transport })
    assert.equal(check.dataVerified, false, call)
    assert.equal(check.errorKind, kind, `${call} → ${check.errorKind}`)
    assert.match(check.reason, /取数失败/, call)
  }
})

test('取数阶段取消 → 不算成功，且原因说"已取消"', async () => {
  const fs = makeIfindFs()
  const transport = makeIfindTransport({ tools: ['t'], call: 'ok' })
  // 第一次调用就取消：initialize 阶段就会走 cancelled 分支。
  const controller = new AbortController()
  controller.abort()
  const check = await ifindEnvCheck({ get: (name) => fs.get(name) }, HOME, { transport, signal: controller.signal })
  assert.equal(check.dataVerified, false)
  assert.equal(check.ok, false)
  assert.match(check.reason, /取消/)
})

test('pickProbeTool：只挑只读、单参数、无开关的工具；一个都没有时返回 null', () => {
  const schema = (required, props) => ({ type: 'object', required, properties: props })
  // 写/批量/导入导出类一律不碰。
  assert.equal(pickProbeTool([{ name: 'delete_all', description: '', inputSchema: schema(['code'], { code: { type: 'string' } }) }]), null)
  assert.equal(pickProbeTool([{ name: 'batch_import', description: '', inputSchema: schema([], {}) }]), null)
  // 必填超过 1 个不碰（缺参数失败不能当成"key 不能取数"）。
  assert.equal(pickProbeTool([{ name: 'range_query', description: '',
    inputSchema: schema(['code', 'start', 'end'], { code: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }) }]), null)
  // 开关型参数不碰（猜错语义容易调成写操作）。
  assert.equal(pickProbeTool([{ name: 'search', description: '',
    inputSchema: schema([], { query: { type: 'string' }, realtime: { type: 'boolean' } }) }]), null)
  // 正常的单参数只读工具：挑中，并填经典标的。
  const picked = pickProbeTool([{ name: 'get_stock_summary', description: '',
    inputSchema: schema(['code'], { code: { type: 'string' } }) }])
  assert.deepEqual(picked, { name: 'get_stock_summary', args: { code: '600519.SH' } })
  // 自由文本类参数用中文经典标的。
  const text = pickProbeTool([{ name: 'stock_search', description: '',
    inputSchema: schema(['query'], { query: { type: 'string' } }) }])
  assert.deepEqual(text, { name: 'stock_search', args: { query: '贵州茅台' } })
  // 跳过表里的名字在前、合法工具在后：应该挑到后一个。
  const mixed = pickProbeTool([
    { name: 'update_watchlist', description: '', inputSchema: schema(['code'], { code: { type: 'string' } }) },
    { name: 'get_price', description: '', inputSchema: schema(['code'], { code: { type: 'string' } }) },
  ])
  assert.equal(mixed.name, 'get_price')
})

test('readToolsCallResult：isError / 空内容算失败；有内容才算成功（并净化）', () => {
  const { redact } = makeIfindRedactor([TOKEN])
  assert.equal(readToolsCallResult({ content: [] }, redact).ok, false)
  assert.equal(readToolsCallResult({ isError: true, content: [{ text: TOKEN }] }, redact).ok, false)
  const bad = readToolsCallResult({ isError: true, content: [{ text: `${TOKEN} 权益不足` }] }, redact)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.includes(TOKEN), false, '失败原因也要净化')
  const ok = readToolsCallResult({ content: [{ type: 'text', text: '{"v":1}' }] }, redact)
  assert.equal(ok.ok, true)
  assert.match(ok.sample, /"v":1/)
})

test('环境校验默认就真探；probe:false 才跳过（这时只回长度，不回"已认证"）', async () => {
  const fs = makeIfindFs()
  const transport = makeIfindTransport({ tools: ['t'] })
  const skipped = await ifindEnvCheck({ get: (name) => fs.get(name) }, HOME, { transport, probe: false })
  assert.equal(skipped.state, 'unverified')
  assert.equal(skipped.dataVerified, false)
  assert.deepEqual(transport.calls, [], 'probe:false 时一个请求都不发')
})

test('探测缓存：30s 内复用（面板反复刷新不打上游）；force 强制重探；指纹随凭据变化', async () => {
  const cache = createIfindProbeCache(30_000, () => Date.now())
  const fs = makeIfindFs()
  const transport = makeIfindTransport({ tools: ['t'] })
  const ctx = { get: (name) => fs.get(name) }
  const first = await ifindEnvCheck(ctx, HOME, { transport, cache })
  assert.equal(first.dataVerified, true)
  const callsAfterFirst = transport.calls.length
  // 第二次（同凭据、未 force）→ 走缓存，不新增请求。
  const second = await ifindEnvCheck(ctx, HOME, { transport, cache })
  assert.equal(second.dataVerified, true)
  assert.equal(transport.calls.length, callsAfterFirst, 'TTL 内不该再打上游')
  // force → 真的重探。
  await ifindEnvCheck(ctx, HOME, { transport, cache, force: true })
  assert.ok(transport.calls.length > callsAfterFirst, 'force 必须绕过缓存')
  // 指纹：换一份 key 就是另一个 key（旧条目自然失效）。
  assert.notEqual(credentialFingerprint('a'.repeat(12)), credentialFingerprint('b'.repeat(12)))
  assert.equal(credentialFingerprint('same-key-123'), credentialFingerprint('same-key-123'))
})

test('缺 API-Key / 未配置时不发请求，也不报"已认证"', async () => {
  const transport = makeIfindTransport()
  const check = await ifindEnvCheck({ get: (name) => makeIfindFs({ missing: true }).get(name) }, HOME, { transport })
  assert.equal(check.state, 'unconfigured')
  assert.equal(check.dataVerified, false)
  assert.deepEqual(transport.calls, [])
  assert.match(check.reason, /API-Key/)
})

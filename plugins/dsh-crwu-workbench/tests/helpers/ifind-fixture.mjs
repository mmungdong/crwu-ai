/**
 * iFinD 测试夹具：**内存**凭据 + **内存** MCP 传输。
 *
 * 两条硬约束（照抄自 `tests/unit/host-ifind-tool.test.mjs` 的口径）：
 * 1. **永不访问真实网络**：所有传输都是内存替身，可以精确地"按剧本回话"；
 * 2. **永不读真实凭据**：文件系统替身只认测试自己写进去的内容。
 *
 * 之所以抽成共享夹具：这条链路现在有四个消费者（取数 Tool、`ifind-probe`、
 * `ifind-credential-save`、环境自检的 ⑥ 层），各自的测试必须用**同一份**协议替身，
 * 否则会出现"探测说已认证、取数说 401"这种只有真机能发现的漂移。
 */
import { ifindCredentialPath } from '../../src/host/ifind/store.ts'

export const IFIND_TEST_TOKEN = 'FAKE-TOKEN-abcdefghijklmnop'
export const IFIND_TEST_HOME = '/Users/example'

/** 凭据文件的默认位置（与实现同一处推导，测试不自己拼路径）。 */
export function credentialPathOf(home = IFIND_TEST_HOME) {
  return ifindCredentialPath(home)
}

/**
 * fs 替身：`stat` / `readText` / `writeText` 都留痕。
 *
 * `failWrite` 用来验"写入失败要如实上报"；`mode` 保留给未来可能的权限回读。
 */
export function makeIfindFs({ token = IFIND_TEST_TOKEN, raw = null, missing = false, failWrite = false } = {}) {
  const path = credentialPathOf()
  const files = {}
  const infos = {}
  const written = []
  if (!missing) {
    files[path] = raw ?? JSON.stringify({ auth_token: token })
    infos[path] = { type: 'file' }
  }
  const service = {
    async resolve(value) { return { targetKey: String(value), displayPath: String(value) } },
    async stat(target) { return infos[target.targetKey] },
    async readText(target) { return files[target.targetKey] },
    async writeText(target, content, _expected, _signal, sandboxPolicy) {
      if (failWrite) throw new Error('disk full')
      written.push({ path: target.targetKey, content, sandboxPolicy })
      files[target.targetKey] = content
      infos[target.targetKey] = { type: 'file' }
      return { operation: 'update', version: 'v', before: null, after: content }
    },
  }
  return {
    path,
    files,
    infos,
    written,
    get(name) { return name === 'fs' ? service : undefined },
  }
}

/**
 * MCP 传输替身。
 *
 * 支持四种"故意坏掉"的模式，覆盖验收清单里的每一类失败：
 * - `http401` / `http403`：状态码层面区分"凭据错"与"权益不足"；
 * - `http`：其它 HTTP 错误（服务端故障）；
 * - `protocol`：返回非 JSON；
 * - `jsonrpc`：合法 JSON-RPC 2.0 业务错误；
 * - `timeout`：永不返回（由内部超时取消）；
 * - `malicious`：**主动回显** token / session / Authorization 头，验净化器。
 */
export function makeIfindTransport(options = {}) {
  const {
    tools = ['get_stock_summary'],
    fail = null,
    sessionId = 'sess-1',
    protocolVersion = '2025-03-26',
    hang = false,
    toolSchema = { type: 'object', properties: { code: { type: 'string', description: '股票代码' } } },
    /** `tools/call` 的行为：`ok`（默认，带回内容）/ `isError` / `empty` / HTTP 报错由 `fail` 控制。 */
    call = 'ok',
    callText = '{"value":42}',
  } = options
  const calls = []
  const token = options.token ?? IFIND_TEST_TOKEN
  const handler = async (request) => {
    calls.push(request)
    const parsed = JSON.parse(request.body)
    if (hang) {
      await new Promise((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (request.signal?.aborted) onAbort()
        else request.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (fail === 'http401') return { status: 401, headers: {}, body: '{"error":"unauthorized"}' }
    if (fail === 'http403') return { status: 403, headers: {}, body: '{"error":"forbidden"}' }
    if (fail === 'http') return { status: 500, headers: {}, body: 'boom' }
    if (fail === 'protocol') return { status: 200, headers: {}, body: 'not-json' }
    if (fail === 'jsonrpc') {
      return { status: 200, headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32000, message: '权益不足' } }) }
    }
    if (fail === 'no-session') return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }
    if (parsed.method === 'initialize') {
      return {
        status: 200, headers: { 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion } }),
      }
    }
    if (parsed.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
    if (parsed.method === 'tools/list') {
      if (fail === 'malicious') {
        return { status: 200, headers: {},
          body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
            result: { tools: [{ name: 't', description: `见 Bearer ${token} 与 sess-SECRET-9f3c` }] } }) }
      }
      return { status: 200, headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
          result: { tools: tools.map((name) => ({ name, description: 'x', inputSchema: toolSchema })) } }) }
    }
    if (parsed.method === 'tools/call') {
      if (call === 'http401') return { status: 401, headers: {}, body: '{"error":"unauthorized"}' }
      if (call === 'http403') return { status: 403, headers: {}, body: '{"error":"forbidden"}' }
      if (call === 'http') return { status: 500, headers: {}, body: 'boom' }
      if (call === 'protocol') return { status: 200, headers: {}, body: 'not-json' }
      if (call === 'isError') {
        return { status: 200, headers: {},
          body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
            result: { isError: true, content: [{ type: 'text', text: '权益不足：该数据服务未开通' }] } }) }
      }
      if (call === 'empty') {
        return { status: 200, headers: {},
          body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [] } }) }
      }
      if (call === 'jsonrpc-error') {
        return { status: 200, headers: {},
          body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
            error: { code: -32000, message: `取数被拒绝 token=${token}` } }) }
      }
      return { status: 200, headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id,
          result: { content: [{ type: 'text', text: `见 Bearer ${token}` }, { type: 'text', text: callText }] } }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }) }
  }
  return { post: handler, calls }
}

/** 只记命令、永远成功的 shell 替身（建目录 / chmod 用它）。 */
export function makeIfindShell({ runs = true, error = 'boom', commands = [] } = {}) {
  return {
    commands,
    resolve: (request) => request,
    async execute(spec) {
      commands.push(spec.command)
      if (!runs) throw new Error(error)
      return { result: async () => ({
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
      }) }
    },
  }
}

/** 造一个可用的 `ifind-ops` 依赖包（全部走替身，无真实 IO）。 */
export function makeIfindOpsDeps({ fs = makeIfindFs(), transport = makeIfindTransport(), timeoutMs = 50,
                                    shell = makeIfindShell() } = {}) {
  return {
    ctx: { get: (name) => (name === 'shell' ? shell : fs.get(name)) },
    home: async () => IFIND_TEST_HOME,
    platform: async () => 'darwin-arm64',
    transport,
    timeoutMs,
  }
}

/** 造一个可用的 `ToolDeps`（取数 Tool 用；`world` 提供 home / platform）。 */
export function makeIfindToolDeps({ fs = makeIfindFs(), transport = makeIfindTransport(), trusted = true,
                                     timeoutMs = 50, noTransport = false } = {}) {
  return {
    ctx: { get: (name) => fs.get(name) },
    config: {},
    state: { trustCredentials: trusted },
    world: { workdir: async () => '/cases', home: async () => IFIND_TEST_HOME, platform: async () => 'darwin-arm64' },
    form: {},
    ...(noTransport ? {} : { ifind: transport }),
    ifindTimeoutMs: timeoutMs,
  }
}

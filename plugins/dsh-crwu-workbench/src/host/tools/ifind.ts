import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { readIfindSecret } from '../ifind/store.ts'
import {
  defaultIfindTransport,
  listIfindTools,
  makeIfindRedactor,
  openIfindSession,
  rpc,
  trimIfindSchema,
  validateIfindParams,
  IFIND_PROTOCOL_VERSION,
  IFIND_SCHEMA_TEXT_MAX,
  IFIND_SERVER_PATHS,
  IFIND_SERVER_TYPES,
  IFIND_SERVICE_BASE,
  IFIND_TIMEOUT_MS,
  IFIND_TOOL_DESC_MAX,
  IFIND_TOOLS_MAX,
} from '../ifind/mcp.ts'
import { clampText, failure, renderJson } from './outcome.ts'
import { TOOL_NAMES, TOOL_TEXT_MAX } from './consts.ts'
import { credentialsTrusted, type ToolDeps } from './types.ts'

/**
 * 同花顺 iFinD 取数 Tool（OPT-006 · 关闭 F-003）。
 *
 * 为什么必须做成结构化 Tool：DSH 已有完整的 Tool 注册、审批、取消、超时与脱敏体系。
 * 技能里原来写的是"在 `ifind-finance-data` 技能目录里写一个临时脚本、`import call` 取数"
 * —— 那是**模型直接执行第三方代码**的通道，它绕过审批、把令牌暴露在进程里、并且要求模型
 * 自己去找技能根。这里把整条链路收进 Host：
 *
 * - 模型只提交业务字段：`operation`（`list_tools` / `describe_tool` / `query`）、`serverType`、
 *   `toolName`、`params`；
 * - **服务地址与 serverType 映射是 Host 内部固定表**，模型不能提交 URL；
 * - 令牌由 Host 从**插件自己的凭据存储**读取（`host/ifind/store.ts`，0600），
 *   既不搜索技能根，也绝不回显；读取前先过 `trustCredentials`；
 * - 正常 TLS 校验（第三方脚本用 `verify=False`，这里明确不沿用）；
 * - `query` / `describe_tool` 前先用**本次** `tools/list` 的真实返回校验 `toolName`；
 * - 取消 / 超时 / HTTP / 协议 / JSON-RPC 错误分别结构化返回。
 *
 * 协议版本见 `IFIND_PROTOCOL_VERSION`（2025-03-26，跟随官方 1.4.0 客户端）；
 * 不做静默降级 —— 上游回了不认识的版本就是协议错误。
 *
 * 传输是**可注入**的（`deps.ifind`）：测试用内存替身，永不访问真实网络。
 */

/** 模型可见的操作集合。 */
export const IFIND_OPERATIONS = ['list_tools', 'describe_tool', 'query'] as const

/** 单个工具的 `inputSchema` 裁剪上限，见 `trimIfindSchema`。 */
export const IFIND_SCHEMA_MAX_CHARS = IFIND_SCHEMA_TEXT_MAX

interface IfindArgs {
  operation: unknown
  serverType: unknown
  toolName: unknown
  params: unknown
}

function isServerType(value: unknown): value is typeof IFIND_SERVER_TYPES[number] {
  return typeof value === 'string' && (IFIND_SERVER_TYPES as readonly string[]).includes(value)
}

/** 读令牌：位置只来自插件自有凭据存储，读前不做任何技能根搜索。 */
async function readIfindToken(deps: ToolDeps): Promise<{ token: string; error: string }> {
  const home = await deps.world.home()
  const result = await readIfindSecret(deps.ctx, home)
  if (result.ok) return { token: result.secret, error: '' }
  return { token: '', error: `iFinD 取数入口未认证：${result.reason}（在环境信息页填写 SK 后重试）` }
}

export function ifindTool(deps: ToolDeps) {
  return defineTool({
    name: TOOL_NAMES.ifindQuery,
    description: [
      '同花顺 iFinD 外部数据取数（结构化 Tool）：operation=list_tools 查当前权益下的工具清单，'
      + 'operation=describe_tool 取单个工具的脱敏参数 schema，operation=query 取数。',
      '服务地址、serverType 映射与 SK 都由 Host 内部持有；模型只提交业务参数，不能提交 URL 或凭据。',
      '未授权 / 未配置 SK / 服务不可用时返回结构化错误（policy / capability-gap / infrastructure），'
      + '按知识库降级口径记能力缺口，不阻断其它检查。',
    ].join(' '),
    parameters: {
      operation: { required: true, type: 'string', enum: [...IFIND_OPERATIONS], description: 'list_tools 查工具清单，describe_tool 取参数 schema，query 取数。' },
      serverType: { required: true, type: 'string', enum: [...IFIND_SERVER_TYPES], description: `iFinD 服务类别（固定枚举）：${IFIND_SERVER_TYPES.join(' / ')}。` },
      toolName: { type: 'string', description: 'describe_tool / query 时必填：必须存在于该 serverType 本次 tools/list 的返回中，Host 会先校验再调用。' },
      params: { type: 'json', description: 'query 的取数参数（JSON 对象，按 describe_tool 给出的 schema 填写；拒绝原型污染键与非 JSON 值）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { required: true, type: 'boolean' },
          errorKind: { required: true, type: 'string' },
          error: { required: true, type: 'string' },
          operation: { type: 'string' },
          serverType: { type: 'string' },
          /** 协商后的 MCP 协议版本（排查上游换代时看它）。 */
          protocolVersion: { type: 'string' },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { required: true, type: 'string' },
                description: { type: 'string' },
                /** 该工具有没有可用的参数 schema（`describe_tool` 能取到）。 */
                hasSchema: { type: 'boolean' },
              },
            },
          },
          toolName: { type: 'string' },
          description: { type: 'string' },
          inputSchema: { type: 'json', description: 'describe_tool 的返回：脱敏、限深、限长的 inputSchema。' },
          result: { type: 'json', description: 'tools/call 的 JSON-RPC result（超长时只留 truncatedText）。' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec: ToolRunContext) {
      const input = args as unknown as IfindArgs
      const operation = typeof input.operation === 'string' ? input.operation : ''
      if (!(IFIND_OPERATIONS as readonly string[]).includes(operation)) {
        return failure('input', `operation 必须是以下之一：${IFIND_OPERATIONS.join(' / ')}`)
      }
      if (!isServerType(input.serverType)) {
        return failure('input', `serverType 必须是以下之一：${IFIND_SERVER_TYPES.join(' / ')}`)
      }
      const serverType = input.serverType
      let toolName = ''
      let params: Record<string, unknown> = {}
      if (operation === 'query' || operation === 'describe_tool') {
        toolName = typeof input.toolName === 'string' ? input.toolName.trim() : ''
        if (toolName === '') return failure('input', `${operation} 必须提供 toolName`)
        if (toolName.length > 128) return failure('input', 'toolName 过长')
      }
      if (operation === 'query') {
        const verdict = validateIfindParams(input.params ?? {})
        if (!verdict.ok) return failure('input', verdict.error)
        params = input.params as Record<string, unknown>
      }

      // ① 读本机凭据必须先获得授权：未授权一律 policy，且**不发任何请求**。
      if (!credentialsTrusted(deps)) {
        return failure('policy', '读取本机 iFinD 凭据需要先在面板授权（trustCredentials）')
      }
      // ② 令牌缺失 → capability-gap：模型应记能力缺口并继续其它检查项。
      const credential = await readIfindToken(deps)
      if (credential.error !== '') return failure('capability-gap', credential.error)

      const redact = makeIfindRedactor([credential.token])
      const r = redact.redact
      const transport = deps.ifind ?? defaultIfindTransport()
      const signal = exec.signal
      const url = `${IFIND_SERVICE_BASE}/${IFIND_SERVER_PATHS[serverType]}`
      // 超时可注入（测试用短超时，生产用 60s）；超时与用户取消是**两种**不同的失败。
      const timeoutMs = typeof deps.ifindTimeoutMs === 'number' && deps.ifindTimeoutMs > 0
        ? deps.ifindTimeoutMs
        : IFIND_TIMEOUT_MS
      // 自建 linked controller：**不依赖** `AbortSignal.any`（旧运行时没有它时，
      // 内部超时必须仍能取消正在等待的 transport）。abort 来源显式记录，不靠异常文案猜。
      const linked = new AbortController()
      let abortSource: 'none' | 'external' | 'timeout' = 'none'
      const abortWith = (source: 'external' | 'timeout'): void => {
        if (abortSource === 'none') abortSource = source
        if (!linked.signal.aborted) linked.abort()
      }
      const onExternalAbort = (): void => abortWith('external')
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
      const timer = setTimeout(() => abortWith('timeout'), timeoutMs)
      const timedOut = (): boolean => abortSource === 'timeout'
      const abortSourceOf = (): 'none' | 'external' | 'timeout' => abortSource
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onExternalAbort)
      }
      try {
        const opened = await openIfindSession(transport, url, credential.token, linked.signal, timeoutMs, abortSourceOf)
        if (!opened.ok) {
          return failure(timedOut() ? 'infrastructure' : opened.errorKind,
            timedOut() ? '调用 iFinD 服务超时' : opened.error)
        }
        const session = opened.session
        const protocolVersion = session.protocolVersion

        const listed = await listIfindTools(transport, url, credential.token, session, linked.signal, timeoutMs, abortSourceOf)
        if (!listed.ok) {
          return failure(timedOut() ? 'infrastructure' : listed.errorKind,
            timedOut() ? '调用 iFinD 服务超时' : listed.error)
        }
        // `tools`（内部完整集合）是下面 toolName 校验的依据，不受模型可见清单裁剪影响。
        const tools = listed.tools
        const visible = (source: typeof tools): Array<{ name: string; description: string; hasSchema: boolean }> =>
          source.map((tool) => ({
            name: tool.name.slice(0, 200),
            description: tool.description.slice(0, IFIND_TOOL_DESC_MAX),
            hasSchema: tool.inputSchema !== null && tool.inputSchema !== undefined,
          }))

        if (operation === 'list_tools') {
          const capped = visible(tools.slice(0, IFIND_TOOLS_MAX))
          const truncated = tools.length > capped.length
            || tools.some((tool) => tool.description.length > IFIND_TOOL_DESC_MAX)
          const safe = redact.redact(capped) as Array<{ name: string; description: string; hasSchema: boolean }>
          const total = JSON.stringify(safe).length
          return {
            ok: true, errorKind: '', error: '', operation, serverType, protocolVersion,
            tools: total > TOOL_TEXT_MAX ? safe.slice(0, 1) : safe,
            truncated: truncated || total > TOOL_TEXT_MAX,
          }
        }

        // ③ toolName 必须来自**本次** tools/list 的真实返回，绝不把任意工具名发给服务。
        const hit = tools.find((tool) => tool.name === toolName)
        if (hit === undefined) {
          return failure('input', `toolName 不在 ${serverType} 本次 tools/list 的返回中：${toolName}`)
        }

        if (operation === 'describe_tool') {
          // 参数 schema 也是**模型可见输出**：脱敏 + 限深 + 限长（见 trimIfindSchema）。
          const schema = trimIfindSchema(hit.inputSchema, r)
          return {
            ok: true, errorKind: '', error: '', operation, serverType, protocolVersion,
            toolName: hit.name.slice(0, 200),
            description: hit.description.slice(0, IFIND_TOOL_DESC_MAX),
            inputSchema: schema,
            truncated: JSON.stringify(schema).length >= IFIND_SCHEMA_MAX_CHARS,
          }
        }

        const called = await rpc(transport, url, credential.token, session,
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: params } },
          linked.signal, redact.redact, timeoutMs, abortSourceOf)
        if (!called.ok) return failure(timedOut() ? 'infrastructure' : called.errorKind,
          timedOut() ? '调用 iFinD 服务超时' : called.error)
        if (!Object.prototype.hasOwnProperty.call(called.data, 'result')) {
          return failure('infrastructure', 'iFinD 调用成功但响应缺少 result（协议错误）')
        }
        const payload = called.data.result
        const rendered = JSON.stringify(r(payload) ?? null)
        const truncated = rendered.length > TOOL_TEXT_MAX
        // 超长时只保留明确标注的截断文本；正常时原样把 JSON-RPC result 交给模型。
        const resultValue = (truncated
          ? { truncated: true, truncatedText: clampText(rendered, TOOL_TEXT_MAX) }
          : JSON.parse(rendered)) as JsonValue
        return { ok: true, errorKind: '', error: '', operation, serverType, protocolVersion, result: resultValue, truncated }
      } finally {
        // 完成 / 取消 / 超时三条路径都走到这里：timer 与监听器必须都被清掉（不留悬挂回调）。
        cleanup()
      }
    },
  })
}

/** 与 `capabilities` Tool 共用：模型可见的工具名清单里也要有它。 */
export const IFIND_TOOL_NAME = TOOL_NAMES.ifindQuery

/** 重新导出给测试与文档：协议版本是跨进程契约的一部分。 */
export { IFIND_PROTOCOL_VERSION, IFIND_SERVER_PATHS, IFIND_SERVER_TYPES, IFIND_SERVICE_BASE, validateIfindParams, makeIfindRedactor }

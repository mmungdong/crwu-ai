import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { BUNDLED_BIN_PLATFORMS, bundledBinaryPath, binaryFileName } from '../platform/bin-dir.ts'
import { DWS_ALLOWED_PREFIXES } from '../dws/consts.ts'
import { PLUGIN_VERSION } from '../consts.ts'
import { AUDIT_BINARIES, REQUIRED_AUDIT_TOOLS, TOOL_NAMES } from './consts.ts'
import { renderJson } from './outcome.ts'
import { credentialsTrusted, toolContext, type ToolDeps } from './types.ts'

/**
 * 能力自检 Tool：**零副作用**，只回答「这个部署现在能干什么」。
 *
 * 它是审核根会话 preflight 的落点：根会话建好后真的调用一次，用来证明
 * 「模型能发起工具调用 + 工具确实注册在该 Agent 的可见集里 + policy pipeline 通得过」。
 * 所以它有两条硬约束：
 *
 * 1. **不写任何东西、不改任何状态**：只 `stat` 包内二进制、只读注册表与配置；
 * 2. **不返回二进制绝对路径**（也不返回任何凭据/URL）—— 模型不需要知道路径，
 *    知道路径只会把它引导去拼 shell 命令。这里只回答「在不在、多大、要求什么版本」。
 *
 * 为什么不用 `dws version` 之类去拿真实版本号：那会**有副作用**（实测 `dws version`
 * 会在二进制旁边落一个 `.dws/` 状态目录，`bin/` 又会整包带走），所以版本信息取自
 * 随包发布的运行时清单（`expect`），而不是现场执行。
 */
export function capabilitiesTool(deps: ToolDeps) {
  return defineTool({
    name: TOOL_NAMES.capabilities,
    description: [
      '报告当前部署的 CRWU 自研审核能力：受支持平台、三个自带二进制是否随包可用、业务 Tool 对当前 Agent 是否可见、以及审计链路的策略事实。',
      '零副作用：不写文件、不发网络请求、不执行任何业务 CLI，也不返回二进制路径。',
      '用于审核前的 capability 自检；缺任何一项时应如实报告 gap，不要改去 shell 里搜索命令。',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { required: true, type: 'boolean' },
          errorKind: { required: true, type: 'string' },
          error: { required: true, type: 'string' },
          pluginVersion: { required: true, type: 'string' },
          platform: { required: true, type: 'string' },
          binPlatform: { required: true, type: 'string' },
          supportedPlatforms: { required: true, type: 'array', items: { type: 'string' } },
          binaries: { required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { required: true, type: 'string' },
                available: { required: true, type: 'boolean' },
                sizeBytes: { required: true, type: 'integer' },
                expectedVersion: { required: true, type: 'string' },
              },
              
            },
          },
          tools: { required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { required: true, type: 'string' }, available: { required: true, type: 'boolean' } },
              
            },
          },
          policy: { required: true,
            type: 'object',
            additionalProperties: false,
            properties: {
              credentialsTrusted: { required: true, type: 'boolean' },
              workspaceKnown: { required: true, type: 'boolean' },
              pathSearchForAuditCli: { required: true, type: 'boolean' },
              sandboxEscalation: { required: true, type: 'string' },
            },
            
          },
          dwsCommands: { required: true, type: 'array', items: { type: 'string' } },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec: ToolRunContext) {
      const ctx = toolContext(deps.ctx, exec)
      const platform = await deps.world.platform()
      const binPlatform = (BUNDLED_BIN_PLATFORMS as readonly string[]).includes(platform) ? platform : ''

      // 版本要求来自清单常量（`manifest.packaged`），**不执行二进制去问** ——
      // `dws version` 会在二进制旁边产生 `.dws/` 状态目录，那会被打包自检判成运行残留。
      const expected = new Map<string, string>()
      for (const spec of deps.state.manifest.packaged) expected.set(spec.name, spec.expectedVersion)

      const binaries: Array<{ name: string; available: boolean; sizeBytes: number; expectedVersion: string }> = []
      for (const name of AUDIT_BINARIES) {
        binaries.push({
          name,
          available: await bundledAvailable(ctx, platform, name),
          sizeBytes: await bundledSize(ctx, platform, name),
          expectedVersion: expected.get(name) ?? '',
        })
      }

      const tools = REQUIRED_AUDIT_TOOLS.map((name) => ({ name, available: toolVisible(deps.ctx, exec, name) }))
      const missing = tools.filter((item) => !item.available).map((item) => item.name)
      const missingBinaries = binaries.filter((item) => !item.available).map((item) => item.name)
      const workdir = await deps.world.workdir()

      return {
        ok: missing.length === 0 && missingBinaries.length === 0,
        errorKind: (missing.length === 0 && missingBinaries.length === 0 ? '' : 'capability-gap') as '' | 'capability-gap',
        error: missing.length === 0 && missingBinaries.length === 0
          ? ''
          : [
              missingBinaries.length > 0 ? `包内缺少二进制：${missingBinaries.join('、')}（平台 ${platform}）` : '',
              missing.length > 0 ? `当前 Agent 不可见的 Tool：${missing.join('、')}` : '',
            ].filter((part) => part !== '').join('；'),
        pluginVersion: PLUGIN_VERSION,
        platform,
        binPlatform,
        supportedPlatforms: [...BUNDLED_BIN_PLATFORMS],
        binaries,
        tools,
        policy: {
          credentialsTrusted: credentialsTrusted(deps),
          workspaceKnown: workdir !== '',
          // 自研审核链路**不做** PATH 搜索：这是本次改造的核心约束，写进返回值便于审计。
          pathSearchForAuditCli: false,
          sandboxEscalation: '仅本机凭据命令、且已授权、且 workspaceRoot 已知时申请 danger-full-access；其余走默认沙箱',
        },
        dwsCommands: DWS_ALLOWED_PREFIXES.map((prefix) => prefix.join(' ')),
      }
    },
  })
}

/** 包内二进制是否存在（只 stat，不执行、不返回路径）。 */
async function bundledAvailable(ctx: Context, platform: string, name: string): Promise<boolean> {
  const path = bundledBinaryPath(platform, name)
  if (path === '') return false
  const fs = fileSystem(ctx)
  if (fs === undefined) return false
  try {
    const info = await fs.stat(await resolveTarget(ctx, path))
    return info?.type === 'file'
  } catch (error) {
    void error
    return false
  }
}

async function bundledSize(ctx: Context, platform: string, name: string): Promise<number> {
  const path = bundledBinaryPath(platform, name)
  if (path === '' || binaryFileName(name, platform) === '') return 0
  const fs = fileSystem(ctx)
  if (fs === undefined) return 0
  try {
    const info = await fs.stat(await resolveTarget(ctx, path))
    return typeof info?.size === 'number' && Number.isFinite(info.size) ? info.size : 0
  } catch (error) {
    void error
    return 0
  }
}

/**
 * 该 Tool 对当前调用者是否可见。
 *
 * 用 `ctx.tools.get(name, agent)`：这是 registry 的 resolver，会把 scoped restriction
 * 与 presentation collapse 都算进去 —— **不能**只看「插件注册过没有」。
 * 审核根 preflight 要证的正是「审核 Agent 看得见这些工具」，所以判据必须是它。
 */
export function toolVisible(ctx: Context, exec: ToolRunContext, name: string): boolean {
  const registry = ctx.get('tools') as { get?: (toolName: string, scope?: unknown) => unknown } | undefined
  if (registry === undefined || typeof registry.get !== 'function') return false
  try {
    // scope 就是调用者 Agent 对象本身（DSH 的 scoped 路由 key），不是 `agent.ctx`。
    return registry.get(name, exec.agent) !== undefined
  } catch (error) {
    void error
    return false
  }
}

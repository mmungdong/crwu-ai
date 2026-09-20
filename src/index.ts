/**
 * 中瑞世联工作台 · Host 半（包形态骨架）
 *
 * 与 legacy/host.js（动态插件形态）的关系：
 *   动态形态用注入的 `harness.handle('workbench:x', fn)` 注册 23 个包私有 RPC，
 *   那种 RPC 只存在于 DSH 的动态沙箱里。包形态没有它，改用**同源 HTTP**：
 *   ctx.webServer.register 挂一个端点，客户端半用 fetch 调 —— 这就是
 *   dsh-file-upload-ocr-plugin 的做法（见其 src/index.ts，ROUTE='/api/file-extract'）。
 *   所以 `host.call(m, a)` → `rpc(m, a)`，其余业务逻辑基本可以整段搬。
 *
 * 本文件目前是**可挂载、可跑通链路的骨架**：
 *   - 已完成：配置、路由分发、错误信封、boot / workspace / workspace-auto /
 *     bind-session / trust / clipboard / install-prompt / ping
 *   - 待移植：env / pending / audit-* / oss-* （见 PORTING.md 的逐项清单与行号）
 *   未移植的 op 会明确返回 { ok:false, error:'…尚未移植…' }，不会静默失败。
 */

import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** 同源 RPC 端点。客户端半用同一个常量。 */
export const ROUTE = '/api/crwu-workbench'

/** 部署侧配置（见 cordis.patch.yml）。 */
export interface Config {
  caseRoot: string
  preferWorkspaceTitle: string
  manifestUrl: string
  installDocUrl: string
  formName: string
  ossBucket: string
  ossPrefix: string
  ossEndpoint: string
  ossLinkMode: 'signed' | 'public'
  ossLinkTtlSeconds: number
  autoUpload: boolean
  singleAuditOnly: boolean
  requireTopLevelParent: boolean
}

export const Config: Schema<Config> = Schema.object({
  caseRoot: Schema.string().default(''),
  preferWorkspaceTitle: Schema.string().default('中瑞世联工作空间'),
  manifestUrl: Schema.string().default(''),
  installDocUrl: Schema.string().default(''),
  formName: Schema.string().default('报告审核'),
  ossBucket: Schema.string().default(''),
  ossPrefix: Schema.string().default(''),
  ossEndpoint: Schema.string().default(''),
  ossLinkMode: Schema.union(['signed', 'public']).default('signed'),
  ossLinkTtlSeconds: Schema.natural().min(60).default(3600),
  autoUpload: Schema.boolean().default(true),
  singleAuditOnly: Schema.boolean().default(true),
  requireTopLevelParent: Schema.boolean().default(true),
})

export const name = 'crwu-workbench'

// 与动态半一致的服务名（已用 Service.listService 核对存在）：
//   fs / shell / subagents / agents / sessions / workspaceRegistry / timer / webServer
// 骨架阶段只注入真正用到的；移植对应 op 时把它需要的服务加进来 —— 少注入会让
// Cordis 在服务到位前一直 waiting（mount-validation 会报 "waiting for <service>"），
// 多注入会让行一直不激活。两者都会在 standingKeyFor 检查里现形。
export const inject = ['webServer', 'fs']

type Args = Record<string, unknown>
type Op = (args: Args) => Promise<unknown> | unknown

function text(v: unknown): string { return v === undefined || v === null ? '' : String(v) }
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

/** Host 侧的持久状态。包形态可以放心用进程内存：它随 profile 存活。 */
interface AuditRecord {
  key: string
  childId: string
  seqNo: string
  project: string
  objectId: string
  startedAt: string
  parentSessionId: string
  status: string
  ended: boolean
  stopped: boolean
  stopReason: string
  endReason: string
  casePath: string
  resultFile: string
  htmlFile: string
  caseName: string
  uploadedAt: string
  uploadError: string
  ossPrefix: string
  attempt: number
  childAlive?: boolean
  adopted?: boolean
}

interface State {
  caseRoot: string
  workspacePath: string
  workspaceTitle: string
  workspaceSource: string
  workspaceChosen: boolean
  parentSessionId: string
  trustH3yun: boolean
  audits: Record<string, AuditRecord>
  activeKey: string
  activeChildId: string
  activeSince: number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw new Error('请求体过大 / Request body too large.')
    chunks.push(buf)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 工作台 Host 半。 */
export function apply(ctx: Context, config: Config): void {
  const state: State = {
    caseRoot: config.caseRoot,
    workspacePath: '',
    workspaceTitle: '',
    workspaceSource: '',
    workspaceChosen: false,
    parentSessionId: '',
    trustH3yun: false,
    audits: {},
    activeKey: '',
    activeChildId: '',
    activeSince: 0,
  }

  // ── 会话层级 ────────────────────────────────────────────────────────────
  // 审核只允许挂在**顶层会话**下（子代理深度 1）。判据是只有子代理才有的
  // origin === 'subagent' 与 delegationDepth；顶层会话是 delegationDepth: 0 且无 origin
  // （实测本机顶层会话头：{"delegationDepth":0,...}，子代理：{"origin":"subagent","delegationDepth":1}）。
  // 允许把子代理登记成父级会派生出 depth 2 的审核，于是"只监控一层子会话"失效。
  function sessionDelegation(id: string): { found: boolean; subagent: boolean; depth: number; parentSession: string } {
    const out = { found: false, subagent: false, depth: 0, parentSession: '' }
    if (id === '') return out
    try {
      const sessions = (ctx as unknown as { sessions?: { get(id: string): { header?: Record<string, unknown> } | undefined } }).sessions
      if (sessions === undefined || typeof sessions.get !== 'function') return out
      const session = sessions.get(id)
      const header = session?.header
      if (header === undefined) return out
      out.found = true
      out.subagent = text(header.origin) === 'subagent'
      out.depth = num(header.delegationDepth)
      out.parentSession = text(header.parentSession)
    } catch { /* 拿不到就按"未知"处理，不阻断用户 */ }
    return out
  }

  function workspaceView(): unknown {
    return {
      chosen: state.workspaceChosen,
      path: state.workspacePath,
      title: state.workspaceTitle || state.workspacePath,
      source: state.workspaceSource,
    }
  }

  function notPorted(op: string, legacyLine: number): never {
    throw new Error(
      `工作台 op "${op}" 在包形态里尚未移植（动态形态见 legacy/host.js:${legacyLine}，`
      + '逐项清单见 PORTING.md）。这不是失败，是骨架阶段的预期状态。',
    )
  }

  // ── 已移植的 op ─────────────────────────────────────────────────────────
  const ops: Record<string, Op> = {
    ping: () => ({ ok: true, rev: 'pkg-0.1.0', at: new Date().toISOString() }),

    // legacy/host.js:1518 workbench:boot
    boot: () => ({
      ok: true,
      caseRoot: state.caseRoot,
      home: homedir(),
      formName: config.formName,
      parentSessionId: state.parentSessionId,
      workspace: workspaceView(),
      active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
      ported: {
        done: ['boot', 'workspace', 'workspace-auto', 'bind-session', 'trust', 'clipboard', 'install-prompt', 'ping'],
        todo: ['env', 'pending', 'audit-start', 'audit-stop', 'audit-status', 'audit-release',
          'oss-index', 'oss-link', 'oss-upload', 'open-path', 'relogin', 'dws-login', 'oss-cred-save'],
      },
    }),

    // legacy/host.js:1546 workbench:workspace
    workspace: (args) => {
      const path = text(args.path).replace(/\/+$/, '')
      if (path !== '') {
        state.workspacePath = path
        state.workspaceTitle = text(args.title) || path
        state.workspaceSource = 'manual'
        state.workspaceChosen = true
      }
      return { ok: true, workspace: workspaceView() }
    },

    // legacy/host.js:1562 workbench:workspace-auto
    'workspace-auto': () => {
      state.workspaceChosen = false
      state.workspacePath = ''
      state.workspaceTitle = ''
      state.workspaceSource = ''
      return { ok: true, workspace: workspaceView() }
    },

    // legacy/host.js:1573 workbench:trust
    trust: (args) => {
      state.trustH3yun = args.h3yun === true
      return { ok: true, trust: { h3yun: state.trustH3yun } }
    },

    // legacy/host.js:1579 workbench:bind-session
    'bind-session': (args) => {
      const id = text(args.sessionId)
      if (id === '') return { ok: false, error: '缺少 sessionId' }
      const info = sessionDelegation(id)
      if (config.requireTopLevelParent && info.found && info.subagent) {
        return {
          ok: false,
          subagent: true,
          depth: info.depth,
          parentSessionId: state.parentSessionId,
          error: `这个会话本身是子代理（delegationDepth ${info.depth || 1}），不能当审核父级：`
            + '审核只允许挂在顶层会话下，嵌套会引入一堆状态跟丢的问题。请在顶层会话里打开工作台。',
          workspace: workspaceView(),
        }
      }
      state.parentSessionId = id
      return { ok: true, parentSessionId: id, subagent: false, depth: 0, workspace: workspaceView() }
    },

    // legacy/host.js:1618 workbench:install-prompt
    'install-prompt': (args) => {
      const url = config.installDocUrl
      const ws = text(args.workspace) || state.workspacePath || state.caseRoot
      const lines = [
        '请完成本机 crwu 审核环境的安装。',
        '',
        `**第一步：先完整阅读这份安装清单 —— ${url}**`,
        '',
        '然后**严格按它的步骤逐条执行**。不要凭经验跳步，不要自己发明安装方式。',
        '',
        '几条必须遵守的：',
        '1. **先检查、只装缺的**：已经装好且可用的项直接跳过，不要重装。',
        '2. **GitHub 一律按不可达处理**：需要的东西只能从 GitHub 获得时停下来问我。',
        '3. **密钥、令牌一律不要回显**到对话或日志里。',
        '4. **每一项都要实际验证**（跑版本命令、看真实输出），不要凭推理判断成功。',
      ]
      if (ws !== '') lines.push(`5. 需要临时文件时放在当前工作空间 \`${ws}\` 下，不要写系统目录。`)
      lines.push('', '完成后**逐项回报**：每项的实际状态、绝对路径、验证命令的真实输出，以及跳过或失败的原因。')
      return { ok: true, url, prompt: lines.join('\n') }
    },

    // legacy/host.js:2139 workbench:env —— 待移植（需要 shell 服务跑版本探测 + 拉远程清单）
    env: () => notPorted('env', 2139),
    // legacy/host.js:2276 workbench:pending —— 待移植（需要 shell + crwu h3yun records list）
    pending: () => notPorted('pending', 2276),
    // legacy/host.js:1656 / 1817 / 1839 / 1745 —— 审核生命周期，待移植
    'audit-start': () => notPorted('audit-start', 1656),
    'audit-stop': () => notPorted('audit-stop', 1817),
    'audit-status': () => ({ ok: true, audits: [], parentSessionId: state.parentSessionId, active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince } }),
    'audit-release': () => {
      const released = state.activeKey || state.activeChildId
      state.activeKey = ''
      state.activeChildId = ''
      state.activeSince = 0
      return { ok: true, released }
    },
    // legacy/host.js:2036 / 2068 / 2243 —— OSS 三件套，待移植
    'oss-index': () => notPorted('oss-index', 2036),
    'oss-link': () => notPorted('oss-link', 2068),
    'oss-upload': () => notPorted('oss-upload', 2243),
    'oss-cred-save': () => notPorted('oss-cred-save', 1630),
    'open-path': () => notPorted('open-path', 2109),
    'relogin': () => notPorted('relogin', 2232),
    'dws-login': () => notPorted('dws-login', 2219),
  }

  // ── 同源 RPC 端点 ───────────────────────────────────────────────────────
  // 客户端半：fetch(ROUTE, {method:'POST', body: JSON.stringify({op, args})})
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(req: IncomingMessage, res: ServerResponse) {
      try {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '仅支持 POST' }); return }
        const origin = req.headers.origin
        const host = req.headers.host
        if (origin !== undefined && host !== undefined
          && origin !== `http://${host}` && origin !== `https://${host}`) {
          json(res, 403, { ok: false, error: '不允许跨域' }); return
        }
        const body = await readJsonBody(req, 1 * 1024 * 1024) as { op?: unknown; args?: unknown }
        const op = text(body.op)
        const handler = ops[op]
        if (handler === undefined) { json(res, 404, { ok: false, error: `未知 op：${op}` }); return }
        const args = (body.args !== null && typeof body.args === 'object' ? body.args : {}) as Args
        json(res, 200, await handler(args))
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'crwu-workbench: rpc route')

  ctx.logger?.info?.('中瑞世联工作台 Host 半（包形态骨架）已装配 %o', { route: ROUTE, ops: Object.keys(ops).length })
}

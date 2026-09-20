import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchConfig } from '../config/config.ts'
import { workspaceView } from '../state/store.ts'
import type { WorkbenchState } from '../state/types.ts'
import { finiteNumber, text } from '../../shared/utils/value.ts'
import type { OperationMap } from './types.ts'

interface DelegationView {
  found: boolean
  subagent: boolean
  depth: number
  parentSession: string
}

function sessionDelegation(ctx: Context, id: string): DelegationView {
  const result = { found: false, subagent: false, depth: 0, parentSession: '' }
  if (id === '') return result
  try {
    const sessions = (ctx as unknown as {
      sessions?: { get(sessionId: string): { header?: Record<string, unknown> } | undefined }
    }).sessions
    if (sessions === undefined || typeof sessions.get !== 'function') return result
    const header = sessions.get(id)?.header
    if (header === undefined) return result
    result.found = true
    result.subagent = text(header.origin) === 'subagent'
    result.depth = finiteNumber(header.delegationDepth)
    result.parentSession = text(header.parentSession)
  } catch (error) {
    // 会话服务不可用时保留“未知”状态，不阻断用户继续处理环境问题。
    void error
  }
  return result
}

function notPorted(operation: string, legacyLine: number): never {
  throw new Error(
    `工作台 op "${operation}" 在包形态里尚未移植（动态形态见 legacy/host.js:${legacyLine}，`
      + '逐项清单见 PORTING.md）。这不是失败，是骨架阶段的预期状态。',
  )
}

/** 创建包形态当前已经支持的操作表。 */
export function createCoreOperations(ctx: Context, config: WorkbenchConfig, state: WorkbenchState): OperationMap {
  return {
    ping: () => ({ ok: true, rev: 'pkg-0.1.1', at: new Date().toISOString() }),
    boot: () => ({
      ok: true,
      caseRoot: state.caseRoot,
      home: homedir(),
      formName: config.formName,
      parentSessionId: state.parentSessionId,
      workspace: workspaceView(state),
      active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
      ported: {
        done: ['boot', 'workspace', 'workspace-auto', 'bind-session', 'trust', 'clipboard', 'install-prompt', 'ping'],
        todo: ['env', 'pending', 'audit-start', 'audit-stop', 'audit-status', 'audit-release',
          'oss-index', 'oss-result', 'oss-link', 'oss-upload', 'open-path', 'relogin', 'dws-login', 'oss-cred-save'],
      },
    }),
    workspace: (args) => {
      const path = text(args.path).replace(/\/+$/, '')
      if (path !== '') {
        state.workspacePath = path
        state.workspaceTitle = text(args.title) || path
        state.workspaceSource = 'manual'
        state.workspaceChosen = true
      }
      return { ok: true, workspace: workspaceView(state) }
    },
    'workspace-auto': () => {
      state.workspaceChosen = false
      state.workspacePath = ''
      state.workspaceTitle = ''
      state.workspaceSource = ''
      return { ok: true, workspace: workspaceView(state) }
    },
    trust: (args) => {
      state.trustH3yun = args.h3yun === true
      return { ok: true, trust: { h3yun: state.trustH3yun } }
    },
    'bind-session': (args) => {
      const id = text(args.sessionId)
      if (id === '') return { ok: false, error: '缺少 sessionId' }
      const info = sessionDelegation(ctx, id)
      if (config.requireTopLevelParent && info.found && info.subagent) {
        return {
          ok: false,
          subagent: true,
          depth: info.depth,
          parentSessionId: state.parentSessionId,
          error: `这个会话本身是子代理（delegationDepth ${info.depth || 1}），不能当审核父级：`
            + '审核只允许挂在顶层会话下，嵌套会引入状态跟丢的问题。请在顶层会话里打开工作台。',
          workspace: workspaceView(state),
        }
      }
      state.parentSessionId = id
      return { ok: true, parentSessionId: id, subagent: false, depth: 0, workspace: workspaceView(state) }
    },
    'install-prompt': (args) => {
      const url = config.installDocUrl
      const workspace = text(args.workspace) || state.workspacePath || state.caseRoot
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
      if (workspace !== '') lines.push(`5. 需要临时文件时放在当前工作空间 \`${workspace}\` 下，不要写系统目录。`)
      lines.push('', '完成后**逐项回报**：每项的实际状态、绝对路径、验证命令的真实输出，以及跳过或失败的原因。')
      return { ok: true, url, prompt: lines.join('\n') }
    },
    env: () => notPorted('env', 2241),
    pending: () => notPorted('pending', 2378),
    'audit-start': () => notPorted('audit-start', 1722),
    'audit-stop': () => notPorted('audit-stop', 1891),
    'audit-status': () => ({
      ok: true,
      audits: [],
      parentSessionId: state.parentSessionId,
      active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
    }),
    'audit-release': () => {
      const released = state.activeKey || state.activeChildId
      state.activeKey = ''
      state.activeChildId = ''
      state.activeSince = 0
      return { ok: true, released }
    },
    'oss-index': () => notPorted('oss-index', 2110),
    'oss-result': () => notPorted('oss-result', 2142),
    'oss-link': () => notPorted('oss-link', 2169),
    'oss-upload': () => notPorted('oss-upload', 2345),
    'oss-cred-save': () => notPorted('oss-cred-save', 1696),
    'open-path': () => notPorted('open-path', 2211),
    relogin: () => notPorted('relogin', 2334),
    'dws-login': () => notPorted('dws-login', 2321),
  }
}

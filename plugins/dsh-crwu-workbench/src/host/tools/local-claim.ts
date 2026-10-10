import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { callerIdentity } from '../audit/scope.ts'
import { failure, renderJson } from './outcome.ts'
import { TOOL_NAMES } from './consts.ts'
import type { ToolDeps } from './types.ts'

/**
 * `crwu_audit_local_claim`：本地审核的**一次性交接认领**（协议 28）。
 *
 * ## 为什么必须是 Tool，而不是一段提示词
 *
 * 用户在完全权限下新建一条对话、把提示词粘进去 —— 那条对话与 Workbench 之间**没有**任何
 * 共享的客户端状态。唯一能把「这一轮该审哪批材料」交给它的通道就是这个 Tool：
 * 它提交 `handoffId`，Host 用**注册表**（存在 / 未用 / 未过期 / 快照仍在）判一次，
 * 通过后才把临时案例目录**绑定到调用者会话**。
 *
 * ## 三条不许放宽的口径
 *
 * 1. **身份来自 `exec.agent.id`**，不是参数：模型提交不了"我是哪条会话"。
 * 2. **一条 handoff 只服务一条会话**：同一条会话重复调用是幂等的（自动链路会先认领一次，
 *    模型随后按提示词再调一次），别的会话拿到的是"已用过"。
 * 3. **失败就停**：过期 / 已用 / 快照不在了都回 `policy` / `capability-gap`，并明确要求回到
 *    Workbench 重新准备 —— 绝不退化成"那就自己去本机找文件"。
 */

interface ClaimArgs {
  handoffId?: unknown
}

interface ClaimResult {
  ok: boolean
  errorKind: string
  error: string
  /** 本轮案例目录（Host 的临时快照目录）；失败时空串。 */
  caseDir: string
  mode: string
  fileCount: number
  skippedCount: number
  files: Array<{ name: string; relativePath: string; sizeBytes: number }>
  skipped: Array<{ name: string; relativePath: string; reason: string }>
}

function idle(): ClaimResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', mode: 'local',
    fileCount: 0, skippedCount: 0, files: [], skipped: [],
  }
}

export function localClaimTools(deps: ToolDeps) {
  return [defineTool({
    name: TOOL_NAMES.localAuditClaim,
    description: [
      '认领一次**本地审核**交接：提交 handoffId，取回本轮临时案例目录与材料清单，',
      '并把该案例目录绑定到当前对话。',
      '只由 Workbench「本地审核」生成的提示词调用一次；过期 / 已用 / 快照不存在时如实失败，',
      '不要自己去找用户本机的文件。',
    ].join(' '),
    parameters: {
      handoffId: {
        type: 'string', required: true,
        description: '本地审核提示词里的交接标识（形如 la-<时间戳>-<随机段>）；由 Workbench 生成，不要自己编。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { required: true, type: 'boolean' },
          errorKind: { required: true, type: 'string' },
          error: { required: true, type: 'string' },
          caseDir: { required: true, type: 'string', description: '本轮案例目录（也是本次本地审核的工作目录与可写范围）' },
          mode: { required: true, type: 'string', description: '固定为 local（本地审核）' },
          fileCount: { required: true, type: 'integer' },
          skippedCount: { required: true, type: 'integer' },
          files: {
            required: true, type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { required: true, type: 'string' },
                relativePath: { required: true, type: 'string' },
                sizeBytes: { required: true, type: 'integer' },
              },
            },
          },
          skipped: {
            required: true, type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { required: true, type: 'string' },
                relativePath: { required: true, type: 'string' },
                reason: { required: true, type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args: ClaimArgs, exec): Promise<ClaimResult> {
      const base = idle()
      const registry = deps.localAudit
      const io = deps.localAuditIo
      if (registry === undefined || io === undefined) {
        return { ...base, ...failure('capability-gap', '本地审核注册表没有装配：本插件实例不能认领本地审核交接') }
      }
      const handoffId = text(args.handoffId).trim()
      if (handoffId === '') {
        return { ...base, ...failure('input', '缺少 handoffId：请把 Workbench 提示词里的交接标识原样提交') }
      }
      // 身份只来自 Agent（`agent.id` 就是它自己的 session id），模型提交不了这个字段。
      const { childId } = callerIdentity(exec)
      if (childId === '') {
        return { ...base, ...failure('policy', '无法确认调用者的会话身份：本地审核必须绑定到具体对话') }
      }
      const outcome = await registry.claim(handoffId, childId, io)
      return {
        ...base,
        ok: outcome.ok,
        errorKind: outcome.errorKind,
        error: outcome.error,
        caseDir: outcome.casePath,
        fileCount: outcome.fileCount,
        skippedCount: outcome.skippedCount,
        files: outcome.files.map((file) => ({
          name: file.name,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
        })),
        skipped: outcome.skipped.map((item) => ({
          name: item.name,
          relativePath: item.relativePath,
          reason: item.reason,
        })),
      }
    },
  })]
}

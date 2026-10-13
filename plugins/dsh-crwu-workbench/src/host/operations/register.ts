import { homedir } from 'node:os'
import { HOST_BUILD_KIND, HOST_BUILD_STAMP } from '../build-info.ts'
import { PLUGIN_REV, PLUGIN_VERSION } from '../consts.ts'
import type { Context } from '@deepseek-ai/cordis'
import { WORKBENCH_PROTOCOL } from '../../shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../shared/access/types.ts'
import { workspaceView } from '../core/state/store.ts'
import { ensureRegistry } from '../core/state/registry.ts'
import { syncLocalAccessConsent } from '../core/access/consent.ts'
import { adoptWorkspace } from '../core/workspace/ops.ts'
import { auditRootView } from '../domains/report-audit/root.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import type { WorkbenchState } from '../core/state/types.ts'
import type { WorldFacts } from '../core/platform/world.ts'
import { createOperationHost } from './common.ts'
import { environmentOperations } from './environment.ts'
import { reportAuditOperations } from './report-audit.ts'
import { localAuditOperations } from './local-audit.ts'
import type { CoreDeps, HostResolvers } from './types-export.ts'
import type { OperationMap } from './types.ts'

/**
 * **操作表的组装**（协议 32 · Task 3）。
 *
 * 本文件只做三件事：构造共享依赖（`createOperationHost`）、把四个域的操作表拼起来、
 * 回答 `boot` 里的「这个宿主实现了哪些操作」。
 *
 * ## 为什么 `boot` 留在这里
 *
 * `ported.done` 是"声明必须跟着实现走"的那份声明 —— 它按**真实注入的操作表**推导
 * （`Object.keys(updateOperations)` 这类），而不是各域自己报一份。放在组装处才不会
 * 出现"某个域加了操作、声明忘了加"的漂移（`clipboard` 那次就是这么踩的：
 * 声明里有它、操作表里没有，客户端点「复制提示词」拿到 404）。
 *
 * ⚠️ 域文件里**只放 handler**：它们看不到别的域，也拿不到"全部操作"这份视角。
 */
export function createCoreOperations(
  ctx: Context,
  config: WorkbenchConfig,
  state: WorkbenchState,
  world: WorldFacts,
  resolvers: HostResolvers,
  extra: CoreDeps = {},
): OperationMap {
  const host = createOperationHost(ctx, config, state, world, resolvers, extra)
  const updateOperations = extra.update ?? {}
  const valuationOperations = extra.valuation ?? {}

  return {
    ...environmentOperations(host),
    ...reportAuditOperations(host),
    ...localAuditOperations(host),
    // Task 4：自助更新四个操作（检查 / 手动检查 / 安装 / 取消）。由 update/ops.ts 组装，
    // 这里只并表；没有注入时就不登记（声明必须跟着实现走）。
    ...updateOperations,
    ...valuationOperations,
    boot: async () => {
      // legacy 的 boot 是面板挂载后第一个被调用的操作，它顺手恢复了注册表并采用工作空间；
      // 不补这一步，第一次响应里的 workspace 永远是「未选定」，界面会先闪一下空状态。
      const home = await world.home()
      await ensureRegistry({ ctx, home, state, access: resolvers.access })
      await adoptWorkspace({ ctx, config, state, world, access: resolvers.access })
      // 授权收据：`boot` 是面板挂载后第一个被调用的操作，界面靠它决定「先显示授权卡」
      // 还是「正常进环境页」。在这里读一次，就把「第一次打开」的判据固定在最前面。
      const localAccess = await syncLocalAccessConsent({ ctx, home, state, access: resolvers.access })
      return {
      ok: true,
      protocol: WORKBENCH_PROTOCOL,
      // 权限说明版本：客户端启动时与自己的 schema 比对，不一致就停在本机操作之前。
      permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
      localAccess,
      // 面板标题旁要显示「现在跑的是哪一版」：客户端刷一下就换新，宿主只有重启才换，
      // 把 rev 与构建时间一起给它，用户报问题时能直接对上号（见 AGENTS.md §7.2）。
      // `version` / `buildKind` 供侧栏入口那枚小标签用：dev（源码检出）还是装好的包 + 具体版本。
      rev: PLUGIN_REV,
      version: PLUGIN_VERSION,
      buildKind: HOST_BUILD_KIND,
      builtAt: HOST_BUILD_STAMP,
      caseRoot: state.caseRoot,
      home: homedir(),
      formName: config.formName,
      parentSessionId: state.parentSessionId,
      workspace: workspaceView(state),
      auditRoot: await auditRootView(ctx, state),
      active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
      ported: {
        // 只列包形态真的实现了的操作。曾经把 clipboard 列进 done，但操作表里没有它，
        // 于是客户端点「复制提示词」时拿到 404 —— 声明必须跟着实现走。
        done: ['ping', 'boot', 'workspace', 'workspace-auto', 'bind-session', 'trust',
          'local-access-grant', 'local-access-revoke', 'access-diagnostics',

          // 第 2 层：氚云表单定位 + 待审核列表 + 受白名单约束的 crwu 直通。
          'pending', 'crwu',
          // 第 1 层收尾：环境自检聚合（清单 / 二进制 / 氚云 / 钉钉 / OSS / iFinD / 工作空间）。
          'env',
          // 第 3 层：审核生命周期（顶层会话门禁 / 单条并发 / 带时间戳重启 / 状态跟不丢）。
          'audit-start', 'audit-stop', 'audit-status', 'audit-release',
          // 第 4 层：OSS 交付件（列举 / 按精确 key 读摘要 / 签名链接 / 重传 / 凭据保存）。
          'oss-index', 'oss-result', 'oss-link', 'oss-upload', 'oss-cred-save',
          // 第 4 层补：一份报告的全部相关文件（只列举、不下载）。
          'report-files',
          // 协议 23：报告讨论会话的受限材料登记（新建 / 恢复会话后各登记一次）。
          'discussion-material-open',
          // 协议 28：本地审核（扫描 / 建快照与 handoff / 认领）。
          'local-audit-status', 'local-audit-start', 'local-audit-claim',
          // 第 6 层：iFinD 凭据生命周期（插件 Host 自己保管 SK；不再是「读技能目录里的文件」）。
          'ifind-status', 'ifind-credential-save', 'ifind-credential-clear', 'ifind-probe',
          // 第 5 层：零碎但用户每天会点的那些。
          'open-path', 'clipboard', 'relogin', 'dws-login', 'session', 'oss-cred',
          // 协议 18 · 子项目 D：DWS 本机目录的只读体检与最小权限修复。
          'dws-local-doctor', 'dws-local-permission-repair',
          // 协议 16：自助更新四个操作（安装目标由 Host 自己授权，调用方只能传空参数）。
          ...Object.keys(updateOperations),
          // 协议 32：报告评估（房地产估值）。输入准备 / 预检 / 启动 / 状态 / 取消 / 结果 / 打开交付件。
          ...Object.keys(valuationOperations)],
        // 24 个 legacy RPC 已全部搬完；这里保留空数组，是为了让「声明跟着实现走」的测试继续成立。
        todo: [],
      },
      }
    }
  }
}
